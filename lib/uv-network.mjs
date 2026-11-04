import fs from 'node:fs'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {inside} from './bridge-install.mjs'
import {runCommand,commandError} from './deploy-utils.mjs'
import {sourcePolicy,publicDownloadEnv,downloadResource} from './download-sources.mjs'
const runtimeManifest=JSON.parse(fs.readFileSync(new URL('../tools/python-runtime.manifest.json',import.meta.url),'utf8'))
export async function uvPackages(uv,args,{env=process.env,cwd,step=()=>{},run=runCommand,sources=sourcePolicy.pypi}={}){
  const failures=[]
  for(const source of sources){
    const next=publicDownloadEnv(env);next.UV_HTTP_TIMEOUT='20';next.UV_HTTP_RETRIES=source.official?'2':'0'
    step('尝试'+source.name+'安装 Python 依赖：'+source.url)
    let r
    try{r=await run(uv,[...args,'--no-config','--default-index',source.url],{env:next,cwd,timeout:source.official?sourcePolicy.timeouts.pypiOfficialMs:sourcePolicy.timeouts.pypiMirrorMs})}
    catch(e){r={ok:false,error:e.message,code:e.code}}
    if(r.ok){step(source.name+'依赖安装完成');return r}
    failures.push(source.name+'：'+commandError(uv,r));step(source.name+'失败，切换下一源：'+commandError(uv,r))
  }
  throw new Error('Python 依赖全部来源均失败：'+failures.join('；'))
}
export async function ensurePython({root,uv,version,env=process.env,arch=process.arch,step=()=>{},run=runCommand,download=downloadResource}){
  const exact=runtimeManifest.versions[version]||version,family={x64:'x86_64',arm64:'aarch64'}[arch]
  const pair=Object.entries(runtimeManifest.metadata).find(([k,m])=>`${m.major}.${m.minor}.${m.patch}`===exact&&m.arch.family===family)
  if(!pair)throw new Error(`未提供 ${arch} / Python ${version} 的固定运行时清单`)
  const [key,spec]=pair,next=publicDownloadEnv(env)
  next.UV_PYTHON_INSTALL_DIR=inside(root,path.join(root,'.deploy-tools','python'));next.UV_PYTHON_NO_REGISTRY='1'
  next.UV_CACHE_DIR=inside(root,path.join(root,'.deploy-tools','uv-cache'))
  const found=await run(uv,['python','find',exact,'--managed-python','--no-python-downloads','--no-config'],{env:next,timeout:15000})
  if(found.ok&&fs.existsSync(found.stdout.trim())){step('复用已安装的固定 Python '+exact);return{python:found.stdout.trim(),env:next,version:exact}}
  const cache=inside(root,path.join(root,'.deploy-tools','cache','python'));fs.mkdirSync(cache,{recursive:true})
  const archive=path.join(cache,key+'.tar.gz')
  step('准备固定 Python '+exact+'，先尝试国内镜像')
  await download(spec.url,archive,spec.sha256,{step})
  const metadata=path.join(cache,key+'.json')
  fs.writeFileSync(metadata,JSON.stringify({[key]:{...spec,url:pathToFileURL(archive).href}}))
  next.UV_PYTHON_DOWNLOADS_JSON_URL=metadata
  const installed=await run(uv,['python','install',exact,'--no-config','--no-bin','--no-registry'],{env:next,timeout:300000})
  if(!installed.ok)throw new Error('固定 Python 本地安装失败：'+commandError(uv,installed))
  const result=await run(uv,['python','find',exact,'--managed-python','--no-python-downloads','--no-config'],{env:next,timeout:15000})
  if(!result.ok||!fs.existsSync(result.stdout.trim()))throw new Error('已校验 Python 安装后未找到解释器：'+commandError(uv,result))
  step('固定 Python '+exact+'已就绪');return{python:result.stdout.trim(),env:next,version:exact}
}
