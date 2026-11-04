// Deployment jobs are single-flight per root/component and serialized per root.
// Missing Git/uv are prepared from pinned official portable packages, never globally installed.
import fs from 'node:fs'
import path from 'node:path'
import * as core from './core.mjs'
import {installBridge,installTemplates,INGRESS_SPEC,inside} from './bridge-install.mjs'
import {ensureTools} from './deploy-tools.mjs'
import {createScheduler,runCommand,streamCommand,powershellArgs,quotePS,commandError,publishDirectory} from './deploy-utils.mjs'
const UPSTREAM=JSON.parse(fs.readFileSync(new URL('../tools/upstreams.json',import.meta.url),'utf8'))
import {downloadResource,fetchPinnedCommit,installBundleFromSources} from './download-sources.mjs'
import {uvPackages,ensurePython} from './uv-network.mjs'
export {INGRESS_SPEC}
const scheduler=createScheduler()
let ingressInstaller=null,ingressPackager=prepareIngressArchive
export function setIngressInstaller(fn,{prepare=prepareIngressArchive}={}){ingressInstaller=fn;ingressPackager=prepare}
export const getDeployJob=id=>scheduler.view(id)
function step(job,text,ok=true){job.steps.push({t:Date.now(),text,ok});core.pushLog('console',`[部署:${job.kind}] ${text}`)}
function background(kind,fn,p=core.PATHS(),options){
 return scheduler.start(kind,p.root,async job=>{job.onError=e=>step(job,'失败：'+e.message,false);await fn(job,p)},options)
}
const toolsFor=(job,p,names)=>ensureTools({root:p.root,names,step:s=>step(job,s)})
const logged=(job,file,args,opts={})=>streamCommand(file,args,{...opts,step:s=>step(job,s)})
async function checked(job,file,args,opts){const r=await logged(job,file,args,opts);if(!r.ok)throw new Error(commandError(file,r));return r}
const ps=()=>path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe')

export function isNapcatInstalled(){return fs.existsSync(core.PATHS().napcatExe)}
export function isAstrbotInstalled(){
 const p=core.PATHS()
 if(!fs.existsSync(p.astrbotPy)||!fs.existsSync(path.join(p.astrbotDir,'main.py')))return false
 if(fs.existsSync(path.join(p.astrbotDir,'.qqbot-env-ready.json')))return true
 if(fs.existsSync(path.join(p.astrbotDir,'.qqbot-env-started.json')))return false
 const site=path.join(path.dirname(p.astrbotPy),'..','Lib','site-packages')
 return ['quart','aiohttp','loguru','openai','anthropic','numpy','pandas'].every(name=>fs.existsSync(path.join(site,name)))
}
export function isTtsInstalled(){return fs.existsSync(path.join(core.PATHS().voiceDir,'api_v2.py'))}
export function groupedDeployStatus(){return {napcat:isNapcatInstalled(),astrbot:isAstrbotInstalled(),tts:isTtsInstalled(),bridge:fs.existsSync(core.PATHS().astrbotPluginMain)}}

