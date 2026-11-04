import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {inside} from '../lib/bridge-install.mjs'
import {ensureTools} from '../lib/deploy-tools.mjs'
import {runCommand,streamCommand,commandError} from '../lib/deploy-utils.mjs'
import {downloadResource,publicDownloadEnv} from '../lib/download-sources.mjs'
import {ensurePython,uvPackages} from '../lib/uv-network.mjs'
const here=path.dirname(fileURLToPath(import.meta.url))
export async function setupMemory({root,workspace,python='3.11',uv,step=console.log,run,download=downloadResource}={}){
  root=path.resolve(root||path.join(process.env.LOCALAPPDATA||process.env.HOME||'.','DSH-QQBOT'))
  workspace=path.resolve(workspace||path.join(root,'workspace'))
  const runtime=inside(root,path.join(root,'memory-runtime')),exe=path.join(runtime,'venv','Scripts','python.exe')
  const tool=uv?{tools:{uv},env:publicDownloadEnv(process.env)}:await ensureTools({root,names:['uv'],step})
  tool.env.UV_CACHE_DIR=inside(root,path.join(root,'.deploy-tools','uv-cache'))
  tool.env.UV_PYTHON_INSTALL_DIR=inside(root,path.join(root,'.deploy-tools','python'))
  const execute=run||((file,args,opts)=>streamCommand(file,args,{...opts,step}))
  if(!fs.existsSync(exe)){
    const p=await ensurePython({root,uv:tool.tools.uv,version:python,env:tool.env,run:execute,download,step})
    const r=await execute(tool.tools.uv,['venv','--no-config','--python',p.python,'--no-python-downloads',path.join(runtime,'venv')],{env:p.env})
    if(!r.ok)throw new Error('创建独立记忆环境失败：'+commandError(tool.tools.uv,r))
  }
  await uvPackages(tool.tools.uv,['pip','sync','--system-certs','--python',exe,path.join(here,'memory-requirements.lock')],{env:tool.env,run:execute,step})
  for(const spec of [{manifest:'memory-model.manifest.json',folder:'bge-small-zh-v1.5-int8'},{manifest:'memory-reranker.manifest.json',folder:'bge-reranker-base-int8'}]){
    const directory=inside(root,path.join(runtime,'models',spec.folder));fs.mkdirSync(directory,{recursive:true})
    const manifest=JSON.parse(fs.readFileSync(path.join(here,spec.manifest),'utf8'))
    for(const file of manifest.files){
      if(!/^[A-Za-z0-9_.-]+$/.test(file.file)||!file.url.startsWith('https://huggingface.co/'))throw new Error('固定模型清单无效')
      await download(file.url,path.join(directory,file.file),file.sha256,{step,onProgress:(done,total)=>step(`${spec.folder}/${file.file}：${(done/1048576).toFixed(1)} / ${(total/1048576).toFixed(1)} MiB`)})
    }
    fs.copyFileSync(path.join(here,spec.manifest),path.join(directory,'manifest.json'))
  }
  const cfg=path.join(workspace,'data','memory-local.runtime.json');fs.mkdirSync(path.dirname(cfg),{recursive:true})
  if(fs.existsSync(cfg))fs.copyFileSync(cfg,cfg+'.before-setup-'+Date.now()+'-'+crypto.randomUUID())
  const data={python:exe,model:path.join(runtime,'models','bge-small-zh-v1.5-int8'),reranker:path.join(runtime,'models','bge-reranker-base-int8'),version:1}
  const temp=cfg+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(temp,JSON.stringify(data,null,2));fs.renameSync(temp,cfg)
  step('LOCAL_MEMORY_SETUP=PASS;PROVIDER=CPU;CLOUD=false');return data
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const opts={}
  for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i]?.replace(/^--/,'');if(!['root','workspace','python','uv'].includes(key)||!process.argv[i+1])throw new Error('参数应为 --root / --workspace / --python / --uv');opts[key]=process.argv[i+1]}
  try{await setupMemory(opts)}catch(e){console.error(e.message);process.exitCode=1}
}
