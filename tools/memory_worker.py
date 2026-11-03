"""Offline memory index. NDJSON stdio only; no HTTP listener or network client."""
import sys, os, json, re, time, hashlib, sqlite3
from pathlib import Path
os.environ['TOKENIZERS_PARALLELISM'] = 'false'
def deny_network(event,args):
    if event=='socket.connect':raise RuntimeError('OFFLINE_WORKER_NETWORK_BLOCKED')
sys.addaudithook(deny_network)
import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

def tokens(text):
    zh = re.findall(r'[\u4e00-\u9fff]+', text.lower())
    return ' '.join(re.findall(r'[a-z0-9_-]+',text.lower()) + [s[i:i+n] for s in zh for n in (1,2) for i in range(len(s)-n+1)])

class Index:
    def __init__(self, model, database, reranker=''):
        self.model = Path(model)
        manifest = json.loads((self.model/'manifest.json').read_text('utf-8'))
        for row in manifest['files']:
            if hashlib.sha256((self.model/row['file']).read_bytes()).hexdigest() != row['sha256']:
                raise ValueError('MODEL_HASH_MISMATCH')
        self.identity = hashlib.sha256((self.model/'manifest.json').read_bytes()).hexdigest()
        opts = ort.SessionOptions(); opts.intra_op_num_threads=2; opts.inter_op_num_threads=1
        self.session = ort.InferenceSession(str(self.model/'model.onnx'),sess_options=opts,providers=['CPUExecutionProvider'])
        self.tokenizer = Tokenizer.from_file(str(self.model/'tokenizer.json'))
        self.tokenizer.enable_truncation(max_length=384); self.tokenizer.enable_padding()
        Path(database).parent.mkdir(parents=True, exist_ok=True)
        self.db=sqlite3.connect(database, timeout=15)
        self.db.execute('PRAGMA journal_mode=WAL'); self.db.execute('PRAGMA busy_timeout=15000')
        self.db.execute('CREATE TABLE IF NOT EXISTS units(id TEXT PRIMARY KEY,digest TEXT,body TEXT,vector BLOB)')
        self.db.execute('CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT)')
        self.db.execute('CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(id UNINDEXED,terms)')
        old=self.db.execute("SELECT value FROM meta WHERE key='model'").fetchone()
        if old and old[0]!=self.identity:
            with self.db:
                self.db.execute('DELETE FROM units'); self.db.execute('DELETE FROM search'); self.db.execute('DELETE FROM meta')
        self.db.execute("INSERT OR REPLACE INTO meta VALUES('model',?)",(self.identity,));self.db.commit()
        self.calls=0
        self.reranker_path=Path(reranker) if reranker else None
        self.reranker=None;self.rerank_tokenizer=None;self.query_cache={}

    def rerank(self, query, results):
        if not self.reranker_path or not results:return results
        if self.reranker is None:
            manifest=json.loads((self.reranker_path/'manifest.json').read_text('utf-8'))
            for row in manifest['files']:
                if hashlib.sha256((self.reranker_path/row['file']).read_bytes()).hexdigest()!=row['sha256']:raise ValueError('RERANKER_HASH_MISMATCH')
            opts=ort.SessionOptions();opts.intra_op_num_threads=2;opts.inter_op_num_threads=1
            self.reranker=ort.InferenceSession(str(self.reranker_path/'model.onnx'),sess_options=opts,providers=['CPUExecutionProvider'])
            self.rerank_tokenizer=Tokenizer.from_file(str(self.reranker_path/'tokenizer.json'))
            self.rerank_tokenizer.enable_truncation(max_length=384)
            self.rerank_tokenizer.enable_padding(pad_id=1,pad_token='<pad>')
        candidates=results[:20]
        for offset in range(0,len(candidates),4):
            batch=candidates[offset:offset+4]
            encoded=self.rerank_tokenizer.encode_batch([(query,x['text']) for x in batch])
            feed={'input_ids':np.array([x.ids for x in encoded],dtype=np.int64),'attention_mask':np.array([x.attention_mask for x in encoded],dtype=np.int64)}
            logits=self.reranker.run(None,feed)[0].reshape(-1)
            for row,logit in zip(batch,logits):
                row['rerankScore']=round(float(logit),5);row['match']+=' + 本地交叉编码重排'
        cutoff=max(-4,max(x['rerankScore'] for x in candidates)-2.2)
        return sorted([x for x in candidates if x['rerankScore']>=cutoff or query.lower() in x['text'].lower()],key=lambda x:(-x['rerankScore'],-x['score']))

    def embed(self, texts, query=False):
        # Chunk before tokenizer truncation: every character belongs to at least one short passage.
        chunks=[]; owners=[]
        for i,text in enumerate(texts):
            for start in range(0,max(1,len(text)),180):
                chunks.append(('为这个句子生成表示以用于检索相关文章：' if query else '')+text[start:start+240]);owners.append(i)
        vectors=[]
        for offset in range(0,len(chunks),8):
            batch=self.tokenizer.encode_batch(chunks[offset:offset+8])
            feed={'input_ids':np.array([x.ids for x in batch],dtype=np.int64),'attention_mask':np.array([x.attention_mask for x in batch],dtype=np.int64),'token_type_ids':np.array([x.type_ids for x in batch],dtype=np.int64)}
            feed={x.name:feed[x.name] for x in self.session.get_inputs()}
            output=self.session.run(None,feed)[0]
            cls=output[:,0,:] if output.ndim==3 else output
            cls=cls/np.maximum(np.linalg.norm(cls,axis=1,keepdims=True),1e-12)
            vectors.extend(cls);self.calls+=1
        result=[]
        for i in range(len(texts)):
            v=np.mean([v for v,o in zip(vectors,owners) if o==i],axis=0).astype(np.float32)
            result.append(v/max(float(np.linalg.norm(v)),1e-12))
        return result

    def sync(self, request):
        revision=str(request['revision']); units=request['units']
        current=self.db.execute("SELECT value FROM meta WHERE key='revision'").fetchone()
        if current and current[0]==revision:return {**self.status(),'changed':0}
        if len(units)>3000:raise ValueError('INDEX_LIMIT_3000')
        old=dict(self.db.execute('SELECT id,digest FROM units'))
        changed=[]
        for unit in units:
            body=json.dumps(unit,ensure_ascii=False,sort_keys=True);digest=hashlib.sha256(body.encode()).hexdigest()
            if old.get(unit['id'])!=digest:changed.append((unit,body,digest))
        # Inference before transaction: failed indexing never commits a partial revision.
        vecs=self.embed([x[0]['text'] for x in changed]) if changed else []
        live={u['id'] for u in units}
        with self.db:
            for id in old.keys()-live:
                self.db.execute('DELETE FROM units WHERE id=?',(id,));self.db.execute('DELETE FROM search WHERE id=?',(id,))
            for (unit,body,digest),vector in zip(changed,vecs):
                self.db.execute('INSERT OR REPLACE INTO units VALUES(?,?,?,?)',(unit['id'],digest,body,vector.tobytes()))
                self.db.execute('DELETE FROM search WHERE id=?',(unit['id'],))
                self.db.execute('INSERT INTO search VALUES(?,?)',(unit['id'],tokens(unit['text'])))
            self.db.execute("INSERT OR REPLACE INTO meta VALUES('revision',?)",(revision,))
        self.query_cache.clear()
        return {**self.status(),'changed':len(changed),'removed':len(old.keys()-live)}

    def status(self):
        revision=self.db.execute("SELECT value FROM meta WHERE key='revision'").fetchone()
        return dict(ready=True,model='bge-small-zh-v1.5 / ONNX int8',modelHash=self.identity,dimensions=512,provider='CPUExecutionProvider',rerankerConfigured=bool(self.reranker_path),rerankerLoaded=self.reranker is not None,gpu=False,cloud=False,units=self.db.execute('SELECT count(*) FROM units').fetchone()[0],revision=revision[0] if revision else None,inferenceBatches=self.calls,pid=os.getpid())

    def query(self, request):
        start=time.perf_counter();query=str(request.get('query','')).strip()[:300]
        if not query:return {'results':[],'elapsedMs':0}
        cache_key=json.dumps({k:v for k,v in request.items() if k!='id'},sort_keys=True,ensure_ascii=False)
        if cache_key in self.query_cache:return {**self.query_cache[cache_key],'cached':True,'elapsedMs':round((time.perf_counter()-start)*1000,2)}
        scope=request.get('scope','owner')
        if scope not in ('owner','stranger','all'):raise ValueError('UNKNOWN_SCOPE')
        allowed=set(request['allowedIds']) # Supplied afresh by source scanner: deleted/stale entries cannot leak.
        rows=[(id,json.loads(body),np.frombuffer(vector,dtype=np.float32)) for id,body,vector in self.db.execute('SELECT id,body,vector FROM units') if id in allowed]
        rows=[r for r in rows if scope=='all' or r[1]['scope']==scope]
        if not rows:return {'results':[],'elapsedMs':round((time.perf_counter()-start)*1000,2)}
        q=self.embed([query],True)[0]
        semantic={id:float(v@q) for id,body,v in rows}
        terms=list(dict.fromkeys(tokens(query).split()))[:80]
        expression=' OR '.join('"'+x.replace('"','""')+'"' for x in terms)
        lexical={id:-score for id,score in self.db.execute('SELECT id,bm25(search) FROM search WHERE search MATCH ? ORDER BY bm25(search) LIMIT 3000',(expression,)) if id in allowed} if expression else {}
        sr={id:i+1 for i,(id,_) in enumerate(sorted(semantic.items(),key=lambda x:-x[1]))}
        lr={id:i+1 for i,(id,_) in enumerate(sorted(lexical.items(),key=lambda x:-x[1]))}
        results=[]
        for id,body,_ in rows:
            cosine=semantic[id]; exact=query.lower() in body['text'].lower()
            if not exact and cosine<float(request.get('minSimilarity',.42)):continue
            # Bounded candidate reranking: weighted reciprocal rank fusion, not a cross-encoder.
            score=.65/(20+sr[id])+.35/(20+lr[id]) if id in lr else .65/(20+sr[id])
            results.append({**body,'score':score+(.05 if exact else 0),'vectorScore':round(cosine,5),'bm25Score':lexical.get(id,0),'match':'原文精确匹配 + 混合排序' if exact else '中文语义向量 + BM25 / RRF'})
        results.sort(key=lambda x:(-x['score'],x['id']))
        results=self.rerank(query,results)
        limit=max(1,min(20,int(request.get('limit',8))));budget=max(300,min(12000,int(request.get('budget',5000))))
        out=[];used=0;seen=set()
        for row in results[:60]:
            digest=hashlib.sha256(row['text'].encode()).hexdigest()
            if digest in seen or used+len(row['text'])>budget:continue
            out.append(row);seen.add(digest);used+=len(row['text'])
            if len(out)>=limit:break
        answer={'results':out,'elapsedMs':round((time.perf_counter()-start)*1000,2),'contextChars':used,'candidates':min(60,len(results)),'reranked':bool(self.reranker_path),'cached':False}
        if len(self.query_cache)>=32:self.query_cache.pop(next(iter(self.query_cache)))
        self.query_cache[cache_key]=answer
        return answer

def main():
    index=Index(sys.argv[1],sys.argv[2],sys.argv[3] if len(sys.argv)>3 else '')
    for line in sys.stdin:
        request={}
        try:
            request=json.loads(line);op=request['op']
            if op=='sync':result=index.sync(request)
            elif op=='query':result=index.query(request)
            elif op=='status':result=index.status()
            else:raise ValueError('UNKNOWN_OPERATION')
            print(json.dumps({'id':request['id'],'ok':True,'result':result},ensure_ascii=False),flush=True)
        except Exception as error:
            print(json.dumps({'id':request.get('id'),'ok':False,'error':str(error)},ensure_ascii=False),flush=True)
if __name__=='__main__':main()
