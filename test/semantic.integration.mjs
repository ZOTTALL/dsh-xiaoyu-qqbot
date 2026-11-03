// Real ONNX model, real SQLite, real subprocess; intentionally separate from fast unit tests.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import { createMemoryStore } from '../lib/memory.mjs'
const config={python:process.env.QQBOT_MEMORY_PYTHON,model:process.env.QQBOT_MEMORY_MODEL,reranker:process.env.QQBOT_MEMORY_RERANKER}
const available=!!(config.python&&config.model&&config.reranker)
test('offline worker blocks even attempted socket connections',{skip:!available},()=>{
  const dir=fileURLToPath(new URL('../tools',import.meta.url))
  const script=`import sys,socket\nsys.path.insert(0,${JSON.stringify(dir)})\nimport memory_worker\ntry:\n socket.socket().connect(('127.0.0.1',1))\n raise AssertionError('network guard missing')\nexcept RuntimeError as e:\n assert str(e)=='OFFLINE_WORKER_NETWORK_BLOCKED'\n print('NETWORK_GUARD=PASS')\n`
  assert.equal(execFileSync(config.python,['-c',script],{encoding:'utf8',windowsHide:true,env:{...process.env,PYTHONUTF8:'1'}}).trim(),'NETWORK_GUARD=PASS')
})

test('real local semantic backend',{skip:!available},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qqbot-semantic-')),mem=path.join(root,'workspace','memory')
  fs.mkdirSync(path.join(mem,'journal'),{recursive:true});fs.mkdirSync(path.join(mem,'stranger-chat'))
  fs.writeFileSync(path.join(mem,'facts.md'),'# 偏好\n\n主人讨厌吃香菜，闻到味道就想躲。\n\n机器人最喜欢吃热乎乎的大示例主食和薯片。\n\n主人的电脑使用 Windows 系统。\n')
  fs.writeFileSync(path.join(mem,'journal','2026-10-23.md'),'# 日记\n\n昨天修复了语音合成，参考音色选择示例音色。\n')
  fs.writeFileSync(path.join(mem,'stranger-chat','a.md'),'# 陌生人\n\n陌生人的秘密代号是 ALIEN_ONLY，喜欢吃香菜。\n')
  let store=createMemoryStore({root,semanticConfig:config})
  try {
    await t.test('real CPU embedding + FTS build, dimensions and incremental cache',async()=>{
      const status=await store.syncIndex();assert.equal(status.dimensions,512);assert.equal(status.provider,'CPUExecutionProvider');assert.equal(status.units,5);assert.equal(status.cloud,false)
      const again=await store.syncIndex();assert.equal(again.changed,0);assert.equal(again.inferenceBatches,status.inferenceBatches)
      console.log('REAL_MODEL='+JSON.stringify(status))
    })
    await t.test('paraphrase Recall@1 without shared meaningful keywords',async()=>{
      const r=await store.hybridRecall('做菜时要避开什么食材？',{limit:1});assert.equal(r.semantic,true);assert.match(r.results[0].text,/讨厌吃香菜/);assert.equal(r.reranked,true);assert.ok(r.results[0].vectorScore>0);console.log('PARAPHRASE='+JSON.stringify(r))
    })
    await t.test('unrelated question abstains rather than forcing nearest neighbour',async()=>{
      const r=await store.hybridRecall('宇宙飞船燃料的化学公式？');assert.equal(r.results.length,0)
    })
    await t.test('query cache is bounded to current revision and returns the same evidence',async()=>{
      const q='语音参考音色',a=await store.hybridRecall(q),b=await store.hybridRecall(q);assert.equal(b.cached,true);assert.deepEqual(a.results,b.results)
    })
    await t.test('owner/stranger isolation, category/date filters and evidence line',async()=>{
      const own=await store.hybridRecall('ALIEN_ONLY');assert.ok(own.results.every(x=>x.scope==='owner'));assert.ok(!JSON.stringify(own).includes('秘密代号'))
      const other=await store.hybridRecall('ALIEN_ONLY',{scope:'stranger'});assert.equal(other.results.length,1);assert.match(other.results[0].text,/秘密代号/)
      const dated=await store.hybridRecall('语音',{from:'2026-10-23',to:'2026-10-23',category:'experience'});assert.equal(dated.results.length,1);assert.equal(dated.results[0].day,'2026-10-23');assert.ok(dated.results[0].line>0)
      await assert.rejects(store.hybridRecall('机器人',{scope:'bad'}),/范围/)
    })
    await t.test('bounded deduplicated context and evidence-only review',async()=>{
      const r=await store.hybridRecall('主人',{budget:300,limit:2});assert.ok(r.contextChars<=300);assert.ok(r.results.length<=2);assert.equal(new Set(r.results.map(x=>x.text)).size,r.results.length)
      const review=await store.reflect('讨厌的食材');assert.equal(review.generated,false);assert.equal(review.mode,'extractive-evidence-review');assert.ok(review.observations.length);assert.ok(review.observations.every(x=>x.source&&x.line))
    })
    await t.test('updates and deletes cannot resurrect stale vectors',async()=>{
      fs.writeFileSync(path.join(mem,'facts.md'),'# 偏好更新\n\n主人现在喜欢吃香菜，已经不再讨厌它。\n')
      let r=await store.hybridRecall('香菜');assert.ok(!JSON.stringify(r).includes('闻到味道就想躲'));assert.ok(r.results.some(x=>x.text.includes('现在喜欢')))
      fs.unlinkSync(path.join(mem,'facts.md'));r=await store.hybridRecall('香菜');assert.ok(!JSON.stringify(r).includes('现在喜欢'));assert.ok(!JSON.stringify(r).includes('秘密代号'));assert.equal(store.status().localIndex.units,2)
    })
    await t.test('SQLite restart persistence with no re-embedding unchanged documents',async()=>{
      const revision=store.status().localIndex.revision;await store.dispose();store=createMemoryStore({root,semanticConfig:config});const s=await store.syncIndex();assert.equal(s.revision,revision);assert.equal(s.changed,0);assert.equal(s.inferenceBatches,0)
      const r=await store.hybridRecall('语音音色');assert.ok(r.results.some(x=>x.text.includes('示例音色')));console.log('RESTART='+JSON.stringify(s))
    })
    await t.test('parallel calls serialize; retained note is immediately searchable',async()=>{
      const added=store.retain({text:'下周比赛前要把蓝色键盘装进背包。'});const all=await Promise.all(['比赛前带什么','语音音色','ALIEN_ONLY'].map(q=>store.hybridRecall(q)));assert.ok(all[0].results.some(x=>x.source===added.source));assert.ok(all.every(x=>x.semantic));assert.ok(all[2].results.every(x=>x.scope==='owner'))
    })
    await t.test('missing model explicitly degrades without calling cloud',async()=>{
      const broken=createMemoryStore({root,semanticConfig:{...config,model:path.join(root,'not-a-model')},fetcher:()=>{throw new Error('unexpected network')}})
      try{const r=await broken.hybridRecall('语音');assert.equal(r.degraded,true);assert.equal(r.semantic,false);assert.ok(r.results.length);assert.match(r.note,/词项/)}finally{await broken.dispose()}
    })
  }finally{await store.dispose();fs.rmSync(root,{recursive:true,force:true})}
})