export async function deployTools(p=core.PATHS()){return background('tools',async(job,p)=>{await toolsFor(job,p,['git','uv']);step(job,'Git / uv 前置工具检查通过；仅用于部署进程，不修改系统 PATH')},p)}
export async function deployNapcat(p=core.PATHS()){return background('napcat',async(job,p)=>{
 inside(p.root,p.napcatDir);inside(p.root,p.tmpDir)
 if(fs.existsSync(p.napcatExe)){step(job,'已检测到 NapCat，跳过下载');job.status=core.PATHS().napcatConfigDir||!fs.existsSync(path.join(p.napcatDir,'NapCatInstaller.exe'))?'done':'partial';if(job.status==='partial')step(job,'请先运行 NapCatInstaller.exe 完成首次初始化');return}
 core.ensureDir(p.napcatDir);core.ensureDir(p.tmpDir)
 const stage=fs.mkdtempSync(path.join(p.tmpDir,'napcat-')),zip=path.join(stage,'NapCat.Shell.zip')
 step(job,`下载 NapCat：${UPSTREAM.napcat.url}`)
 await downloadResource(UPSTREAM.napcat.url,zip,UPSTREAM.napcat.sha256,{step:s=>step(job,s),onRetry:(n,why)=>step(job,`NapCat 下载临时错误 ${why}，第 ${n} 次重试`)})
 step(job,'下载完成并通过 SHA256，解压中…')
 await checked(job,ps(),powershellArgs(`Expand-Archive -LiteralPath ${quotePS(zip)} -DestinationPath ${quotePS(p.napcatDir)} -Force`))
 fs.unlinkSync(zip)
 if(!fs.existsSync(core.PATHS().napcatExe))throw new Error('解压后缺少 NapCat 启动程序，请检查官方发行包结构；原目录已保留')
 if(!core.PATHS().napcatConfigDir){step(job,'OneKey 启动器已准备；请运行部署目录内 NapCatInstaller.exe 完成 QQ / 协议初始化，然后再扫码。');job.status='partial'}
 else step(job,'NapCat 安装完成，可启动并扫码')
},p)}

export async function deployAstrbot(p=core.PATHS()){return background('astrbot',async(job,p)=>{
 const tools=await toolsFor(job,p,['git','uv'])
 if(fs.existsSync(p.astrbotPy)&&fs.existsSync(path.join(p.astrbotDir,'main.py'))){
  const r=await runCommand(p.astrbotPy,[path.join(p.toolsDir,'check-astrbot-env.py'),p.astrbotDir],{env:tools.env})
  if(r.ok){step(job,'AstrBot 依赖一致性检查通过，保留环境并检查桥接');await prepareBridge(job,p,tools);return}
  step(job,'已有环境依赖不完整，继续补装；保留用户配置')
 }
 if(!fs.existsSync(path.join(p.astrbotDir,'main.py')))await checkoutSource(job,p.astrbotDir,UPSTREAM.astrbot,'main.py',p,tools)
 if(!fs.existsSync(p.astrbotPy)){
  step(job,'创建独立 Python '+UPSTREAM.astrbot.python+' 环境…')
  const runtime=await ensurePython({root:p.root,uv:tools.tools.uv,version:UPSTREAM.astrbot.python,env:tools.env,step:s=>step(job,s),run:(file,args,opts)=>logged(job,file,args,opts)})
  await checked(job,tools.tools.uv,['venv','--no-config','--python',runtime.python,'--no-python-downloads','.venv'],{cwd:p.astrbotDir,env:runtime.env})
 }
 core.writeJson(path.join(p.astrbotDir,'.qqbot-env-started.json'),{commit:UPSTREAM.astrbot.commit})
 step(job,'安装固定源码 pyproject 依赖；首次下载可能需要较长时间，请勿重复部署')
 await uvPackages(tools.tools.uv,['pip','install','--system-certs','--python',p.astrbotPy,'-r','pyproject.toml'],{cwd:p.astrbotDir,env:tools.env,step:s=>step(job,s),run:(file,args,opts)=>logged(job,file,args,opts)})
 const checkedEnv=await runCommand(p.astrbotPy,[path.join(p.toolsDir,'check-astrbot-env.py'),p.astrbotDir],{env:tools.env})
 if(!checkedEnv.ok)throw new Error('AstrBot 依赖一致性检查未通过：'+commandError(p.astrbotPy,checkedEnv))
 core.writeJson(path.join(p.astrbotDir,'.qqbot-env-ready.json'),{commit:UPSTREAM.astrbot.commit,installedAt:new Date().toISOString()})
 await prepareBridge(job,p,tools)
 step(job,`AstrBot 安装完成；首次启动后在配置端口 ${core.PORTS().astrbotUi} 的 WebUI 完成账号与 OneBot 初始化`)
},p)}

