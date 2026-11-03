import test from 'node:test'
import assert from 'node:assert/strict'
import '../assets/memory-brain.js'
const brain=globalThis.QQBotBrain
test('brain: six semantic domains, deterministic positions and finite separated anchors',()=>{
  assert.equal(brain.regions.length,6);assert.equal(new Set(brain.regions.map(r=>r.id)).size,6)
  for(const r of brain.regions){const p=brain.point('stable',r.id);assert.deepEqual(p,brain.point('stable',r.id));assert.ok([p.x,p.y,p.z].every(Number.isFinite));assert.ok(Math.abs(p.x-r.x)<r.rx)}
})
test('brain: domains orthogonal to memory kind, creativity can have secondary tags',()=>{
  assert.equal(brain.classify('Python 算法与数学计算').region,'modeling');assert.equal(brain.classify('图片配色与绘画艺术').region,'aesthetic');assert.ok(brain.classify('计划学习绘画艺术并执行任务').tags.length>1)
})
test('brain: regional bundles count only actual cross-region edges',()=>{
  const ns=[{id:'a',region:'planning'},{id:'b',region:'skills'},{id:'c',region:'planning'}]
  const bs=brain.bundles(ns,[{source:'a',target:'b',weight:3},{source:'b',target:'c',weight:2},{source:'a',target:'c',weight:8},{source:'z',target:'b'}]);assert.equal(bs.length,1);assert.equal(bs[0].count,2);assert.equal(bs[0].weight,5)
})
