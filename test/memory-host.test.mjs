import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const root=fs.mkdtempSync(path.join(os.tmpdir(),'qqbot-memory-http-')),workspace=path.join(root,'custom-workspace'),memoryDir=path.join(workspace,'records')
fs.mkdirSync(memoryDir,{recursive:true});fs.writeFileSync(path.join(memoryDir,'facts.md'),'# facts\n\n主人用 Python 计算实验数据；机器人负责计划。\n')
const cfg=path.join(root,'config.json');fs.writeFileSync(cfg,JSON.stringify({root,paths:{workspace,memoryDir}}));process.env.QQBOT_CONFIG=cfg
const{handle,closeLocalMemory}=await import('../lib/index.js')
const server=http.createServer((req,res)=>handle(req,res,null));await new Promise(r=>server.listen(0,'127.0.0.1',r))
const base='http://127.0.0.1:'+server.address().port+'/dsh-xiaoyu-qqbot/'
const get=async url=>{const r=await fetch(base+url);return {status:r.status,body:await r.json()}}
test.after(async()=>{await closeLocalMemory();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true})})
test('memory HTTP: public static assets and custom configured workspace are served',async()=>{
  for(const name of ['memory','memory-brain.js','memory-3d.js','memory-layout.js','memory-fullscreen.js','memory.js','memory.css'])assert.equal((await fetch(base+name)).status,200)
  const r=await get('api/memory/graph');assert.equal(r.status,200);assert.equal(r.body.stats.memories,1);assert.ok(r.body.nodes.every(n=>n.region));assert.equal(r.body.regions.length,6)
})
test('memory HTTP: every frontend uses the actual public route prefix',async()=>{
  for(const file of ['widget.js','memory','memory.js','memory-layout.js']){
    const response=await fetch(base+file),text=await response.text();assert.equal(response.status,200);assert.doesNotMatch(text,/\/dsh-qqbot-qqbot|\/dsh-qqbot\//);assert.match(text,/\/dsh-xiaoyu-qqbot/)
  }
})
test('memory HTTP: missing model is explicit text fallback, no fake semantic recall',async()=>{
  const r=await get('api/memory/recall?q=Python');assert.equal(r.body.degraded,true);assert.equal(r.body.semantic,false);assert.equal(r.body.results[0].source,'facts.md')
  const review=await get('api/memory/reflect?q=Python');assert.equal(review.body.generated,false);assert.equal(review.body.mode,'extractive-evidence-review')
})
test('memory HTTP: model install/retain require CSRF and cross-origin is denied',async()=>{
  for(const ep of ['memory/deploy','memory/retain','memory/reindex'])assert.equal((await fetch(base+'api/'+ep,{method:'POST',body:'{}'})).status,403)
  assert.equal((await fetch(base+'api/memory/graph',{headers:{origin:'https://invalid.example'}})).status,403)
  assert.equal((await get('api/memory/graph?scope=invalid')).status,400)
})
test('memory HTTP: retain preserves existing source; settings workspace switch rebinds scan',async()=>{
  const original=fs.readFileSync(path.join(memoryDir,'facts.md'));const token=(await get('api/csrf')).body.token
  const r=await fetch(base+'api/memory/retain',{method:'POST',headers:{'content-type':'application/json','x-dsh-csrf':token},body:JSON.stringify({text:'新约定：重要结论附证据。'})});assert.equal(r.status,200);assert.equal(Buffer.compare(original,fs.readFileSync(path.join(memoryDir,'facts.md'))),0)
  const other=path.join(root,'another-memory');fs.mkdirSync(other);fs.writeFileSync(path.join(other,'facts.md'),'# other\n\nNEW_WORKSPACE_ONLY\n')
  const change=await fetch(base+'api/settings',{method:'POST',headers:{'content-type':'application/json','x-dsh-csrf':token},body:JSON.stringify({patch:{paths:{memoryDir:other}}})});assert.equal(change.status,200)
  const switched=await get('api/memory/items');assert.equal(switched.body.items.length,1);assert.match(switched.body.items[0].text,/NEW_WORKSPACE_ONLY/)
})
