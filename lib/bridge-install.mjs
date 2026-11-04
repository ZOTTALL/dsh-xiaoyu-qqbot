// Download the upstream bridge, never the maintainer's private patched installation.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {fetchPinnedCommit,pipPackages} from './download-sources.mjs'
import {streamCommand as runCommand} from './deploy-utils.mjs'
export {streamCommand as runCommand} from './deploy-utils.mjs'
const lock=JSON.parse(fs.readFileSync(new URL('../tools/upstreams.json',import.meta.url),'utf8'))
export const BRIDGE=lock.astrbotBridge
export const INGRESS_SPEC=lock.dshIngress.spec

export function inside(root,target){
  const rel=path.relative(path.resolve(root),path.resolve(target))
  if(!rel||rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw new Error('部署目标必须是部署根目录内的子目录')
  let current=path.resolve(target)
  while(current!==path.resolve(root)){if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw new Error('部署路径包含符号链接');current=path.dirname(current)}
  return path.resolve(target)
}
export async function installBridge({root,pluginDir,python,tmpDir,run=runCommand,step=()=>{},installRequirements}){
  const dest=inside(root,pluginDir),tmp=inside(root,tmpDir||path.join(root,'tmp'))
  if(fs.existsSync(dest)){
    if(!fs.existsSync(path.join(dest,'main.py')))throw new Error('桥接目录已存在但不完整；请手动检查或移走后重试，原目录未覆盖')
    step('检测到已有 astrbot_plugin_dsh，保留代码与配置，不覆盖')
    return {installed:true,skipped:true,preserved:true,needsReload:true,path:dest}
  }
  fs.mkdirSync(tmp,{recursive:true});const stage=path.join(tmp,'bridge-'+crypto.randomUUID());fs.mkdirSync(stage)
  async function exec(file,args,options={}){const r=await run(file,args,options);if(!r.ok)throw new Error(file+' 执行失败：'+(r.stderr||r.stdout).slice(-1000));return r.stdout.trim()}
  // Stage on the same deployment volume. Publish only after checkout + manifest + dependencies succeed.
  step('从 GitHub 获取官方 DSH 桥接：'+BRIDGE.repository+' @ '+BRIDGE.commit)
  await exec('git',['init',stage])
  await exec('git',['-C',stage,'remote','add','origin',BRIDGE.repository])
  await fetchPinnedCommit({stage,repository:BRIDGE.repository,commit:BRIDGE.commit,run,step})
  await exec('git',['-C',stage,'checkout','--detach','FETCH_HEAD'])
  const actual=await exec('git',['-C',stage,'rev-parse','HEAD'])
  if(actual!==BRIDGE.commit)throw new Error('桥接提交校验失败')
  for(const name of ['main.py','metadata.yaml'])if(!fs.existsSync(path.join(stage,name)))throw new Error('上游桥接缺少 '+name)
  const requirements=path.join(stage,'requirements.txt')
  if(fs.existsSync(requirements)){
    if(!python||!fs.existsSync(python))throw new Error('先部署 AstrBot 的 Python 环境，再安装桥接依赖')
    step('在 AstrBot 虚拟环境安装桥接 requirements.txt')
    if(installRequirements)await installRequirements(requirements)
    else await pipPackages(python,['-m','pip','install','-r',requirements],{run,step})
  }
  fs.mkdirSync(path.dirname(dest),{recursive:true})
  if(fs.existsSync(dest))throw new Error('安装期间目标目录被创建，已保留双方目录，请检查后重试')
  fs.renameSync(stage,dest)
  fs.writeFileSync(path.join(dest,'.qqbot-upstream.json'),JSON.stringify({repository:BRIDGE.repository,commit:actual,installedAt:new Date().toISOString()},null,2))
  step('官方桥接已安装；AstrBot 已运行时请在 WebUI 重载插件，未启动时随下次启动加载')
  return {installed:true,skipped:false,preserved:true,needsReload:true,commit:actual,path:dest}
}
export function installTemplates({workspace,templates=fileURLToPath(new URL('../persona-template',import.meta.url))}){
  let created=0,preserved=0
  function visit(source,relative=''){
    for(const e of fs.readdirSync(source,{withFileTypes:true})){
      if(e.isSymbolicLink())continue
      const rel=path.join(relative,e.name),src=path.join(source,e.name)
      if(e.isDirectory()){visit(src,rel);continue}
      if(!e.isFile())continue
      const dst=path.join(workspace,rel.endsWith('.example')?rel.slice(0,-8):rel)
      if(fs.existsSync(dst)){preserved++;continue}
      // Do not traverse user-created links while initializing example files.
      let parent=path.dirname(dst);while(parent!==path.dirname(workspace)){if(fs.existsSync(parent)&&fs.lstatSync(parent).isSymbolicLink())throw new Error('工作区模板路径包含符号链接');if(parent===workspace)break;parent=path.dirname(parent)}
      fs.mkdirSync(path.dirname(dst),{recursive:true});fs.copyFileSync(src,dst,fs.constants.COPYFILE_EXCL);created++
    }
  }
  visit(templates);return {created,preserved}
}
