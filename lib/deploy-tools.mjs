import fs from 'node:fs'
import path from 'node:path'
import {inside} from './bridge-install.mjs'
import {runCommand,powershellArgs,quotePS,commandError,publishDirectory} from './deploy-utils.mjs'
import {downloadResource,publicDownloadEnv} from './download-sources.mjs'
const manifest=JSON.parse(fs.readFileSync(new URL('../tools/bootstrap-tools.manifest.json',import.meta.url),'utf8'))
const inflight=new Map()
export async function ensureTools({root,names=['git','uv'],env=process.env,platform=process.platform,arch=process.arch,step=()=>{},run=runCommand,download=downloadResource}={}){
  root=path.resolve(root)
  const result={env:{...publicDownloadEnv(env),PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8',GIT_TERMINAL_PROMPT:'0',UV_LINK_MODE:'copy',UV_HTTP_TIMEOUT:'20',UV_HTTP_RETRIES:'0'},tools:{}}
  const envPathKey=Object.keys(result.env).find(k=>k.toLowerCase()==='path')||'PATH'
  for(const name of [...new Set(names)]){
    if(!Object.hasOwn(manifest,name))throw new Error('未知部署工具：'+name)
    const system=await run(name,['--version'],{env:result.env,timeout:15000})
    const uvVersion=system.stdout?.match(/^uv (\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number)
    const compatible=name!=='uv'||(uvVersion&&(uvVersion[0]>0||uvVersion[1]>13||(uvVersion[1]===13&&uvVersion[2]>=7)))
    if(system.ok&&compatible){result.tools[name]=name;step(`${name} 已可用：${system.stdout.trim().split('\n')[0]}`);continue}
    if(system.ok&&!compatible)step('现有 uv 版本较旧，改用固定便携 uv，不修改系统安装')
    if(platform!=='win32'||!manifest[name][arch])throw new Error(`当前 ${platform}/${arch} 未提供便携 ${name}；请安装该工具后重试`)
    const base=inside(root,path.join(root,'.deploy-tools')),lock=manifest[name],spec=lock[arch]
    inside(root,path.join(base,'cache'));inside(root,path.join(base,'staging'))
    const target=inside(root,path.join(base,`${name}-${lock.version}-${arch}`)),exe=inside(root,path.join(target,spec.executable))
    const key=target
    if(!inflight.has(key)){
      const task=(async()=>{
        if(fs.existsSync(exe)){
          const checked=await run(exe,['--version'],{env:result.env,timeout:15000})
          if(checked.ok){step(`复用部署目录内的便携 ${name}`);return exe}
          throw new Error(`便携 ${name} 存在但启动失败：`+commandError(exe,checked))
        }
        if(fs.existsSync(target))throw new Error(`便携 ${name} 目录不完整，已保留，请检查 ${target}`)
        fs.mkdirSync(path.join(base,'staging'),{recursive:true})
        const stage=fs.mkdtempSync(path.join(base,'staging',name+'-'))
        const zip=path.join(base,'cache',`${name}-${lock.version}-${arch}.zip`)
        step(`自动准备便携 ${name} ${lock.version}：${spec.url}（SHA256 校验，不改系统 PATH）`)
        await download(spec.url,zip,spec.sha256,{step,onProgress:(done,total)=>step(`下载 ${name}：${(done/1048576).toFixed(1)} / ${(total/1048576).toFixed(1)} MiB`),onRetry:(n,why)=>step(`${name} 下载临时错误 ${why}，第 ${n} 次重试`)})
        const ps=path.join(env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe')
        const extracted=await run(ps,powershellArgs(`Expand-Archive -LiteralPath ${quotePS(zip)} -DestinationPath ${quotePS(stage)} -Force`),{env:result.env,timeout:180000})
        if(!extracted.ok)throw new Error('便携工具解压失败：'+commandError(ps,extracted))
        const stagedExe=path.join(stage,spec.executable)
        if(!fs.existsSync(stagedExe))throw new Error(`便携 ${name} 压缩包结构不匹配，临时目录已保留`)
        const checked=await run(stagedExe,['--version'],{env:result.env,timeout:15000})
        if(!checked.ok)throw new Error(commandError(stagedExe,checked))
        fs.writeFileSync(path.join(stage,'.qqbot-tool.json'),JSON.stringify({url:spec.url,sha256:spec.sha256,version:lock.version}))
        await publishDirectory(stage,target,{step});step(`便携 ${name} 已就绪：${checked.stdout.trim().split('\n')[0]}`);return exe
      })()
      inflight.set(key,task);task.finally(()=>{if(inflight.get(key)===task)inflight.delete(key)}).catch(()=>{})
    }
    result.tools[name]=await inflight.get(key)
    result.env[envPathKey]=path.dirname(result.tools[name])+path.delimiter+(result.env[envPathKey]||'')
  }
  // These child-only locations keep managed Python/cache in the deployment root.
  result.env.UV_CACHE_DIR=inside(root,path.join(root,'.deploy-tools','uv-cache'))
  result.env.UV_PYTHON_INSTALL_DIR=inside(root,path.join(root,'.deploy-tools','python'))
  return result
}
