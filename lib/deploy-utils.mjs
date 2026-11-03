import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {execFile,spawn} from 'node:child_process'
import {StringDecoder} from 'node:string_decoder'
import {Readable,Transform} from 'node:stream'
import {pipeline} from 'node:stream/promises'

export function powershellArgs(command){
  return ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',"[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; $env:PSModulePath=(Join-Path $PSHOME 'Modules')+';'+$env:PSModulePath; $ErrorActionPreference='Stop'; "+command]
}
export const quotePS=value=>"'"+String(value).replace(/'/g,"''")+"'"
// Antivirus and recently exited Windows executables may briefly retain file handles.
// Retry only transient sharing/permission errors; never replace another directory.
export async function publishDirectory(source,target,{rename=fs.promises.rename,delay=ms=>new Promise(r=>setTimeout(r,ms)),step=()=>{}}={}){
  for(let attempt=0;;attempt++){
    try{return await rename(source,target)}catch(e){
      if(!['EPERM','EACCES','EBUSY'].includes(e.code)||attempt>=10)throw e
      if(attempt===0)step('等待 Windows 释放刚解压 / 运行的文件，然后重试发布目录…')
      await delay(Math.min(200*(attempt+1),1500))
    }
  }
}
export function commandError(file,result){
  const detail=(result.error||result.tail||result.stderr||result.stdout||'').trim().slice(-1600)
  if(result.code==='ENOENT')return `找不到部署工具 ${path.basename(file)}；工具准备未完成或工具路径已失效。${detail}`
  return `${path.basename(file)} 执行失败（${result.code??'启动错误'}）：${detail||'没有输出，请检查进程权限与网络'}`
}
export function runCommand(file,args,opts={}){
  return new Promise(resolve=>execFile(file,args,{windowsHide:true,maxBuffer:32*1024*1024,encoding:'utf8',timeout:opts.timeout||600000,cwd:opts.cwd,env:opts.env||process.env},
    (err,stdout,stderr)=>resolve({ok:!err,code:err?.code??0,error:err?.message,stdout:String(stdout||''),stderr:String(stderr||'')})))
}
// A separate decoder and line buffer per pipe preserves split UTF-8 characters.
export function lineSink(onLine){
  const decoder=new StringDecoder('utf8');let pending=''
  const flush=text=>{pending+=text;const lines=pending.split(/\r\n|[\r\n]/);pending=lines.pop();for(const s of lines)if(s.trim())onLine(s.trim())}
  return {write:chunk=>flush(decoder.write(chunk)),end:()=>{flush(decoder.end());if(pending.trim())onLine(pending.trim());pending=''}}
}
export function streamCommand(file,args,{step=()=>{},...opts}={}){
  return new Promise(resolve=>{
    let tail='',settled=false,timer
    const line=s=>{tail=(tail+'\n'+s).slice(-5000);step(s)}
    const out=lineSink(line),err=lineSink(line)
    const finish=r=>{if(settled)return;settled=true;clearTimeout(timer);resolve({...r,tail})}
    let child
    try{child=spawn(file,args,{windowsHide:true,cwd:opts.cwd,env:opts.env||process.env,stdio:['ignore','pipe','pipe']})}
    catch(e){finish({ok:false,code:e.code,error:e.message});return}
    timer=setTimeout(()=>{
      if(process.platform==='win32'&&child.pid)execFile('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true},()=>{})
      else child.kill()
      finish({ok:false,code:'ETIMEDOUT',error:'部署任务超时；请检查网络后重试'})
    },opts.timeout||1800000)
    child.stdout.on('data',out.write);child.stderr.on('data',err.write)
    child.on('error',e=>finish({ok:false,code:e.code,error:e.message}))
    child.on('close',code=>{out.end();err.end();finish({ok:code===0,code})})
  })
}
export async function sha256(file){
  const hash=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file))hash.update(chunk);return hash.digest('hex')
}
// Unique part files, bounded redirects/timeouts, complete stream handling, hash before publish.
export async function downloadChecked(url,dest,expected,{fetcher=fetch,timeout=900000,onProgress=()=>{},onRetry=()=>{}}={}){
  if(!/^[a-f0-9]{64}$/.test(expected))throw new Error('缺少固定 SHA256，未下载')
  fs.mkdirSync(path.dirname(dest),{recursive:true})
  if(fs.existsSync(dest)&&await sha256(dest)===expected)return dest
  const part=dest+'.'+crypto.randomUUID()+'.part'
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout)
  let idleTimer
  const touch=()=>{clearTimeout(idleTimer);idleTimer=setTimeout(()=>controller.abort(),60000)}
  try{
    let current=new URL(url),offset=0,total
    do{
      let res;touch()
      for(let n=0;n<=8;n++){
        for(let attempt=0;;attempt++){
          try{
            res=await fetcher(current.href,{redirect:'manual',signal:controller.signal,headers:{'user-agent':'dsh-qqbot-deploy','accept-encoding':'identity',Range:`bytes=${offset}-${offset+4*1024*1024-1}`}})
            if((res.status===429||res.status>=500)&&attempt<2){await res.body?.cancel();onRetry(attempt+1,'HTTP '+res.status);await new Promise(r=>setTimeout(r,250*(attempt+1)));continue}
            break
          }catch(e){
            if(controller.signal.aborted||attempt>=2)throw e
            onRetry(attempt+1,e.cause?.code||e.code||e.message);await new Promise(r=>setTimeout(r,250*(attempt+1)))
          }
        }
        if(![301,302,303,307,308].includes(res.status))break
        await res.body?.cancel();if(n===8)throw new Error('下载重定向次数过多')
        const next=new URL(res.headers.get('location'),current)
        if(current.protocol==='https:'&&next.protocol!=='https:')throw new Error('下载地址降级为非 HTTPS，已停止')
        current=next
      }
      if(!res.ok||!res.body)throw new Error('下载 HTTP '+res.status)
      const range=res.status===206?res.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/):null
      if(res.status===206&&(!range||Number(range[1])!==offset))throw new Error('下载分段范围不一致')
      if(offset&&res.status!==206)throw new Error('下载服务器未保持分段传输，已停止')
      await pipeline(Readable.fromWeb(res.body),new Transform({transform(chunk,encoding,done){touch();done(null,chunk)}}),fs.createWriteStream(part,{flags:offset?'a':'wx'}))
      const size=fs.statSync(part).size
      if(range){
        if(size!==Number(range[2])+1||Number(range[3])<=Number(range[2]))throw new Error('下载分段内容不完整')
        if(total!==undefined&&total!==Number(range[3]))throw new Error('下载过程中资源长度改变')
        total=Number(range[3]);offset=size
      }else{offset=size;total=size}
      onProgress(offset,total)
    }while(offset<total)
    const actual=await sha256(part)
    if(actual!==expected)throw new Error(`SHA256 校验失败：期望 ${expected}，实际 ${actual}；原文件未替换，请重试`)
    // Never truncate the destination while a different reader is using it.
    fs.renameSync(part,dest);return dest
  }catch(e){throw new Error(`下载失败（${new URL(url).hostname}）：${e.message}${e.cause?.code?' ['+e.cause.code+']':''}`,{cause:e})}
  finally{clearTimeout(timer);clearTimeout(idleTimer);try{fs.unlinkSync(part)}catch{}}
}

