// Physics can settle; the renderer ambient animation has a separate lifecycle.
importScripts('/dsh-xiaoyu-qqbot/memory-3d.js','/dsh-xiaoyu-qqbot/memory-brain.js')
let nodes=[],edges=[],paused=false,ticks=0
const known=new Map();let mode=''
onmessage=({data})=>{
  if(data.type==='graph'){
    if(mode!==data.mode){known.clear();mode=data.mode}
    nodes=data.nodes.map((n,i)=>known.get(n.id)||(()=>{const p=mode==='brain'?QQBotBrain.point(n.id,n.region):QQBot3D.initialPoint(n.id,i,data.nodes.length);return {...p,ax:p.x,ay:p.y,az:p.z,vx:0,vy:0,vz:0}})())
    const map=new Map(nodes.map(n=>[n.id,n]));edges=QQBot3D.sparseEdges(mode==='brain'?data.edges.filter(e=>data.nodes.find(n=>n.id===e.source)?.region===data.nodes.find(n=>n.id===e.target)?.region):data.edges,6).map(e=>({a:map.get(e.source),b:map.get(e.target),weight:e.weight})).filter(e=>e.a&&e.b);ticks=0
    for(const n of nodes)known.set(n.id,n)
    for(const id of known.keys())if(!map.has(id))known.delete(id)
    post()
  }else if(data.type==='pause')paused=data.value
  else if(data.type==='move'){const n=known.get(data.id);if(n){n.x=data.x;n.y=data.y;if(Number.isFinite(data.z))n.z=data.z;n.vx=n.vy=n.vz=0;ticks=0;post()}}
}
function post(){postMessage({nodes:nodes.map(n=>({id:n.id,x:n.x,y:n.y,z:n.z})),settled:ticks>220})}
setInterval(()=>{
  if(paused||!nodes.length||ticks>220)return
  ticks++
  for(let i=0;i<nodes.length;i++){
    const a=nodes[i];a.vx+=(a.ax-a.x)*.035;a.vy+=(a.ay-a.y)*.035;a.vz+=(a.az-a.z)*.035
    for(let j=i+1;j<nodes.length;j++){
      const b=nodes[j];let dx=a.x-b.x,dy=a.y-b.y,dz=a.z-b.z;const d2=dx*dx+dy*dy+dz*dz+80,f=Math.min(2.5,420/d2),inv=1/Math.sqrt(d2);dx*=inv*f;dy*=inv*f;dz*=inv*f;a.vx+=dx;a.vy+=dy;a.vz+=dz;b.vx-=dx;b.vy-=dy;b.vz-=dz
    }
  }
  for(const e of edges){const dx=e.b.x-e.a.x,dy=e.b.y-e.a.y,dz=e.b.z-e.a.z,d=Math.sqrt(dx*dx+dy*dy+dz*dz)||1,f=(d-105)*.00065*Math.min(2,Math.sqrt(e.weight||1));e.a.vx+=dx/d*f;e.a.vy+=dy/d*f;e.a.vz+=dz/d*f;e.b.vx-=dx/d*f;e.b.vy-=dy/d*f;e.b.vz-=dz/d*f}
  for(const n of nodes){n.vx*=.78;n.vy*=.78;n.vz*=.78;n.x+=Math.max(-7,Math.min(7,n.vx));n.y+=Math.max(-7,Math.min(7,n.vy));n.z+=Math.max(-7,Math.min(7,n.vz))}
  post()
},33)
