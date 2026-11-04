import fs from 'node:fs'
import path from 'node:path'
import {downloadChecked,sha256,commandError} from './deploy-utils.mjs'
export const sourcePolicy=JSON.parse(fs.readFileSync(new URL('../tools/download-sources.json',import.meta.url),'utf8'))
export function publicUrl(value){
  const u=new URL(value)
  if(u.protocol!=='https:'&&!(u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname)))throw new Error('下载源必须使用 HTTPS')
  if(u.username||u.password||[...u.searchParams.keys()].some(k=>/^(?:token|access_token|api_key|authorization)$/i.test(k)))throw new Error('公开下载源不接受凭据')
  return u
}
export function downloadSources(url){
  const u=publicUrl(url),mirrors=[]
  if(u.hostname==='github.com'){
    const match=u.pathname.match(/^\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\/(.+)$/)
    if(match){
      if(sourcePolicy.githubReleases.repositories.includes(match[1]))mirrors.push({name:'国内中科大 Release 镜像',url:sourcePolicy.githubReleases.university+match[1]+'/'+match[2]+'/'+match[3]})
      mirrors.push({name:'GitHub 文件加速',url:sourcePolicy.githubReleases.proxy+u.href})
    }
  }else if(u.hostname==='huggingface.co')for(const m of sourcePolicy.huggingface)mirrors.push({name:m.name,url:m.base+u.pathname+u.search})
  return [...mirrors,{name:'官方源',url:u.href,official:true}]
}
export function gitSources(repository){
  const u=publicUrl(repository)
  if(u.hostname!=='github.com'||!/^\/[^/]+\/[^/]+(?:\.git)?$/.test(u.pathname)||u.search||u.hash)throw new Error('源码只接受固定的公开 GitHub 仓库')
  const repo=u.pathname.slice(1).replace(/\.git$/,'')+'.git'
  return [...sourcePolicy.git.map(m=>({name:m.name,url:m.prefix+repo})),{name:'官方 GitHub',url:u.href,official:true}]
}
export function publicDownloadEnv(env=process.env){
  const out={...env}
  for(const key of Object.keys(out))if(/TOKEN|SECRET|PASSWORD|CREDENTIAL|API.?KEY|AUTHORIZATION/i.test(key)||/^(?:GIT_CONFIG|GIT_ASKPASS|SSH_ASKPASS|UV_(?:INDEX|DEFAULT_INDEX|EXTRA_INDEX|FIND_LINKS|PYTHON_INSTALL_MIRROR|ASTRAL_MIRROR_URL)|PIP_(?:INDEX|EXTRA_INDEX|TRUSTED_HOST))/i.test(key))delete out[key]
  out.GIT_TERMINAL_PROMPT='0';out.GCM_INTERACTIVE='never';out.UV_NO_CONFIG='1';out.UV_KEYRING_PROVIDER='disabled';out.PIP_CONFIG_FILE=process.platform==='win32'?'NUL':'/dev/null'
  return out
}
export async function downloadResource(url,dest,expected,options={}){
  const {step=()=>{},sources=downloadSources(url),download=downloadChecked,...rest}=options
  if(fs.existsSync(dest)&&await sha256(dest)===expected){step('命中已校验的本地下载缓存');return dest}
  const failures=[]
  for(const source of sources){
    publicUrl(source.url);step('尝试'+source.name+'：'+source.url)
    try{
      await download(source.url,dest,expected,{...rest,timeout:rest.timeout||(source.official?sourcePolicy.timeouts.officialDownloadMs:sourcePolicy.timeouts.mirrorDownloadMs),onRedirect:(from,to)=>{
        rest.onRedirect?.(from,to)
        const a=new URL(from).hostname,b=new URL(to).hostname
        if(a!==b)step(`下载重定向：${a} → ${b}`)
        if(!source.official&&['github.com','huggingface.co'].includes(b))throw new Error('镜像未命中并转回官方站，先尝试剩余镜像')
      }})
      step(source.name+'下载完成，SHA256 校验通过');return dest
    }catch(e){failures.push(source.name+'：'+e.message);step(source.name+'不可用或内容校验失败，保留原文件并切换下一来源：'+e.message)}
  }
  throw new Error('所有下载源均失败：'+failures.join('；'))
}
// Never send GitHub/HF/application credentials or user git extraHeaders to mirrors.
export function publicGitEnv(directory,env=process.env){
  const out=publicDownloadEnv(env),file=path.join(directory,'.qqbot-public-gitconfig')
  fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(file,'')
  out.GIT_CONFIG_GLOBAL=file;out.GIT_CONFIG_NOSYSTEM='1'
  out.GIT_CONFIG_COUNT='2';out.GIT_CONFIG_KEY_0='credential.helper';out.GIT_CONFIG_VALUE_0='';out.GIT_CONFIG_KEY_1='http.extraHeader';out.GIT_CONFIG_VALUE_1=''
  return out
}
export async function fetchPinnedCommit({stage,repository,commit,run,env=process.env,step=()=>{},sources=gitSources(repository)}){
  if(!/^[a-f0-9]{40}$/.test(commit))throw new Error('源码必须固定完整提交')
  const failures=[],safeEnv=publicGitEnv(stage,env)
  for(const source of sources){
    publicUrl(source.url);step('尝试'+source.name+'：'+source.url+' @ '+commit)
    try{
      let r=await run('git',['-C',stage,'remote','set-url','origin',source.url],{env:safeEnv})
      if(!r.ok)throw new Error(commandError('git',r))
      r=await run('git',['-c','http.version=HTTP/1.1','-C',stage,'fetch','--progress','--depth','1','origin',commit],{env:safeEnv,timeout:source.official?sourcePolicy.timeouts.gitOfficialMs:sourcePolicy.timeouts.gitMirrorMs,idleTimeout:sourcePolicy.timeouts.gitIdleMs})
      if(!r.ok)throw new Error(commandError('git',r))
      const head=await run('git',['-C',stage,'rev-parse','FETCH_HEAD'],{env:safeEnv})
      if(!head.ok||head.stdout.trim()!==commit)throw new Error('返回的源码提交不匹配')
      const reset=await run('git',['-C',stage,'remote','set-url','origin',repository],{env:safeEnv})
      if(!reset.ok)throw new Error(commandError('git',reset))
      step(source.name+'源码提交校验通过');return source
    }catch(e){failures.push(source.name+'：'+e.message);step(source.name+'失败，切换下一来源：'+e.message)}
  }
  throw new Error('固定源码全部来源均失败；暂存目录已保留：'+failures.join('；'))
}
export async function installBundleFromSources(installer,spec,{step=()=>{},sources=sourcePolicy.npm}={}){
  let last
  for(const source of sources){
    step('尝试'+source.name+'安装本地插件包')
    try{
      const r=await installer(spec,{registry:source.url})
      if(!r.error&&!r.packageResult?.exitCode&&!['failed','cancelled'].includes(r.application))return r
      if(r.error?.code==='already-installed')return r
      last=r;step(source.name+'安装未完成，切换下一源：'+(r.error?.code||r.packageResult?.exitCode||r.application))
    }catch(e){last={application:'failed',error:{code:'source-error',diagnostic:e.message}};step(source.name+'失败，切换下一源：'+e.message)}
  }
  return last
}
export async function pipPackages(python,args,{run,env=process.env,step=()=>{},sources=sourcePolicy.pypi}={}){
  const failures=[]
  for(const source of sources){
    step('尝试'+source.name+'安装桥接 Python 依赖')
    try{
      const r=await run(python,[...args,'--disable-pip-version-check','--no-input','--index-url',source.url],{env:publicDownloadEnv(env),timeout:source.official?sourcePolicy.timeouts.pypiOfficialMs:sourcePolicy.timeouts.pypiMirrorMs})
      if(!r.ok)throw new Error(commandError(python,r))
      return r
    }catch(e){failures.push(source.name+'：'+e.message);step(source.name+'失败，切换下一源：'+e.message)}
  }
  throw new Error('桥接依赖全部来源均失败：'+failures.join('；'))
}
