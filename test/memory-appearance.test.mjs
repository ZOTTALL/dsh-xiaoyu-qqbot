import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
const c=vm.createContext({});vm.runInContext(fs.readFileSync(new URL('../assets/memory-3d.js',import.meta.url),'utf8'),c);const g=c.QQBot3D

test('appearance: prominence combines mentions and full weighted graph, without mutating it',()=>{
  const nodes=[{id:'a',count:1},{id:'b',count:4},{id:'c',count:30}],edges=[{source:'a',target:'b',weight:1},{source:'b',target:'c',weight:8}]
  const before=JSON.stringify({nodes,edges}),scores=g.featureScores(nodes,edges)
  assert.ok(scores.get('a')<scores.get('b')&&scores.get('b')<scores.get('c'))
  assert.equal(JSON.stringify({nodes,edges}),before)
  const duplicate=g.featureScores(nodes,[...edges,{source:'c',target:'b',weight:8},{source:'c',target:'c',weight:9000}])
  assert.deepEqual([...scores],[...duplicate])
  const source=fs.readFileSync(new URL('../assets/memory.js',import.meta.url),'utf8')
  assert.match(source,/featureScores=geom.featureScores\(data.nodes,data.edges\)/)
})
test('appearance: low nodes are blue planets, strong nodes warm luminous spheres with increasing brightness',()=>{
  const low=g.starStyle(0),high=g.starStyle(1)
  assert.equal(low.stellar,false);assert.equal(high.stellar,true);assert.ok(high.glow>low.glow)
  let previous=0
  for(let i=0;i<=100;i++){
    const s=g.starStyle(i/100),rgb=s.color.match(/\d+/g).map(Number)
    const luminance=rgb.reduce((sum,v,k)=>sum+[.2126,.7152,.0722][k]*Math.pow(v/255,2.2),0)*s.alpha
    assert.ok(luminance>=previous-.001,'brightness must not fall with prominence at '+i)
    previous=luminance
  }
  assert.ok(low.alpha<high.alpha&&low.radius<high.radius)
})
test('appearance: empty, isolated and malformed source scores/styles stay finite',()=>{
  assert.equal(g.featureScores([],[]).size,0)
  for(const score of g.featureScores([{id:'x',count:NaN},{id:'y',count:-4}],[{source:'x',target:'missing',weight:Infinity}]).values())assert.ok(Number.isFinite(score)&&score>=0&&score<=1)
  assert.equal(g.starStyle(NaN).score,0);assert.equal(g.starStyle(99).score,1)
})
test('controls: vertical orbit is reversed and front-facing points follow downward/upward drag',()=>{
  const camera={x:0,y:0,scale:1,yaw:0,pitch:0,flat:false},size={w:800,h:700},point={x:0,y:0,z:200}
  const before=g.project(point,camera,size)
  g.dragCamera(camera,0,50);assert.ok(camera.pitch<0);assert.ok(g.project(point,camera,size).y>before.y)
  g.dragCamera(camera,0,-100);assert.ok(camera.pitch>0);assert.ok(g.project(point,camera,size).y<before.y)
  g.dragCamera(camera,0,99999);assert.equal(camera.pitch,-1.15)
  const source=fs.readFileSync(new URL('../assets/memory.js',import.meta.url),'utf8');assert.match(source,/geom.dragCamera\(camera,p.x-drag.last.x,p.y-drag.last.y,drag.pan\)/)
})
test('controls: Shift and 2D pan remain direct without changing orbit; explicit hint is present',()=>{
  for(const flat of [false,true]){const camera={x:0,y:0,scale:2,yaw:.3,pitch:.2,flat};g.dragCamera(camera,30,40,!flat);assert.equal(camera.x,-15);assert.equal(camera.y,-20);assert.equal(camera.pitch,.2);assert.equal(camera.yaw,.3)}
  const html=fs.readFileSync(new URL('../assets/memory.html',import.meta.url),'utf8');assert.match(html,/id="pan-hint">按住shift拖动平移/)
  assert.match(html,/低特征 · 行星/);assert.match(html,/高特征 · 恒星/)
})
