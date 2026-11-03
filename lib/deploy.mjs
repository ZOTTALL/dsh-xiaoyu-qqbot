// 一键部署：在部署根目录下安装/准备 NapCat、AstrBot、GPT-SoVITS 三个组件，以及对
// DSH ingress 做可用性检查（ingress 由 DSH 桌面端自带，不需要我们部署，只需确认它已启用）。
//
// 设计原则：
//   · 幂等——已经装好的组件直接跳过对应步骤，不会重复下载/覆盖用户数据；
//   · 全程落在 PATHS().root 之下，不改动系统任何其他位置；
//   · 每一步写进度日志（core.pushLog('console', ...)），面板的日志页能看到；
//   · 任何一步失败都不影响其它已完成的步骤，返回明确的错误原因；
//   · 不静默执行危险操作：下载来源、写入路径全部可在下方常量里审查。
import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import crypto from 'node:crypto'
const UPSTREAM=JSON.parse(fs.readFileSync(new URL('../tools/upstreams.json',import.meta.url),'utf8'))
import { spawn, execFile } from 'node:child_process'
import * as core from './core.mjs'
import { resolveNapcatVersionDir } from './config.mjs'
import {installBridge,installTemplates,INGRESS_SPEC,inside} from './bridge-install.mjs'
export {INGRESS_SPEC}
let ingressInstaller=null
export function setIngressInstaller(fn){ingressInstaller=fn}


const jobs = new Map()
function newJob(kind) {
  const id = `${kind}-${Date.now()}-${Math.random().toString(36).slice(2,8)}`
  const job = { id, kind, status: 'running', steps: [], startedAt: Date.now() }
  jobs.set(id, job)
  return job
}
function step(job, text, ok = true) {
  job.steps.push({ t: Date.now(), text, ok })
  core.pushLog('console', `[部署:${job.kind}] ${text}`)
}
export function getDeployJob(id) {
  const j = jobs.get(String(id || '')); if (!j) return null
  const { promise, ...view } = j; return view
}

function run(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8', timeout: opts.timeout || 600000, cwd: opts.cwd, env: { ...process.env, ...(opts.env || {}) } },
      (err, stdout, stderr) => resolve({ ok: !err, code: err?.code ?? 0, stdout: String(stdout || ''), stderr: String(stderr || '') }))
  })
}
function spawnLogged(job, file, args, opts = {}) {
  return new Promise((resolve) => {
    let settled=false
    const finish=result=>{if(settled)return;settled=true;clearTimeout(timeout);resolve(result)}
    const child = spawn(file, args, { windowsHide: true, cwd: opts.cwd, env: { ...process.env, ...(opts.env || {}) }, stdio: ['ignore', 'pipe', 'pipe'] })
    const timeout=setTimeout(()=>{child.kill();finish({ok:false,error:'部署任务超时'})},opts.timeout||1800000)
    let tail = ''
    const feed = (b) => { const s = b.toString('utf8'); tail = (tail + s).slice(-4000); for (const line of s.split(/\r?\n/)) if (line.trim()) step(job, line.trim()) }
    child.stdout.on('data', feed); child.stderr.on('data', feed)
    child.on('error', (e) => finish({ ok: false, error: e.message }))
    child.on('exit', (code) => finish({ ok: code === 0, code, tail }))
  })
}
function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest)
    const req = https.get(url, { headers: { 'user-agent': 'dsh-xiaoyu-qqbot-deploy' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close(); fs.unlinkSync(dest)
        return download(res.headers.location, dest).then(resolve, reject)
      }
      if (res.statusCode !== 200) { file.close(); fs.unlinkSync(dest); return reject(new Error(`HTTP ${res.statusCode} 下载 ${url}`)) }
      res.pipe(file)
      file.on('finish', () => file.close(() => resolve()))
    })
    req.on('error', (e) => { try { fs.unlinkSync(dest) } catch {} reject(e) })
  })
}

// ───────────── NapCat（OneKey 一体包） ─────────────
// 发行源：NapNeko/NapCat.Shell（官方发行仓库），一体包自带登录用的 QQ 协议客户端。
// 版本号写在 docs/DEPLOY.md，升级时同步改这里。
const NAPCAT_RELEASE_URL = UPSTREAM.napcat.url

