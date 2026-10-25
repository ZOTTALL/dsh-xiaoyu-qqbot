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
import { spawn, execFile } from 'node:child_process'
import * as core from './core.mjs'
import { resolveNapcatVersionDir } from './config.mjs'

const jobs = new Map()
function newJob(kind) {
  const id = `${kind}-${Date.now()}`
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
    const child = spawn(file, args, { windowsHide: true, cwd: opts.cwd, env: { ...process.env, ...(opts.env || {}) }, stdio: ['ignore', 'pipe', 'pipe'] })
    let tail = ''
    const feed = (b) => { const s = b.toString('utf8'); tail = (tail + s).slice(-4000); for (const line of s.split(/\r?\n/)) if (line.trim()) step(job, line.trim()) }
    child.stdout.on('data', feed); child.stderr.on('data', feed)
    child.on('error', (e) => resolve({ ok: false, error: e.message }))
    child.on('exit', (code) => resolve({ ok: code === 0, code, tail }))
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
const NAPCAT_RELEASE_URL = 'https://github.com/NapNeko/NapCatQQ/releases/latest/download/NapCat.Shell.zip'

export function isNapcatInstalled() {
  const p = core.PATHS()
  return fs.existsSync(p.napcatExe)
}
export async function deployNapcat() {
  const job = newJob('napcat')
  job.promise = (async () => {
    try {
      const p = core.PATHS()
      if (isNapcatInstalled()) { step(job, '已检测到 NapCat，跳过下载'); job.status = 'done'; return job }
      core.ensureDir(p.napcatDir)
      const zip = path.join(p.tmpDir, 'NapCat.Shell.zip')
      core.ensureDir(p.tmpDir)
      step(job, `下载 NapCat：${NAPCAT_RELEASE_URL}`)
      await download(NAPCAT_RELEASE_URL, zip)
      step(job, '下载完成，解压中…')
      const r = await run('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -Force -Path '${zip}' -DestinationPath '${p.napcatDir}'`])
      if (!r.ok) throw new Error('解压失败：' + (r.stderr || r.stdout))
      try { fs.unlinkSync(zip) } catch {}
      if (!fs.existsSync(p.napcatExe)) throw new Error(`解压后找不到 ${p.napcatExe}；NapCat 发行包结构可能变了，去 docs/DEPLOY.md 看手动安装步骤`)
      step(job, 'NapCat 安装完成。去“登录 / 二维码”页启动并扫码。')
      job.status = 'done'
    } catch (e) { job.status = 'error'; job.error = e.message; step(job, '失败：' + e.message, false) }
    return job
  })()
  return { id: job.id, status: 'running' }
}

// ───────────── AstrBot（venv + pip） ─────────────
export function isAstrbotInstalled() {
  const p = core.PATHS()
  return fs.existsSync(p.astrbotPy) && fs.existsSync(path.join(p.astrbotDir, 'main.py'))
}
export async function deployAstrbot() {
  const job = newJob('astrbot')
  job.promise = (async () => {
    try {
      const p = core.PATHS()
      if (isAstrbotInstalled()) { step(job, '已检测到 AstrBot，跳过安装'); job.status = 'done'; return job }
      core.ensureDir(p.astrbotDir)
      if (!fs.existsSync(path.join(p.astrbotDir, 'main.py'))) {
        step(job, '克隆 AstrBot（Soulter/AstrBot）…')
        const clone = await spawnLogged(job, 'git', ['clone', '--depth', '1', 'https://github.com/Soulter/AstrBot.git', '.'], { cwd: p.astrbotDir })
        if (!clone.ok) throw new Error('git clone 失败，确认已安装 git 且能访问 GitHub')
      }
      step(job, '创建虚拟环境 .venv…')
      const venv = await spawnLogged(job, 'python', ['-m', 'venv', '.venv'], { cwd: p.astrbotDir })
      if (!venv.ok) throw new Error('创建 venv 失败，确认系统已安装 Python 3.10+')
      const pip = path.join(p.astrbotDir, '.venv', 'Scripts', 'pip.exe')
      step(job, '安装依赖（requirements.txt，可能需要几分钟）…')
      const install = await spawnLogged(job, pip, ['install', '-r', 'requirements.txt'], { cwd: p.astrbotDir, timeout: 1800000 })
      if (!install.ok) throw new Error('pip install 失败，见上方日志')
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
      core.ensureDir(path.dirname(p.voiceDir))
      if (!fs.existsSync(path.join(p.voiceDir, 'api_v2.py'))) {
        step(job, '克隆 GPT-SoVITS（RVC-Boss/GPT-SoVITS）…')
        const clone = await spawnLogged(job, 'git', ['clone', '--depth', '1', 'https://github.com/RVC-Boss/GPT-SoVITS.git', path.basename(p.voiceDir)], { cwd: path.dirname(p.voiceDir) })
        if (!clone.ok) throw new Error('git clone 失败，确认已安装 git 且能访问 GitHub')
      }
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
  }
}
