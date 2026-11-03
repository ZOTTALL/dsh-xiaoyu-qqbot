import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const geometry=fs.readFileSync(new URL('../assets/memory-3d.js',import.meta.url),'utf8')
const context=vm.createContext({});vm.runInContext(geometry,context);const g=context.QQBot3D
const state={paused:false,visible:true,timeline:false,reducedMotion:false,selected:'',hovered:'',dragging:false,cruise:true}

test('3d: deterministic volumetric coordinates use both visual hemispheres',()=>{
  const points=Array.from({length:180},(_,i)=>g.initialPoint('e-'+i,i,180))
  assert.deepEqual(g.initialPoint('e-1',1,180),g.initialPoint('e-1',1,180))
  assert.ok(points.every(p=>[p.x,p.y,p.z].every(Number.isFinite)))
  assert.ok(Math.max(...points.map(p=>p.z))-Math.min(...points.map(p=>p.z))>200)
  assert.ok(points.some(p=>p.side===-1)&&points.some(p=>p.side===1))
})
test('3d: perspective and rotation change depth, screen location and apparent size',()=>{
  const camera={x:0,y:0,scale:1,yaw:0,pitch:0,flat:false},size={w:900,h:700}
  const near=g.project({x:100,y:0,z:200},camera,size),far=g.project({x:100,y:0,z:-200},camera,size)
  assert.ok(near.perspective>far.perspective);assert.ok(near.x>far.x)
  const rotated=g.project({x:100,y:0,z:200},{...camera,yaw:1},size);assert.notEqual(rotated.x,near.x);assert.notEqual(rotated.z,near.z)
})
test('3d: 2D mode is an explicit flat projection, not a depth effect',()=>{
  const p=g.project({x:40,y:30,z:200},{scale:2,flat:true,yaw:1,pitch:1},{w:800,h:600})
  assert.equal(p.x,480);assert.equal(p.y,360);assert.equal(p.perspective,1);assert.equal(p.z,0)
})
test('3d: sparse edges deduplicate reversed pairs and limit visual degree without editing source',()=>{
  const edges=[];for(let i=0;i<10;i++)for(let j=i+1;j<10;j++)edges.push({id:i+'-'+j,source:'n'+i,target:'n'+j,weight:10-i,type:'cooccurrence'})
  edges.push({...edges[0],id:'reverse',source:'n1',target:'n0',weight:1})
  const before=JSON.stringify(edges),sparse=g.sparseEdges(edges,3),degree=new Map()
  assert.ok(sparse.length<edges.length);assert.equal(JSON.stringify(edges),before)
  const keys=new Set();for(const e of sparse){const key=[e.source,e.target].sort().join(':');assert.ok(!keys.has(key));keys.add(key);degree.set(e.source,(degree.get(e.source)||0)+1);degree.set(e.target,(degree.get(e.target)||0)+1)}
  assert.ok([...degree.values()].every(x=>x<=3))
})
test('3d: motion honors pause, hidden tabs, timeline and reduced motion',()=>{
  assert.equal(g.animationState(state).animate,true)
  for(const change of [{paused:true},{visible:false},{timeline:true},{reducedMotion:true}])assert.equal(g.animationState({...state,...change}).animate,false)
})
test('3d: focus locks camera but leaves visual pulses active; cruise can be disabled',()=>{
  for(const change of [{selected:'x'},{hovered:'x'},{dragging:true},{cruise:false}]){const s=g.animationState({...state,...change});assert.equal(s.rotate,false);assert.equal(s.animate,true)}
})
test('3d: ambient camera continues beyond the old 7.26-second physics bound',()=>{
  const camera={yaw:0};const s=g.animationState(state)
  for(let i=0;i<221;i++)g.advance(camera,.033,s);const afterSettle=camera.yaw
  for(let i=0;i<221;i++)g.advance(camera,.033,s)
  assert.ok(camera.yaw>afterSettle+.4)
  const paused=camera.yaw;g.advance(camera,10,g.animationState({...state,paused:true}));assert.equal(camera.yaw,paused)
})
test('3d: worker emits nonzero Z coordinates, settles physics, and respects explicit pause',()=>{
  let tick,last;const w=vm.createContext({setInterval:fn=>{tick=fn},postMessage:msg=>{last=msg},importScripts:()=>vm.runInContext(geometry,w)})
  vm.runInContext(fs.readFileSync(new URL('../assets/memory-layout.js',import.meta.url),'utf8'),w)
  const nodes=Array.from({length:40},(_,i)=>({id:'m'+i}));const edges=nodes.slice(1).map((n,i)=>({id:'l'+i,source:'m'+i,target:n.id,type:'cooccurrence',weight:1}))
  w.onmessage({data:{type:'graph',nodes,edges}});assert.ok(last.nodes.some(n=>Math.abs(n.z)>10));assert.equal(last.settled,false)
  for(let i=0;i<225;i++)tick();assert.equal(last.settled,true)
  assert.ok(last.nodes.every(n=>[n.x,n.y,n.z].every(Number.isFinite)))
  assert.ok(last.nodes.every(n=>Math.hypot(n.x,n.y,n.z)<500),'settled volume stays within perspective camera envelope')
  const before=JSON.stringify(last);tick();assert.equal(JSON.stringify(last),before)
  w.onmessage({data:{type:'graph',nodes,edges}});w.onmessage({data:{type:'pause',value:true}});const paused=JSON.stringify(last);tick();assert.equal(JSON.stringify(last),paused)
})
