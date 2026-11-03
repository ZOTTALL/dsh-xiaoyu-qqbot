import {onLog} from '../lib/core.mjs'
onLog(row=>console.log('[deploy]',row.line||row.message||JSON.stringify(row)))
import * as deploy from '../lib/deploy.mjs'
const actions={tools:deploy.deployTools,astrbot:deploy.deployAstrbot,napcat:deploy.deployNapcat,bridge:deploy.deployBridge,ingress:deploy.deployIngress,memory:deploy.deployMemory,tts:deploy.deployTts}
const target=process.argv[2]
if(!Object.hasOwn(actions,target))throw new Error('目标应为 tools / astrbot / napcat / bridge / ingress / memory / tts')
const started=await actions[target]()
let job
do{await new Promise(resolve=>setTimeout(resolve,250));job=deploy.getDeployJob(started.id)}while(job.status==='running')
console.log(JSON.stringify(job,null,2))
if(job.status==='error')process.exitCode=1
else if(job.status==='partial')process.exitCode=2
