// Pure 3D math shared by renderer, layout worker and regression tests.
(function (root) {
  'use strict'
  function seed(id) { let h=2166136261;for(const c of String(id))h=Math.imul(h^c.charCodeAt(0),16777619);return(h>>>0)/4294967296 }
  function initialPoint(id, index, count) {
    const s=seed(id), t=seed(id+':depth'), side=s<.5?-1:1
    const phi=index*2.399963229728653, u=2*(index+.5)/Math.max(1,count)-1
    const ring=Math.sqrt(Math.max(.02,1-u*u)), radius=.48+.52*Math.cbrt(t)
    return {id,x:side*115+Math.cos(phi)*ring*145*radius,y:u*205*radius,z:Math.sin(phi)*ring*165*radius,side}
  }
  function rotate(point,yaw,pitch) {
    const x=point.x*Math.cos(yaw)+(point.z||0)*Math.sin(yaw)
    const z=-point.x*Math.sin(yaw)+(point.z||0)*Math.cos(yaw)
    return {x,y:point.y*Math.cos(pitch)-z*Math.sin(pitch),z:point.y*Math.sin(pitch)+z*Math.cos(pitch)}
  }
  function project(point,camera,size) {
    const p=camera.flat?{x:point.x,y:point.y,z:0}:rotate(point,camera.yaw||0,camera.pitch||0)
    const perspective=camera.flat?1:850/Math.max(300,850-p.z)
    return {x:(p.x-(camera.x||0))*camera.scale*perspective+size.w/2,y:(p.y-(camera.y||0))*camera.scale*perspective+size.h/2,z:p.z,perspective,depth:Math.max(0,Math.min(1,(p.z+280)/560))}
  }
  function sparseEdges(edges,maxDegree=4) {
    maxDegree=Math.max(1,Math.min(12,Number(maxDegree)||4))
    const unique=new Map()
    for(const edge of edges){if(edge.source===edge.target)continue;const ids=[edge.source,edge.target].sort();const key=ids.join(':')+':'+edge.type;const old=unique.get(key);if(!old||(edge.weight||1)>(old.weight||1))unique.set(key,edge)}
    const sorted=[...unique.values()].sort((a,b)=>(b.weight||1)-(a.weight||1)||String(a.id).localeCompare(String(b.id)))
    const degree=new Map(), result=[]
    for(const edge of sorted){if((degree.get(edge.source)||0)>=maxDegree||(degree.get(edge.target)||0)>=maxDegree)continue;result.push(edge);degree.set(edge.source,(degree.get(edge.source)||0)+1);degree.set(edge.target,(degree.get(edge.target)||0)+1)}
    return result
  }
  function animationState({paused,visible,timeline,reducedMotion,selected,hovered,dragging,cruise}) {
    return {animate:!paused&&visible&&!timeline&&!reducedMotion,rotate:!paused&&visible&&!timeline&&!reducedMotion&&!selected&&!hovered&&!dragging&&cruise}
  }
  function advance(camera,dt,state) {if(state.rotate)camera.yaw+=Math.min(.05,Math.max(0,dt))*.075;return camera}
  // Visual prominence, not an inferred importance/confidence or stellar temperature.
  function featureScores(nodes,edges) {
    const weights=new Map(nodes.map(n=>[n.id,0])), pairs=new Map()
    for(const e of edges){if(e.source===e.target||!weights.has(e.source)||!weights.has(e.target))continue;const key=JSON.stringify([...[e.source,e.target].sort(),e.type||'']);const w=Number.isFinite(+e.weight)?Math.max(0,+e.weight):1;pairs.set(key,{e,w:Math.max(w,pairs.get(key)?.w||0)})}
    for(const {e,w} of pairs.values()){weights.set(e.source,weights.get(e.source)+w);weights.set(e.target,weights.get(e.target)+w)}
    const mentions=n=>Math.log1p(Math.max(0,Number.isFinite(+n.count)?+n.count:1)), strength=n=>Math.log1p(weights.get(n.id)||0)
    const maxCount=Math.max(1,...nodes.map(mentions)),maxStrength=Math.max(1,...nodes.map(strength))
    return new Map(nodes.map(n=>[n.id,Math.min(1,.7*mentions(n)/maxCount+.3*strength(n)/maxStrength)]))
  }
  function starStyle(value) {
    const score=Number.isFinite(+value)?Math.max(0,Math.min(1,+value)):0
    const stops=[[0,[42,90,158]],[.32,[70,112,164]],[.36,[185,125,80]],[.65,[255,183,83]],[1,[255,246,222]]]
    let a=stops[0],b=stops[1];for(let i=1;i<stops.length;i++){a=stops[i-1];b=stops[i];if(score<=b[0])break}
    const t=(score-a[0])/(b[0]-a[0]),rgb=a[1].map((x,i)=>Math.round(x+(b[1][i]-x)*t))
    const stellar=score>=.36
    return {score,stellar,color:'rgb('+rgb.join(',')+')',core:stellar?(score>.8?'#fffbed':'#ffe7b2'):'#75a9d6',rim:stellar?'#9c502a':'#18354e',glow:stellar?7+score*17:1+score*4,alpha:.5+.5*score,radius:2.8+score*4.5}
  }
  function dragCamera(camera,dx,dy,pan=false) {
    if(camera.flat||pan){camera.x-=dx/camera.scale;camera.y-=dy/camera.scale}
    else{camera.yaw+=dx*.006;camera.pitch=Math.max(-1.15,Math.min(1.15,camera.pitch-dy*.006))}
    return camera
  }
  root.QQBot3D={seed,initialPoint,rotate,project,sparseEdges,animationState,advance,featureScores,starStyle,dragCamera}
})(globalThis)