export function isNapcatInstalled() {
  const p = core.PATHS()
  return fs.existsSync(p.napcatExe)
}
export async function deployNapcat() {
  const job = newJob('napcat')
  job.promise = (async () => {
    try {
      const p = core.PATHS()
      if (isNapcatInstalled()) { step(job, '已检测到 NapCat，跳过下载');job.status=core.PATHS().napcatConfigDir||!fs.existsSync(path.join(p.napcatDir,'NapCatInstaller.exe'))?'done':'partial';if(job.status==='partial')step(job,'请先运行 NapCatInstaller.exe 完成首次初始化');return job }
      core.ensureDir(p.napcatDir)
      const zip = path.join(p.tmpDir, 'NapCat.Shell.zip')
      core.ensureDir(p.tmpDir)
      step(job, `下载 NapCat：${NAPCAT_RELEASE_URL}`)
      await download(NAPCAT_RELEASE_URL, zip)
      if(crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex')!==UPSTREAM.napcat.sha256)throw new Error('NapCat SHA256 校验失败')
      step(job, '下载完成并通过 SHA256，解压中…')
      const r = await run('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -Force -LiteralPath '${zip.replace(/'/g,"''")}' -DestinationPath '${p.napcatDir.replace(/'/g,"''")}'`])
      if (!r.ok) throw new Error('解压失败：' + (r.stderr || r.stdout))
      try { fs.unlinkSync(zip) } catch {}
      if (!fs.existsSync(core.PATHS().napcatExe)) throw new Error(`解压后找不到 ${p.napcatExe}；NapCat 发行包结构可能变了，去 docs/DEPLOY.md 看手动安装步骤`)
      if(!core.PATHS().napcatConfigDir){step(job,'OneKey 启动器已准备；请运行部署目录内 NapCatInstaller.exe 完成 QQ / 协议初始化，然后再扫码。');job.status='partial'}else{step(job,'NapCat 安装完成，可启动并扫码');job.status='done'}
    } catch (e) { job.status = 'error'; job.error = e.message; step(job, '失败：' + e.message, false) }
    return job
  })()
  return { id: job.id, status: 'running' }
}

// ───────────── AstrBot（venv + pip） ─────────────
export function isAstrbotInstalled() {
  const p = core.PATHS()
  if(!fs.existsSync(p.astrbotPy)||!fs.existsSync(path.join(p.astrbotDir,'main.py')))return false
  const ready=path.join(p.astrbotDir,'.qqbot-env-ready.json'),started=path.join(p.astrbotDir,'.qqbot-env-started.json')
  if(fs.existsSync(ready))return true
  if(fs.existsSync(started))return false
  const site=path.join(path.dirname(p.astrbotPy),'..','Lib','site-packages')
  return ['quart','aiohttp','loguru','openai','anthropic','numpy','pandas'].every(name=>fs.existsSync(path.join(site,name)))
}
export async function deployAstrbot() {
  const job = newJob('astrbot')
  job.promise = (async () => {
    try {
      const p = core.PATHS()
      if (isAstrbotInstalled()) {
        const checked=await run(p.astrbotPy,[path.join(p.toolsDir,'check-astrbot-env.py'),p.astrbotDir])
        if(checked.ok){step(job,'AstrBot 依赖一致性检查通过，保留环境并检查桥接');await prepareBridge(job,p);job.status='done';return job}
        step(job,'检测到环境但依赖尚未完整，继续补装；不覆盖配置')
      }
      if(!fs.existsSync(path.join(p.astrbotDir,'main.py')))await checkoutSource(job,p.astrbotDir,UPSTREAM.astrbot,'main.py')
      step(job, '创建独立 Python '+UPSTREAM.astrbot.python+' 虚拟环境 .venv（需要 uv）…')
      if(!fs.existsSync(p.astrbotPy)){
        const venv=await spawnLogged(job,'uv',['venv','--python',UPSTREAM.astrbot.python,'--managed-python','.venv'],{cwd:p.astrbotDir})
        if(!venv.ok)throw new Error('创建环境失败；先安装 uv，再重试')
      }
      core.writeJson(path.join(p.astrbotDir,'.qqbot-env-started.json'),{commit:UPSTREAM.astrbot.commit})
      step(job,'从固定上游 pyproject.toml 安装依赖（不是已移除的 requirements.txt）…')
      const install=await spawnLogged(job,'uv',['pip','install','--system-certs','--python',p.astrbotPy,'-r','pyproject.toml'],{cwd:p.astrbotDir,timeout:1800000,env:{UV_HTTP_TIMEOUT:'30',UV_HTTP_RETRIES:'2',UV_LINK_MODE:'copy'}})
      if(!install.ok)throw new Error('AstrBot 依赖安装失败，见日志；已有数据未覆盖')
      const checked=await run(p.astrbotPy,[path.join(p.toolsDir,'check-astrbot-env.py'),p.astrbotDir])
      if(!checked.ok)throw new Error('AstrBot 依赖一致性检查未通过：'+checked.stdout.trim())
      core.writeJson(path.join(p.astrbotDir,'.qqbot-env-ready.json'),{commit:UPSTREAM.astrbot.commit,installedAt:new Date().toISOString()})
      await prepareBridge(job,p)
      step(job, 'AstrBot 安装完成。去“总览”启动它，首次启动会在 WebUI(6185) 里完成初始化。')
      job.status = 'done'
    } catch (e) { job.status = 'error'; job.error = e.message; step(job, '失败：' + e.message, false) }
    return job
  })()
  return { id: job.id, status: 'running' }
}

// ───────────── GPT-SoVITS ─────────────
export function isTtsInstalled() {
  const p = core.PATHS()
  return fs.existsSync(path.join(p.voiceDir, 'api_v2.py'))
}
export async function deployTts() {
  const job = newJob('tts')
  job.promise = (async () => {
    try {
      const p = core.PATHS()
      if (isTtsInstalled()) { step(job, '已检测到 GPT-SoVITS，跳过安装'); job.status = 'done'; return job }
      if(!fs.existsSync(path.join(p.voiceDir,'api_v2.py')))await checkoutSource(job,p.voiceDir,UPSTREAM.tts,'api_v2.py')
      step(job, '安装完成的仓库还需要：预训练模型权重、独立 Python 环境（建议 conda）与依赖。')
      step(job, '这几步体积大且因显卡/系统差异很大，不在面板里自动做；请按官方仓库 README 的 install.sh / 一键包 完成后，在“设置”里填 GPT-SoVITS 的 Python 路径。')
      job.status = 'partial'
    } catch (e) { job.status = 'error'; job.error = e.message; step(job, '失败：' + e.message, false) }
    return job
  })()
  return { id: job.id, status: 'running' }
}

// ───────────── DSH ingress（由 DSH 桌面端自带，这里只做检查+指引） ─────────────
export async function checkIngress() {
  try {
    const r = await fetch(`http://127.0.0.1:${core.PORTS().ingress}/health`, { signal: AbortSignal.timeout(3000) })
    if (r.ok) { const j = await r.json(); return { ok: true, detail: j } }
    return { ok: false, hint: `/health 返回 ${r.status}` }
  } catch {
    return { ok: false, hint: '连不上 ingress：确认 DSH 桌面端已打开，且 profile 里启用了 dsh-astrbot-ingress 插件' }
  }
}

export function groupedDeployStatus() {
  return {
    napcat: isNapcatInstalled(),
    astrbot: isAstrbotInstalled(),
    tts: isTtsInstalled(),
    bridge:fs.existsSync(core.PATHS().astrbotPluginMain),
  }
}


async function prepareBridge(job,p){
  const result=await installBridge({root:p.root,pluginDir:path.dirname(p.astrbotPluginMain),python:p.astrbotPy,tmpDir:p.tmpDir,step:text=>step(job,text)})
  job.bridge=result
  const templates=installTemplates({workspace:p.workspace});step(job,`占位工作区：新增 ${templates.created}，保留 ${templates.preserved} 个现有文件`)
  return result
}
function background(kind,fn){
  const running=[...jobs.values()].find(j=>j.kind===kind&&j.status==='running')
  if(running)return {id:running.id,status:'running'}
  const job=newJob(kind);job.promise=(async()=>{try{await fn(job);if(job.status==='running')job.status='done'}catch(e){job.status='error';job.error=e.message;step(job,'失败：'+e.message,false)}return job})();return{id:job.id,status:'running'}
}
export async function deployBridge(){return background('bridge',async job=>{const p=core.PATHS();if(!isAstrbotInstalled())throw new Error('先部署 AstrBot，再补装桥接');await prepareBridge(job,p)})}
export async function deployMemory(){return background('memory',async job=>{const p=core.PATHS();inside(p.root,path.join(p.root,'memory-runtime'));step(job,'创建本机 CPU 向量环境、下载固定校验和的公开模型，不上传记忆原文');const r=await spawnLogged(job,'powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(p.toolsDir,'setup-memory.ps1'),'-Root',p.root,'-Workspace',p.workspace]);if(!r.ok)throw new Error('向量环境部署失败，见部署日志');step(job,'本地向量环境已配置，下次检索自动加载')})}
export async function deployIngress(){return background('ingress',async job=>{
  const health=await checkIngress();if(health.ok){step(job,'DSH ingress 已在线，保留现有安装');job.health=health;return}
  if(!ingressInstaller)throw new Error('当前宿主未提供 pluginManager.installBundle；请在 DSH 插件页安装 tools/upstreams.json 中的 dsh-astrbot-ingress，再重启宿主')
  step(job,'通过 DSH 官方插件管理器安装 '+INGRESS_SPEC);const r=await ingressInstaller();job.installation={application:r.application,version:r.version,enabled:r.enabled}
  if(r.error?.code==='already-installed'){job.status='partial';step(job,'ingress 已安装，请在 DSH 插件页启用它并检查端口');return}
  if(r.error||r.packageResult?.exitCode||['failed','cancelled'].includes(r.application))throw new Error(r.error?.diagnostic||r.error?.code||'DSH ingress 安装失败')
  job.health=await checkIngress();if(!job.health.ok){job.status='partial';step(job,'安装请求已保存；按 DSH 提示重启/启用 ingress 后再检测端口')}else step(job,'DSH ingress 已在线')
})}
export async function deployAll(components=['astrbot','napcat','tts','ingress']){
  if(!Array.isArray(components)||!components.length||components.some(x=>!['astrbot','napcat','tts','ingress','bridge','memory'].includes(x)))throw new Error('部署组件列表无效')
  return background('all',async job=>{job.components=[];for(const target of [...new Set(components)]){const task=await({astrbot:deployAstrbot,napcat:deployNapcat,tts:deployTts,ingress:deployIngress,bridge:deployBridge,memory:deployMemory}[target])();let child=jobs.get(task.id);await child.promise;job.components.push({target,status:child.status,error:child.error});step(job,target+'：'+child.status,child.status!=='error')}job.status=job.components.some(x=>x.status==='error')?'error':job.components.some(x=>x.status==='partial')?'partial':'done';if(job.status==='error')job.error='部分组件部署失败；已完成的组件保留，请查看逐项日志'})
}

async function checkoutSource(job,destination,spec,entry){
 const p=core.PATHS();inside(p.root,destination);inside(p.root,p.tmpDir)
 if(fs.existsSync(destination)&&fs.readdirSync(destination).length)throw new Error('源码目录非空但缺少入口，已保留；请检查后另选空目录重试')
 core.ensureDir(p.tmpDir);const stage=fs.mkdtempSync(path.join(p.tmpDir,'source-'))
 for(const [file,args] of [['git',['init',stage]],['git',['-C',stage,'remote','add','origin',spec.repository]],['git',['-C',stage,'fetch','--depth','1','origin',spec.commit]],['git',['-C',stage,'checkout','--detach','FETCH_HEAD']]]){
  step(job,file+' '+args.filter(x=>x!==stage).join(' '));const r=await spawnLogged(job,file,args,{timeout:600000});if(!r.ok)throw new Error('固定上游源码获取失败；临时目录已保留')
 }
 const head=await run('git',['-C',stage,'rev-parse','HEAD']);if(!head.ok||head.stdout.trim()!==spec.commit||!fs.existsSync(path.join(stage,entry)))throw new Error('源码提交或入口校验失败')
 core.ensureDir(path.dirname(destination));if(fs.existsSync(destination))fs.rmdirSync(destination);fs.renameSync(stage,destination)
}
