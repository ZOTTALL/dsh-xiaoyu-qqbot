import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline'

export function createSemanticIndex({ root, workspace=path.join(root,'workspace'), config, requestTimeout=180000 }={}) {
  const cfgFile=path.join(workspace,'data','memory-local.runtime.json')
  let child=null,seq=0,closed=false,background=null,job=null,last={ready:false,state:'not-started'},pending=new Map(),chain=Promise.resolve()
  function configuration(){return config||JSON.parse(fs.readFileSync(cfgFile,'utf8'))}
  function fail(error){last={...last,ready:false,state:'error',error:error.message};for(const p of pending.values()){clearTimeout(p.timer);p.reject(error)}pending.clear()}
  function refs(active){if(!child)return;for(const h of [child,child.stdin,child.stdout,child.stderr])h[active?'ref':'unref']?.()}
  function boot(){
    if(closed)throw new Error('记忆索引已关闭')
    if(child)return
    const cfg=configuration()
    for(const p of [cfg.python,cfg.model])if(!path.isAbsolute(p)||!fs.existsSync(p))throw new Error('本地记忆运行时路径无效')
    child=spawn(cfg.python,['-u',fileURLToPath(new URL('../tools/memory_worker.py',import.meta.url)),cfg.model,path.join(workspace,'data','memory-local','index.sqlite3'),cfg.reranker||''],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONUTF8:'1',HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1'}})
    const current=child;let errors=''
    current.stdin.on('error',fail)
    current.stderr.on('data',b=>{errors=(errors+b).slice(-1200)})
    readline.createInterface({input:current.stdout}).on('line',line=>{try{const msg=JSON.parse(line),p=pending.get(msg.id);if(!p)return;clearTimeout(p.timer);pending.delete(msg.id);if(msg.ok)p.resolve(msg.result);else p.reject(new Error(msg.error));if(!pending.size)refs(false)}catch{fail(new Error('索引进程返回无效数据'))}})
    current.on('error',fail)
    current.on('exit',code=>{if(child===current)child=null;fail(new Error('本地索引进程退出 '+code+' '+errors))})
  }
  function request(op,body={}){return new Promise((resolve,reject)=>{try{boot();refs(true);const id=++seq;const timer=setTimeout(()=>{pending.delete(id);const error=new Error('本地索引超时');reject(error);child?.kill()},requestTimeout);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,op,...body})+'\n',error=>{if(error){clearTimeout(timer);pending.delete(id);reject(error)}})}catch(e){reject(e)}})}
  function serial(fn){const run=chain.then(fn);chain=run.catch(()=>{});return run}
  async function synchronize(snapshot){const result=await request('sync',{revision:snapshot.revision,units:snapshot.units});last={...result,state:'ready',updatedAt:new Date().toISOString()};return last}
  function sync(snapshot){return serial(()=>synchronize(snapshot))}
  function recall(query,options,snapshot,allowed){return serial(async()=>{await synchronize(snapshot);const result=await request('query',{query,...options,allowedIds:allowed.map(x=>x.id)});last={...last,...await request('status')};return {engine:'local-hybrid',semantic:true,query,...result,note:'本机 BGE 中文向量 + SQLite FTS5/BM25、RRF 融合'+(result.reranked?' + CPU 交叉编码重排':'')+'；返回原文证据，不生成回答。'}})}
  function schedule(scan,onChange){
    if(background||closed)return
    async function tick(){if(closed||job)return;job=sync(scan(true));try{await job;onChange?.(last)}catch(e){last={ready:false,state:'error',error:e.message}}finally{job=null}}
    tick();background=setInterval(tick,15000);background.unref?.()
  }
  function status(){let configured=false;try{configured=!!configuration().python}catch{}return {...last,configured,queueDepth:pending.size+(job?1:0)}}
  function dispose(){
    closed=true;if(background)clearInterval(background);background=null
    fail(new Error('索引已关闭'));const c=child;refs(true)
    if(!c)return Promise.resolve()
    return new Promise(resolve=>{
      const timeout=setTimeout(()=>{if(process.platform==='win32')spawn('taskkill',['/pid',String(c.pid),'/t','/f'],{windowsHide:true,stdio:'ignore'});else c.kill()},5000)
      c.once('close',()=>{clearTimeout(timeout);if(child===c)child=null;resolve()})
      c.stdin.end() // Graceful EOF lets the Python venv redirector AND SQLite-owning child exit.
    })
  }
  return {sync,recall,schedule,status,dispose}
}