export function createScheduler(){
  const jobs=new Map(),active=new Map(),queues=new Map()
  function start(kind,root,fn,{queued=true,selection}={}){
    const key=path.resolve(root).toLowerCase()+'\0'+kind,prior=active.get(key)
    if(prior)return {id:prior.id,status:'running',reused:true}
    const job={id:kind+'-'+crypto.randomUUID(),kind,root,status:'running',steps:[],startedAt:Date.now(),selection};jobs.set(job.id,job);active.set(key,job)
    const execute=async()=>{try{await fn(job);if(job.status==='running')job.status='done'}catch(e){job.status='error';job.error=e.message;job.onError?.(e)}finally{active.delete(key)}return job}
    const rootKey=path.resolve(root).toLowerCase(),previous=queues.get(rootKey)||Promise.resolve()
    job.promise=queued?previous.catch(()=>{}).then(execute):Promise.resolve().then(execute)
    if(queued){queues.set(rootKey,job.promise);job.promise.finally(()=>{if(queues.get(rootKey)===job.promise)queues.delete(rootKey)})}
    return{id:job.id,status:'running',reused:false}
  }
  return {start,get:id=>jobs.get(id),view:id=>{const j=jobs.get(String(id||''));if(!j)return null;const{promise,onError,...view}=j;return view}}
}
