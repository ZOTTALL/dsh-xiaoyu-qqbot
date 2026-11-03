import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createMemoryStore } from '../lib/memory.mjs'

test('memory: unfilled template paragraphs are not treated as remembered facts',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qqbot-empty-template-'));const dir=path.join(root,'workspace','memory');fs.mkdirSync(dir,{recursive:true})
  fs.writeFileSync(path.join(dir,'soul.md'),'# 人格档案\n\n> 这是空白占位文件。请填写自己的信息。\n\n- {{待用户填写}}\n')
  const store=createMemoryStore({root});assert.equal(store.items().length,0);store.dispose();fs.rmSync(root,{recursive:true,force:true})
})

function fixture(t, options={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qqbot-memory-'))
  const mem=path.join(root,'workspace','memory');fs.mkdirSync(path.join(mem,'journal'),{recursive:true});fs.mkdirSync(path.join(mem,'stranger-chat'))
  fs.writeFileSync(path.join(mem,'facts.md'),'# 事实\n\n主人喜欢示例主食，机器人会用 Python 整理实验。\n\nAstrBot 与 NapCat 接入 QQ，DSH 可以调用语音。\n')
  fs.writeFileSync(path.join(mem,'journal','2026-10-23.md'),'# 日记\n\n主人和机器人调试了语音，参考音色是示例音色。\n')
  fs.writeFileSync(path.join(mem,'stranger-chat','2026-10-24.md'),'# 陌生人\n\n陌生人说：独立秘密标记 ALIEN_ONLY。\n')
  let clock=Date.parse('2026-10-29T03:00:00Z');const store=createMemoryStore({root,clock:()=>clock,...options})
  t.after(()=>{store.dispose();fs.rmSync(root,{recursive:true,force:true})})
  return{root,mem,store,advance:()=>{clock+=4000}}
}

test('memory: graph reflects actual sources, deterministic IDs and explicit semantics',t=>{
  const{store}=fixture(t);const a=store.graph(),b=store.graph()
  assert.deepEqual(a,b);assert.equal(a.semantic,false);assert.equal(a.engine,'local-evidence');assert.equal(a.stats.memories,3);assert.equal(a.stats.files,2)
  assert.ok(a.nodes.some(n=>n.label==='机器人'));assert.ok(a.edges.length);assert.ok(a.edges.every(e=>e.type==='cooccurrence'))
})
test('memory: source date is parsed and undated facts do not get fabricated event dates',t=>{
  const{store}=fixture(t);const rows=store.items();assert.equal(rows.find(r=>r.source.startsWith('journal')).day,'2026-10-23');assert.equal(rows.find(r=>r.source==='facts.md').time,null)
})
test('memory: owner default excludes strangers, including detail and recall',t=>{
  const{store}=fixture(t);assert.equal(store.recall('ALIEN_ONLY').results.length,0)
  const alien=store.items({scope:'stranger'})[0];assert.throws(()=>store.detail(alien.id),/范围/);assert.equal(store.items({scope:'all'}).length,4);assert.throws(()=>store.graph({scope:'arbitrary'}),/范围/)
})
test('memory: query, category, date, min weight, focus and memory graph work',t=>{
  const{store}=fixture(t);assert.equal(store.items({from:'2026-10-23',to:'2026-10-23'}).length,1)
  assert.equal(store.items({category:'fact'}).length,2);assert.ok(store.graph({q:'语音'}).nodes.length)
  assert.equal(store.graph({q:'不存在的标记'}).nodes.length,0)
  assert.ok(store.graph({view:'memories'}).nodes.some(n=>n.type==='memory'))
  const id=store.graph().nodes.find(n=>n.label==='机器人').id;const focused=store.graph({focus:id});assert.ok(focused.nodes.every(n=>n.id===id||focused.edges.some(e=>e.source===n.id||e.target===n.id)))
  assert.throws(()=>store.graph({view:'invented'}),/视图/);assert.throws(()=>store.items({from:'bad'}),/日期/);assert.throws(()=>store.items({from:'2026-10-29',to:'2026-10-20'}),/晚于/)
})
test('memory: file updates and removals update revision; stable paragraphs retain IDs',t=>{
  const{store,mem,advance}=fixture(t);const first=store.items().find(x=>x.text.includes('喜欢示例主食'));const revision=store.status().revision
  fs.appendFileSync(path.join(mem,'facts.md'),'\n新增：机器人想吃零食。\n');advance();assert.notEqual(store.status().revision,revision);assert.equal(store.items().find(x=>x.text.includes('喜欢示例主食')).id,first.id)
  fs.unlinkSync(path.join(mem,'journal','2026-10-23.md'));advance();assert.equal(store.items().some(x=>x.source.startsWith('journal')),false)
})
test('memory: evidence details and recall explain matches without generating an answer',t=>{
  const{store}=fixture(t);const result=store.recall('语音 示例音色');assert.ok(result.results.length);assert.ok(result.results[0].match.startsWith('命中词'))
  const row=store.detail(result.results[0].id);assert.equal(row.kind,'memory');assert.ok(row.item.text.includes('示例音色'));assert.ok(row.item.line>0);assert.equal(store.recall('').results.length,0)
})
test('memory: retain writes a new source without editing original files',t=>{
  const{store,mem}=fixture(t);const original=fs.readFileSync(path.join(mem,'facts.md'));const a=store.retain({text:'主人希望实验图表附上说明。'})
  assert.equal(a.ok,true);assert.match(a.source,/^notes\//);assert.equal(fs.readFileSync(path.join(mem,'facts.md')).compare(original),0);assert.ok(store.recall('实验图表').results.length)
  assert.throws(()=>store.retain({text:''}));assert.throws(()=>store.retain({text:'x'.repeat(6001)}));assert.throws(()=>store.retain({text:'api_key=abcdefghijklmnop'}),/密钥/)
})
test('memory: secret patterns redacted, symlinks and unrelated files excluded',t=>{
  const{store,mem}=fixture(t);fs.writeFileSync(path.join(mem,'test.md'),'# test\n\napi_key=abcdefghijklmnop 和 sk-abcdefghijklmnopqrstuv\n');fs.writeFileSync(path.join(mem,'private.json'),'unindexed')
  store.scan(true);assert.ok(!JSON.stringify(store.graph({view:'memories'})).includes('abcdefghijklmnop'));assert.ok(!JSON.stringify(store.items()).includes('abcdefghijklmnop'))
  assert.equal(store.items().some(x=>x.source.endsWith('.json')),false)
})
test('memory: event subscription refreshes, replays cursor and cleans up',t=>{
  const{store}=fixture(t);const seen=[];const off=store.subscribe(e=>seen.push(e));assert.equal(seen[0].type,'snapshot');store.retain({text:'机器人记得做过的实验。'});assert.ok(seen.some(e=>e.type==='memory.retained'))
  const replay=[];const off2=store.subscribe(e=>replay.push(e),seen.at(-1).cursor-1);assert.equal(replay.at(-1).type,'memory.retained');off();off2();assert.equal(store.status().subscribers,0)
})
test('memory: local mode never calls cloud or model APIs',async t=>{
  let calls=0;const{store}=fixture(t,{fetcher:()=>{calls++;throw new Error('unexpected network')}})
  store.graph();store.recall('机器人');assert.equal((await store.engine()).configured,false);assert.equal(calls,0)
})
test('memory: self-host settings reject external hosts, credentials and path tricks',t=>{
  const{store}=fixture(t);for(const url of ['https://api.hindsight.vectorize.io','http://localhost.evil.test','http://127.0.0.1:8888/path','http://user:pass@localhost:8888','file:///etc/passwd'])assert.throws(()=>store.configure({url,bank:'qqbot-owner'}))
  assert.throws(()=>store.configure({url:'http://localhost:8888',bank:'../../x'}));assert.equal(store.configure({url:'http://127.0.0.1:8888',bank:'qqbot-owner'}).ok,true)
})
test('memory: self-host adapter uses configured bank and normalizes graph safely',async t=>{
  const calls=[];const{store}=fixture(t,{fetcher:async(url,options)=>{calls.push({url,options});return{ok:true,json:async()=>url.endsWith('/health')?{status:'ok'}:{nodes:[{data:{id:'a',label:'Alice',mentionCount:3}},{data:{id:'b',label:'Project'}}],edges:[{data:{id:'ab',source:'a',target:'b',weight:2,linkType:'cooccurrence'}},{data:{source:'a',target:'missing'}}],total_entities:2}}}})
  store.configure({url:'http://localhost:8888',bank:'qqbot-test'});assert.equal((await store.engine()).connected,true);const graph=await store.hindsightGraph('entities');assert.equal(graph.engine,'hindsight-self-hosted');assert.equal(graph.nodes.length,2);assert.equal(graph.edges.length,1);assert.ok(calls[1].url.includes('/banks/qqbot-test/entities/graph'));assert.equal(calls[1].options.redirect,'error')
})
test('memory: self-host failure is visible, never silently branded as Hindsight',async t=>{
  const{store}=fixture(t,{fetcher:async()=>{throw new Error('offline')}});store.configure({url:'http://localhost:8888',bank:'qqbot-test'});const engine=await store.engine();assert.equal(engine.connected,false);assert.match(engine.error,/offline/);assert.equal(store.graph().engine,'local-evidence')
})