export async function deployTts(p=core.PATHS()){return background('tts',async(job,p)=>{
 if(!fs.existsSync(path.join(p.voiceDir,'api_v2.py'))){const tools=await toolsFor(job,p,['git']);await checkoutSource(job,p.voiceDir,UPSTREAM.tts,'api_v2.py',p,tools)}
 else step(job,'已检测到 GPT-SoVITS 源码，保留现有目录')
 step(job,'源码已准备；预训练权重、独立 Python 环境、依赖与音色仍需按官方说明配置，源码存在不等于语音可用')
 job.status='partial'
},p)}

async function prepareBridge(job,p,tools){
 const run=(file,args,opts={})=>logged(job,file==='git'?tools.tools.git:file,args,{...opts,env:opts.env||tools.env})
 const installRequirements=file=>uvPackages(tools.tools.uv,['pip','install','--system-certs','--python',p.astrbotPy,'-r',file],{env:tools.env,step:s=>step(job,s),run:(file,args,opts)=>logged(job,file,args,opts)})
 job.bridge=await installBridge({root:p.root,pluginDir:path.dirname(p.astrbotPluginMain),python:p.astrbotPy,tmpDir:p.tmpDir,run,installRequirements,step:s=>step(job,s)})
 const t=installTemplates({workspace:p.workspace});step(job,`占位工作区：新增 ${t.created}，保留 ${t.preserved} 个现有文件`)
}
export async function deployBridge(p=core.PATHS()){return background('bridge',async(job,p)=>{
 if(!fs.existsSync(p.astrbotPy)||!fs.existsSync(path.join(p.astrbotDir,'main.py')))throw new Error('先部署 AstrBot，再补装桥接')
 const tools=await toolsFor(job,p,['git','uv']);await prepareBridge(job,p,tools)
},p)}
export async function deployMemory(p=core.PATHS()){return background('memory',async(job,p)=>{
 inside(p.root,path.join(p.root,'memory-runtime'))
 const tools=await toolsFor(job,p,['uv'])
 step(job,'创建本机 CPU 向量环境、下载固定校验和的公开模型，不上传记忆原文')
 await checked(job,process.execPath,[path.join(p.toolsDir,'setup-memory.mjs'),'--root',p.root,'--workspace',p.workspace,'--uv',tools.tools.uv],{env:{...tools.env,ELECTRON_RUN_AS_NODE:'1'}})
 step(job,'本地向量环境已配置，下次检索自动加载')
},p)}

