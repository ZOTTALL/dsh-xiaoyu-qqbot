(function(root){
  'use strict'
  // Semantic UI domains, not a scientific localization of human cognition.
  const regions=[
    {id:'planning',label:'规划 · 推理',color:'#e3b97d',x:-105,y:-120,z:170,rx:115,ry:85,rz:80,pattern:/计划|规划|推理|决策|目标|方案|约定|承诺|任务|安排|策略|步骤/gi},
    {id:'modeling',label:'计算 · 建模',color:'#81c5c4',x:0,y:-195,z:-5,rx:150,ry:75,rz:115,pattern:/计算|数学|建模|机器学习|算法|模型|数据|实验|代码|Python|Redis|SQL|课程|考试/gi},
    {id:'language',label:'语言 · 知识',color:'#acb8f0',x:-205,y:-15,z:0,rx:85,ry:115,rz:135,pattern:/语言|知识|语气|人格|对话|称呼|说话|规则|DeepSeek|DSH|AstrBot|NapCat|工具|设置|接口/gi},
    {id:'aesthetic',label:'视觉 · 审美',color:'#cf9abd',x:155,y:-80,z:-140,rx:120,ry:95,rz:80,pattern:/视觉|审美|艺术|配色|图片|表情|绘画|设计|动画|视频|音乐|音色|示例音色|摄影|星海|UI/gi},
    {id:'episodic',label:'经历 · 证据',color:'#d7bc8a',x:15,y:45,z:10,rx:100,ry:75,rz:85,pattern:/记忆|回忆|经历|昨天|今天|一起|喜欢|偏好|主人|机器人|示例主食|零食|睡觉|吃饭|日记/gi},
    {id:'skills',label:'技能 · 行动',color:'#88a8cf',x:100,y:165,z:-65,rx:140,ry:65,rz:100,pattern:/技能|执行|操作|启动|重启|服务|发送|部署|脚本|整理|修复|安装|调试|语音|发送|备份/gi}
  ]
  function classify(text){const ranked=regions.map(r=>({id:r.id,score:(String(text).match(r.pattern)||[]).length})).sort((a,b)=>b.score-a.score);return {region:ranked[0].score?ranked[0].id:'episodic',tags:ranked.filter(x=>x.score>0).map(x=>x.id),basis:'rules-v1'}}
  function point(id,region){const r=regions.find(r=>r.id===region)||regions[4];let h=2166136261;for(const c of id)h=Math.imul(h^c.charCodeAt(0),16777619);const rand=()=>{h=(Math.imul(h,1664525)+1013904223)>>>0;return h/4294967296};const u=rand()*2-1,p=rand()*Math.PI*2,rad=.25+.65*Math.cbrt(rand()),ring=Math.sqrt(1-u*u);return{id,x:r.x+Math.cos(p)*ring*r.rx*rad,y:r.y+u*r.ry*rad,z:r.z+Math.sin(p)*ring*r.rz*rad}}
  function bundles(nodes,edges){const ns=new Map(nodes.map(n=>[n.id,n])),out=new Map();for(const e of edges){const a=ns.get(e.source)?.region,b=ns.get(e.target)?.region;if(!a||!b||a===b)continue;const key=[a,b].sort().join(':');const old=out.get(key)||{source:[a,b].sort()[0],target:[a,b].sort()[1],weight:0,count:0,type:'aggregated-cooccurrence'};old.count++;old.weight+=e.weight||1;out.set(key,old)}return [...out.values()].sort((a,b)=>b.weight-a.weight)}
  root.QQBotBrain={regions,classify,point,bundles}
})(globalThis)