export async function checkIngress(){
 try{const r=await fetch(`http://127.0.0.1:${core.PORTS().ingress}/health`,{signal:AbortSignal.timeout(3000)});if(r.ok)return{ok:true,detail:await r.json()};return{ok:false,hint:'/health 返回 '+r.status}}
 catch{return{ok:false,hint:'连不上 ingress：确认 DSH 桌面端已打开，并启用 dsh-astrbot-ingress'}}
}
// Build a local tarball from a verified commit using our portable Git. The DSH
// package manager can install that file without requiring Git in its own PATH.
export async function prepareIngressArchive(job,p){
 const tools=await toolsFor(job,p,['git']),cache=inside(p.root,path.join(p.root,'.deploy-tools','ingress-'+UPSTREAM.dshIngress.commit))
 const source=path.join(cache,'source'),archive=path.join(cache,'ingress.tar.gz');inside(p.root,source)
 if(!fs.existsSync(path.join(source,'lib','index.js')))await checkoutSource(job,source,UPSTREAM.dshIngress,'lib/index.js',p,tools)
 const head=await runCommand(tools.tools.git,['-C',source,'rev-parse','HEAD'],{env:tools.env})
 if(!head.ok||head.stdout.trim()!==UPSTREAM.dshIngress.commit)throw new Error('ingress 缓存提交不匹配，已保留目录')
 await checked(job,tools.tools.git,['-C',source,'archive','--format=tar.gz','--prefix=package/','--output='+archive,'HEAD'],{env:tools.env})
 return 'file:'+archive.replaceAll('\\','/')
}
export async function deployIngress(p=core.PATHS()){return background('ingress',async(job,p)=>{
 const health=await checkIngress();if(health.ok){step(job,'DSH ingress 已在线，保留现有安装');job.health=health;return}
 if(!ingressInstaller)throw new Error('当前宿主未提供 pluginManager.installBundle；请在 DSH 插件页安装 dsh-astrbot-ingress')
 const spec=await ingressPackager(job,p)
 step(job,'通过 DSH 官方插件管理器安装已校验提交的 ingress 本地包')
 const r=await installBundleFromSources(ingressInstaller,spec,{step:s=>step(job,s)});job.installation={application:r.application,version:r.version,enabled:r.enabled}
 if(r.error?.code==='already-installed'){job.status='partial';step(job,'ingress 已安装，请在 DSH 插件页启用并检查端口');return}
 if(r.error||r.packageResult?.exitCode||['failed','cancelled'].includes(r.application))throw new Error(r.error?.diagnostic||r.error?.code||'DSH ingress 安装失败')
 job.health=await checkIngress();if(!job.health.ok){job.status='partial';step(job,'安装请求已保存；按 DSH 提示重启 / 启用 ingress 后再检测端口')}else step(job,'DSH ingress 已在线')
},p)}
export async function deployAll(components=['astrbot','napcat','ingress'],p=core.PATHS()){
 const actions={astrbot:deployAstrbot,napcat:deployNapcat,tts:deployTts,ingress:deployIngress,bridge:deployBridge,memory:deployMemory,tools:deployTools}
 if(!Array.isArray(components)||!components.length||components.some(x=>!Object.hasOwn(actions,x)))throw new Error('部署组件列表无效')
 return background('all',async job=>{job.components=[];for(const target of [...new Set(components)]){const task=await actions[target](p),child=await scheduler.get(task.id).promise;job.components.push({target,status:child.status,error:child.error});step(job,target+'：'+child.status,child.status!=='error')}job.status=job.components.some(x=>x.status==='error')?'error':job.components.some(x=>x.status==='partial')?'partial':'done';if(job.status==='error')job.error='部分组件部署失败；已完成的组件保留，请查看逐项日志'},p,{queued:false,selection:components})
}
async function checkoutSource(job,destination,spec,entry,p,tools){
 inside(p.root,destination);inside(p.root,p.tmpDir)
 if(fs.existsSync(destination)&&fs.readdirSync(destination).length)throw new Error('源码目录非空但缺少入口，已保留；请检查后另选空目录重试')
 core.ensureDir(p.tmpDir);const stage=fs.mkdtempSync(path.join(p.tmpDir,'source-')),git=tools.tools.git
 for(const args of [['init',stage],['-C',stage,'remote','add','origin',spec.repository]]){
  step(job,'git '+args.filter(x=>x!==stage).join(' '));await checked(job,git,args,{env:tools.env})
 }
 await fetchPinnedCommit({stage,repository:spec.repository,commit:spec.commit,env:tools.env,step:s=>step(job,s),run:(file,args,opts)=>logged(job,git,args,opts)})
 await checked(job,git,['-C',stage,'checkout','--detach','FETCH_HEAD'],{env:tools.env})
 const head=await runCommand(git,['-C',stage,'rev-parse','HEAD'],{env:tools.env})
 if(!head.ok||head.stdout.trim()!==spec.commit||!fs.existsSync(path.join(stage,entry)))throw new Error('源码提交或入口校验失败，临时目录已保留')
 core.ensureDir(path.dirname(destination));if(fs.existsSync(destination))fs.rmdirSync(destination);await publishDirectory(stage,destination,{step:s=>step(job,s)})
}
