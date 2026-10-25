// dsh-xiaoyu-qqbot 核心：与 DSH 无关的纯 Node 逻辑（进程、端口、NapCat 日志/二维码、文件与工具封装）。
// 全部用 child_process + fs + fetch，无第三方依赖，方便单测。所有路径/端口/QQ号都来自 config.mjs，
// 不在本文件写死任何部署特定的值。
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import os from 'node:os'
import { spawn, execFile } from 'node:child_process'
import * as config from './config.mjs'

export function PATHS() { return config.resolvePaths() }
export function PORTS() { return config.ports() }
export function OWNER_QQ() { return config.ownerQq() }
export function BOT_QQ() { return config.botQq() }

const MAX_LOG_LINES = 400
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g
const BLOCK_ONLY = /^[\s█▄▀▌▐░▒▓]+$/

export function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); return p }
export function readJson(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) } catch { return fallback }
}
export function writeJson(p, v) {
  ensureDir(path.dirname(p))
  const tmp = p + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2), 'utf8')
  fs.renameSync(tmp, p)
}
const now = () => Date.now()

// ───────────── 配置（守护开关等） ─────────────
export function loadConfig() {
  const c = config.loadRawConfig({ fresh: true })
  return { watchdog: c.watchdog, autostart: c.autostart }
}
export function saveConfig(patch) {
  config.saveRawConfig(patch)
  return loadConfig()
}

// ───────────── 端口 / HTTP ─────────────
export function portOpen(port, host = '127.0.0.1', timeout = 700) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host })
    const done = (v) => { try { s.destroy() } catch {} resolve(v) }
    s.setTimeout(timeout, () => done(false))
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
}

export async function onebot(action, params = {}, timeout = 8000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeout)
  try {
    const r = await fetch(`http://127.0.0.1:${PORTS().napcatHttp}/${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(params), signal: ctrl.signal,
    })
    return await r.json()
  } finally { clearTimeout(t) }
}

// ───────────── 进程发现 / 启停 ─────────────
function psJson(script, timeout = 15000) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`],
    { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
    (err, stdout) => {
      if (err && !stdout) return resolve(null)
      const txt = String(stdout || '').trim()
      if (!txt) return resolve([])
      try { const v = JSON.parse(txt); resolve(Array.isArray(v) ? v : [v]) } catch { resolve(null) }
    })
  })
}

/** 列出本 BOT 相关进程（只认部署根目录下的路径，绝不碰用户主 QQ 或其他无关进程）。
 *
 * 命令行里的脚本名（api_v2.py / astrbot-src...main.py）只是辅助信号，用来兜底
 * ExecutablePath 为空的场景（比如用 "python.exe" 启动，看不出是不是本插件的）；
 * 但这个信号必须同时要求命令行里出现本插件的部署根目录，否则会误抓到系统里
 * 其他与本插件完全无关的 AstrBot/GPT-SoVITS 进程，进而被 stop* 误杀。 */
export async function listProcesses() {
  const rootEsc = PATHS().root.replace(/'/g, "''")
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${rootEsc}\\*' -or (($_.CommandLine -like '*api_v2.py*' -or $_.CommandLine -like '*astrbot-src*main.py*') -and $_.CommandLine -like '*${rootEsc}*') } | Select-Object ProcessId,Name,ExecutablePath,@{n='cmd';e={ if($_.CommandLine){ $_.CommandLine.Substring(0,[Math]::Min(200,$_.CommandLine.Length)) } }},@{n='started';e={ if($_.CreationDate){ $_.CreationDate.ToString('o') } }} | ConvertTo-Json -Compress -Depth 3`
  return (await psJson(script)) || []
}

function classify(p) {
  const exe = String(p.ExecutablePath || '').toLowerCase()
  const cmd = String(p.cmd || '').toLowerCase()
  if (exe.includes('\\onekey\\')) return 'napcat'
  if (cmd.includes('api_v2.py')) return 'tts'
  if (exe.includes('astrbot-src\\.venv') || cmd.includes('astrbot-src')) return 'astrbot'
  return null
}

const procCache = { at: 0, val: null }
export async function groupedProcesses(fresh = false) {
  if (!fresh && procCache.val && now() - procCache.at < 2500) return procCache.val
  const out = { napcat: [], astrbot: [], tts: [] }
  for (const p of await listProcesses()) { const k = classify(p); if (k) out[k].push(p) }
  procCache.at = now(); procCache.val = out
  return out
}

const procState = { napcat: null, astrbot: null, tts: null }
const logRing = { napcat: [], astrbot: [], tts: [], console: [] }
const listeners = new Set()
export function onLog(fn) { listeners.add(fn); return () => listeners.delete(fn) }

export function pushLog(src, line, opts = {}) {
  const clean = String(line).replace(ANSI, '').replace(/\r/g, '')
  for (const raw of clean.split('\n')) {
    const text = raw.trimEnd()
    if (!text || BLOCK_ONLY.test(text)) continue
    const rec = { t: now(), src, text }
    const ring = logRing[src] || (logRing[src] = [])
    ring.push(rec)
    if (ring.length > MAX_LOG_LINES) ring.splice(0, ring.length - MAX_LOG_LINES)
    if (opts.persist !== false && src === 'console') appendLogFile(src, rec)
    for (const fn of listeners) { try { fn(rec) } catch {} }
    if (src === 'napcat') parseNapcatLine(text)
  }
}

function appendLogFile(src, rec) {
  try {
    ensureDir(PATHS().logsDir)
    const d = new Date(rec.t)
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const ts = d.toTimeString().slice(0, 8)
    fs.appendFileSync(path.join(PATHS().logsDir, `${src}-${day}.log`), `${ts} ${rec.text}\n`, 'utf8')
  } catch {}
}

export function recentLogs(src, n = 200) {
  const ring = logRing[src] || []
  return ring.slice(-n)
}
export function allRecentLogs(n = 300) {
  return Object.values(logRing).flat().sort((a, b) => a.t - b.t).slice(-n)
}

// ───────────── NapCat 登录状态机 ─────────────
export const login = {
  phase: 'unknown', // unknown | stopped | starting | qr | scanned | online | blocked | error
  message: '', code: null, qrAt: 0, qrUrl: '', updatedAt: 0,
}
function setLogin(patch) { Object.assign(login, patch, { updatedAt: now() }) }

function parseNapcatLine(text) {
  if (/请扫描下面的二维码|二维码已保存/.test(text)) {
    let mtime = 0
    try { mtime = fs.statSync(PATHS().napcatQr).mtimeMs } catch {}
    setLogin({ phase: 'qr', qrAt: mtime || now(), message: '请用机器人账号所在手机 QQ 扫码并确认登录' })
  }
  const u = /二维码解码URL:\s*(\S+)/.exec(text)
  if (u) setLogin({ qrUrl: u[1] })
  if (/二维码已被扫描/.test(text)) setLogin({ phase: 'scanned', message: '已扫码，请在手机上点“确认登录”' })
  if (/二维码已过期|二维码失效|qrcode.*expired/i.test(text)) setLogin({ phase: 'qr', message: '二维码已过期，正在刷新…' })
  const risk = /serverErrorCode":\s*(\d+)[^}]*?"message":"([^"]*)"/.exec(text)
  if (risk) {
    const code = Number(risk[1])
    const risky = code === 168 || /安全风险|恢复账号/.test(risk[2])
    setLogin({
      phase: risky ? 'blocked' : 'error', code,
      message: risky
        ? '账号被腾讯风控（168）：请先在手机 QQ 登录这个账号并按提示解除限制，然后再扫码'
        : `登录失败（${code}）：${risk[2]}`,
    })
  } else if (/Login Error/.test(text) && login.phase !== 'blocked') {
    setLogin({ phase: 'error', message: text.slice(0, 160) })
  }
  if (/登录成功|\[Login\].*成功|OneBot11 适配器初始化完成|HTTP Server Adapter\] Start/.test(text)) {
    setLogin({ phase: 'online', message: '机器人账号已在线', code: null })
  }
  if (/账号状态变更为离线/.test(text)) setLogin({ phase: 'error', message: '机器人账号被踢下线（离线）' })
}

export function qrInfo() {
  const qr = PATHS().napcatQr
  if (!qr) return { exists: false }
  let st = null
  try { st = fs.statSync(qr) } catch {}
  return st ? { exists: true, mtime: st.mtimeMs, ageSec: Math.round((now() - st.mtimeMs) / 1000) } : { exists: false }
}
export function qrBuffer() { const qr = PATHS().napcatQr; if (!qr) return null; try { return fs.readFileSync(qr) } catch { return null } }

// ───────────── 启停（输出重定向到 UTF-8 日志文件 + 本插件 tail） ─────────────
// 为什么不用管道：DSH 重启后管道另一端消失，NapCat/AstrBot 再写 stdout 会 EPIPE 直接崩。
// 写文件则进程与 DSH 解耦；插件每次加载都会重新 tail 现有日志文件（= 自动“接管”）。
const tails = {}
export const LOGFILE = (key) => path.join(PATHS().logsDir, `${key}-console.log`)

function tailDetach(key) { if (tails[key]) { clearInterval(tails[key].timer); delete tails[key] } }

export function tailAttach(key, { fromStart = false } = {}) {
  const file = LOGFILE(key)
  if (tails[key] && tails[key].file === file && !fromStart) return true
  tailDetach(key)
  let offset = 0
  let rem = Buffer.alloc(0)
  let dropFirst = false
  try {
    const st = fs.statSync(file)
    if (!fromStart) {
      const win = 64 * 1024
      offset = Math.max(0, st.size - win)
      dropFirst = offset > 0
    }
  } catch { if (!fromStart) return false }
  const handle = (buf) => {
    const data = Buffer.concat([rem, buf])
    const cut = data.lastIndexOf(0x0a)
    if (cut < 0) { rem = data; return }
    rem = data.subarray(cut + 1)
    let text = data.subarray(0, cut + 1).toString('utf8')
    if (dropFirst) { const i = text.indexOf('\n'); text = i >= 0 ? text.slice(i + 1) : ''; dropFirst = false }
    if (text) pushLog(key, text, { persist: false })
  }
  const tick = () => {
    let st
    try { st = fs.statSync(file) } catch { return }
    if (st.size < offset) { offset = 0; rem = Buffer.alloc(0); dropFirst = false }
    if (st.size === offset) return
    let fd
    try {
      fd = fs.openSync(file, 'r')
      const len = Math.min(st.size - offset, 1 << 20)
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, offset)
      offset += len
      handle(buf)
    } catch {} finally { if (fd !== undefined) try { fs.closeSync(fd) } catch {} }
  }
  tails[key] = { file, timer: setInterval(tick, 700) }
  tails[key].timer.unref?.()
  tick()
  return true
}

/** 插件加载时：给已有日志文件挂上 tail，实现 DSH 重启后的“接管”。 */
export function tailAll() {
  const out = {}
  for (const k of ['napcat', 'astrbot', 'tts']) out[k] = tailAttach(k)
  return out
}
export function tracked() { return Object.fromEntries(Object.keys(tails).map((k) => [k, true])) }

function launch(key, exe, args, { cwd, env } = {}) {
  ensureDir(PATHS().logsDir)
  const file = LOGFILE(key)
  fs.writeFileSync(file, '')
  tailAttach(key, { fromStart: true })
  // 直接给子进程一个文件 fd 当 stdout/stderr（同 voice.py 的做法）。
  // 不要走 cmd.exe /c "…" 或 shell:true：Windows 下引号会被二次转义，命令静默失败、日志 0 字节。
  // 日志里是原始 UTF-8 字节（控制台乱码的根因是代码页 936，与重定向无关），由 tail 侧按 UTF-8 解码。
  const fd = fs.openSync(file, 'a')
  let child
  try {
    child = spawn(exe, args, { cwd, env: { ...process.env, ...(env || {}) }, detached: true, stdio: ['ignore', fd, fd], windowsHide: true })
  } finally { try { fs.closeSync(fd) } catch {} }
  child.unref()
  procState[key] = { pid: child.pid, started: now() }
  procCache.at = 0
  return child.pid
}

function requireExe(exe, label) {
  if (!exe || !fs.existsSync(exe)) throw new Error(`${label} 不存在：${exe || '(未配置)'}。去“总览”点“一键部署”，或在“设置”里填好路径。`)
  return exe
}

export async function startNapcat() {
  const bot = BOT_QQ()
  if (!bot) throw new Error('还没有填机器人账号的 QQ 号，先去“设置”里填。')
  const exe = requireExe(PATHS().napcatExe, 'NapCat')
  const g = await groupedProcesses(true)
  if (g.napcat.length && await portOpen(PORTS().napcatHttp)) return { ok: true, note: 'NapCat 已在运行' }
  if (g.napcat.length) await stopNapcat()
  setLogin({ phase: 'starting', message: 'NapCat 启动中…', code: null, qrUrl: '' })
  const pid = launch('napcat', exe, [bot], { cwd: PATHS().napcatDir })
  pushLog('console', `启动 NapCat（登录账号 ${bot}，日志 UTF-8）`)
  return { ok: true, pid }
}

export async function stopNapcat() {
  const g = await groupedProcesses(true)
  for (const p of g.napcat) { try { process.kill(p.ProcessId, 'SIGKILL') } catch {} }
  procState.napcat = null; procCache.at = 0
  setLogin({ phase: 'stopped', message: 'NapCat 已停止', code: null })
  pushLog('console', `已停止 NapCat（${g.napcat.length} 个进程，仅部署目录下的 QQ，不影响系统里其他 QQ）`)
  return { ok: true, killed: g.napcat.length }
}
export async function restartNapcat() { await stopNapcat(); await sleep(1500); return startNapcat() }

export async function startAstrbot() {
  const py = requireExe(PATHS().astrbotPy, 'AstrBot 的 Python (.venv)')
  if (await portOpen(PORTS().astrbotUi)) return { ok: true, note: 'AstrBot 已在运行' }
  const pid = launch('astrbot', py, ['-u', 'main.py'], { cwd: PATHS().astrbotDir, env: { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' } })
  pushLog('console', '启动 AstrBot')
  return { ok: true, pid }
}

export async function stopAstrbot() {
  const g = await groupedProcesses(true)
  for (const p of g.astrbot) { try { process.kill(p.ProcessId, 'SIGKILL') } catch {} }
  procState.astrbot = null; procCache.at = 0
  pushLog('console', `已停止 AstrBot（${g.astrbot.length} 个进程）`)
  return { ok: true, killed: g.astrbot.length }
}
export async function restartAstrbot() { await stopAstrbot(); await sleep(1500); return startAstrbot() }

export async function startTts() {
  const py = requireExe(PATHS().voicePy, 'GPT-SoVITS 的 Python 解释器')
  if (await portOpen(PORTS().tts)) return { ok: true, note: 'TTS 已在运行' }
  const pid = launch('tts', py, ['-u', 'api_v2.py', '-a', '127.0.0.1', '-p', String(PORTS().tts), '-c', 'GPT_SoVITS/configs/tts_infer.yaml'],
    { cwd: PATHS().voiceDir, env: { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONUNBUFFERED: '1', CUDAGraph: '0' } })
  pushLog('console', '启动 GPT-SoVITS（CUDAGraph=0，约 8 秒预热）')
  return { ok: true, pid }
}

export async function stopTts() {
  try { await fetch(`http://127.0.0.1:${PORTS().tts}/control?command=exit`, { signal: AbortSignal.timeout(3000) }) } catch {}
  await sleep(1200)
  const g = await groupedProcesses(true)
  for (const p of g.tts) { try { process.kill(p.ProcessId, 'SIGKILL') } catch {} }
  procState.tts = null; procCache.at = 0
  pushLog('console', '已停止 GPT-SoVITS')
  return { ok: true }
}

export async function startAll() {
  const r = {}
  r.astrbot = await startAstrbot()
  r.napcat = await startNapcat()
  return r
}
export async function stopAll() {
  const r = {}
  r.napcat = await stopNapcat()
  r.astrbot = await stopAstrbot()
  return r
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ───────────── 状态汇总 ─────────────
export async function status() {
  const [nap, ui, ws, ing, tts] = await Promise.all([
    portOpen(PORTS().napcatHttp), portOpen(PORTS().astrbotUi), portOpen(PORTS().astrbotWs), portOpen(PORTS().ingress), portOpen(PORTS().tts),
  ])
  let bot = null
  if (nap) {
    try {
      const r = await onebot('get_login_info', {}, 3000)
      if (r && r.status === 'ok') { bot = { id: r.data.user_id, nick: r.data.nickname }; if (login.phase !== 'online') setLogin({ phase: 'online', message: '机器人账号已在线', code: null }) }
    } catch {}
  } else if (login.phase === 'online') {
    setLogin({ phase: 'stopped', message: 'NapCat 未运行' })
  }
  const g = await groupedProcesses()
  return {
    configured: config.isConfigured(),
    ports: { napcat: nap, astrbotUi: ui, astrbotWs: ws, ingress: ing, tts },
    bot, login: { ...login }, qr: qrInfo(),
    procs: {
      napcat: g.napcat.map((p) => p.ProcessId), astrbot: g.astrbot.map((p) => p.ProcessId), tts: g.tts.map((p) => p.ProcessId),
    },
    chain: ing && ui && nap && ws ? 'ok' : 'degraded',
    time: now(),
  }
}

// 轻量状态（挂件轮询用）：只探端口 + 一次 get_login_info，不起 PowerShell
export async function statusLight() {
  const [nap, ui, ws, ing, tts] = await Promise.all([
    portOpen(PORTS().napcatHttp, '127.0.0.1', 400), portOpen(PORTS().astrbotUi, '127.0.0.1', 400),
    portOpen(PORTS().astrbotWs, '127.0.0.1', 400), portOpen(PORTS().ingress, '127.0.0.1', 400), portOpen(PORTS().tts, '127.0.0.1', 400),
  ])
  let bot = null
  if (nap) { try { const r = await onebot('get_login_info', {}, 2500); if (r && r.status === 'ok') bot = { id: r.data.user_id, nick: r.data.nickname } } catch {} }
  return { ports: { napcat: nap, astrbotUi: ui, astrbotWs: ws, ingress: ing, tts }, bot, login: { ...login }, chain: ing && ui && nap && ws ? 'ok' : 'degraded' }
}

// ───────────── 守护 ─────────────
const restarts = { astrbot: [], napcat: [] }
let watchTimer = null
export function startWatchdog() {
  stopWatchdog()
  const cfg = loadConfig().watchdog
  if (!cfg.enabled) return false
  watchTimer = setInterval(async () => {
    const c = loadConfig()
    if (!c.watchdog.enabled) return
    const hourAgo = now() - 3600_000
    for (const k of Object.keys(restarts)) restarts[k] = restarts[k].filter((t) => t > hourAgo)
    const ui = await portOpen(PORTS().astrbotUi)
    if (!ui && c.watchdog.restartAstrbot && restarts.astrbot.length < c.watchdog.maxRestartsPerHour) {
      restarts.astrbot.push(now()); pushLog('console', '守护：AstrBot 掉线，自动拉起'); try { await startAstrbot() } catch (e) { pushLog('console', '守护拉起 AstrBot 失败：' + e.message) }
    }
    const nap = await portOpen(PORTS().napcatHttp)
    if (!nap && c.watchdog.restartNapcat && login.phase !== 'blocked' && restarts.napcat.length < c.watchdog.maxRestartsPerHour) {
      restarts.napcat.push(now()); pushLog('console', '守护：NapCat 掉线，自动拉起'); try { await startNapcat() } catch (e) { pushLog('console', '守护拉起 NapCat 失败：' + e.message) }
    }
  }, Math.max(10, cfg.intervalSec) * 1000)
  watchTimer.unref?.()
  return true
}
export function stopWatchdog() { if (watchTimer) { clearInterval(watchTimer); watchTimer = null } }

// ───────────── 外部工具封装（语音 / 表情包 / 指标） ─────────────
export function run(file, args, { timeout = 60000, cwd, env } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, cwd, env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...(env || {}) }, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => resolve({ ok: !err, code: err?.code ?? 0, stdout: String(stdout || ''), stderr: String(stderr || '') }))
  })
}

function pyForTools() { return PATHS().astrbotPy || process.env.QQBOT_PYTHON || 'python' }

export const voice = {
  cfg: () => readJson(PATHS().voiceCfg, {}) || {},
  saveCfg(patch) { const n = { ...voice.cfg(), ...patch }; writeJson(PATHS().voiceCfg, n); return n },
  say: (text, { send = false, speed, out } = {}) => {
    const a = ['-X', 'utf8', path.join(PATHS().toolsDir, 'voice.py'), 'say', '--text', text]
    if (send) a.push('--send')
    if (speed) a.push('--speed', String(speed))
    if (out) a.push('--out', out)
    return run(pyForTools(), a, { timeout: 180000 })
  },
  refs() {
    ensureDir(PATHS().voiceRefDir)
    return fs.readdirSync(PATHS().voiceRefDir).filter((f) => /\.(wav|mp3|flac|m4a)$/i.test(f)).map((f) => {
      const st = fs.statSync(path.join(PATHS().voiceRefDir, f)); return { name: f, kb: Math.round(st.size / 1024), mtime: st.mtimeMs }
    })
  },
}

export const stickers = {
  index: () => readJson(PATHS().stickerIndex, { items: {}, sends: [] }),
  list({ layer = 'all', q = '' } = {}) {
    const idx = stickers.index()
    let items = Object.values(idx.items || {})
    if (layer !== 'all') items = items.filter((i) => i.layer === layer)
    if (q) { const k = q.toLowerCase(); items = items.filter((i) => (i.tags || []).some((t) => t.toLowerCase().includes(k)) || String(i.desc || '').toLowerCase().includes(k)) }
    return items.sort((a, b) => (b.capturedAt || 0) - (a.capturedAt || 0))
  },
  stats() {
    const idx = stickers.index(); const items = Object.values(idx.items || {})
    const by = {}; for (const i of items) by[i.layer] = (by[i.layer] || 0) + 1
    const recent = (idx.sends || []).filter((t) => now() / 1000 - t < 600).length
    return { total: items.length, byLayer: by, sendsLast10min: recent, untagged: items.filter((i) => !(i.tags || []).length).length }
  },
  file(id) { const it = stickers.index().items?.[id]; return it && fs.existsSync(it.file) ? it.file : null },
  cli: (args, opts) => run(pyForTools(), ['-X', 'utf8', '-S', path.join(PATHS().toolsDir, 'sticker.py'), ...args], { timeout: 60000, ...opts }),
  send: (id, { text = '', force = false } = {}) => stickers.cli(['send', '--id', id, ...(text ? ['--text', text] : []), ...(force ? ['--force'] : [])]),
  set: (id, { tags, desc, layer }) => stickers.cli(['set', id, ...(tags != null ? ['--tags', tags] : []), ...(desc != null ? ['--desc', desc] : []), ...(layer ? ['--layer', layer] : [])]),
  trash: (id) => stickers.cli(['trash', id]),
  restore: (id) => stickers.cli(['restore', id]),
  async add(buf, name, { tags = '', desc = '', layer = 'library' } = {}) {
    const dir = ensureDir(path.join(PATHS().stickersDir, 'inbox'))
    const safe = String(name || 'upload.png').replace(/[^\w.\-\u4e00-\u9fa5]/g, '_')
    const fp = path.join(dir, `${Date.now()}-${safe}`)
    fs.writeFileSync(fp, buf)
    return stickers.cli(['add', fp, '--tags', tags, '--desc', desc, '--source', '面板上传', '--layer', layer])
  },
}

// ───────────── 记忆 / 人设文件（白名单读写） ─────────────
const EDITABLE = () => {
  const m = PATHS().memoryDir
  const files = { 'AGENTS.md': PATHS().agents }
  try { for (const f of fs.readdirSync(m)) if (/\.md$/i.test(f)) files[`memory/${f}`] = path.join(m, f) } catch {}
  try { for (const f of fs.readdirSync(path.join(m, 'journal')).sort().slice(-14)) files[`memory/journal/${f}`] = path.join(m, 'journal', f) } catch {}
  files['voice.json'] = PATHS().voiceCfg
  return files
}
export const docs = {
  list: () => Object.entries(EDITABLE()).map(([name, p]) => { let s = {}; try { s = fs.statSync(p) } catch {}; return { name, kb: Math.round((s.size || 0) / 102.4) / 10, mtime: s.mtimeMs || 0 } }),
  read(name) { const p = EDITABLE()[name]; if (!p) throw new Error('不在白名单内'); return fs.readFileSync(p, 'utf8') },
  write(name, content) {
    const p = EDITABLE()[name]; if (!p) throw new Error('不在白名单内')
    ensureDir(PATHS().backupsDir)
    const bak = path.join(PATHS().backupsDir, `${name.replace(/[\\/]/g, '_')}.${Date.now()}.bak`)
    try { fs.copyFileSync(p, bak) } catch {}
    fs.writeFileSync(p, content, 'utf8')
    return { ok: true, backup: bak }
  },
}

// ───────────── AstrBot 插件运行参数（陌生人限额、自动补图等） ─────────────
// 这些常量写在我们自己的 addon（astrbot-bridge-addon）main.py 顶部；面板通过正则改值并可一键重启生效。
const PLUGIN_PARAMS = {
  socialLimit: { re: /^_SOCIAL_LIMIT\s*=\s*(\d+)/m, label: '陌生人最多回复条数', type: 'int', min: 1, max: 100 },
  socialWarnAt: { re: /^_SOCIAL_WARN_AT\s*=\s*(\d+)/m, label: '第几条附提醒', type: 'int', min: 1, max: 100 },
  socialWindowSec: { re: /^_SOCIAL_WINDOW_SEC\s*=\s*(\d+)/m, label: '重新计数间隔(秒)', type: 'int', min: 30, max: 86400 },
  autoStickerEnabled: { re: /^_AUTO_STICKER_ENABLED\s*=\s*(True|False)/m, label: '自动补表情包', type: 'bool' },
  autoStickerMaxChars: { re: /^_AUTO_STICKER_MAX_CHARS\s*=\s*(\d+)/m, label: '超过多少字不补图', type: 'int', min: 10, max: 2000 },
  autoStickerGapSec: { re: /^_AUTO_STICKER_MIN_GAP_SEC\s*=\s*(\d+)/m, label: '补图最小间隔(秒)', type: 'int', min: 0, max: 3600 },
  autoStickerGateMax: { re: /^_AUTO_STICKER_GATE_MAX\s*=\s*(\d+)/m, label: '10分钟补图上限', type: 'int', min: 0, max: 100 },
}
const PARAM_ASSIGN = {
  socialLimit: '_SOCIAL_LIMIT', socialWarnAt: '_SOCIAL_WARN_AT', socialWindowSec: '_SOCIAL_WINDOW_SEC',
  autoStickerEnabled: '_AUTO_STICKER_ENABLED', autoStickerMaxChars: '_AUTO_STICKER_MAX_CHARS',
  autoStickerGapSec: '_AUTO_STICKER_MIN_GAP_SEC', autoStickerGateMax: '_AUTO_STICKER_GATE_MAX',
}
function addonMainPy() { return path.join(PATHS().addonDir, 'main.py') }
export const pluginParams = {
  read() {
    let src = ''
    try { src = fs.readFileSync(addonMainPy(), 'utf8') } catch { return { error: '读不到 AstrBot 插件文件；先部署 astrbot-bridge-addon', params: [] } }
    const warn = /^_SOCIAL_WARNING\s*=\s*"([^"\n]*)"/m.exec(src)
    const params = Object.entries(PLUGIN_PARAMS).map(([key, d]) => {
      const m = d.re.exec(src)
      const raw = m ? m[1] : null
      return { key, label: d.label, type: d.type, min: d.min, max: d.max, value: raw == null ? null : d.type === 'bool' ? raw === 'True' : Number(raw) }
    })
    return { params, socialWarning: warn ? warn[1] : '' }
  },
  write(values = {}, socialWarning) {
    const file = addonMainPy()
    let src = fs.readFileSync(file, 'utf8')
    ensureDir(PATHS().backupsDir)
    fs.copyFileSync(file, path.join(PATHS().backupsDir, `addon.main.${Date.now()}.bak`))
    for (const [k, v] of Object.entries(values)) {
      const d = PLUGIN_PARAMS[k]; if (!d) continue
      let lit
      if (d.type === 'bool') lit = v ? 'True' : 'False'
      else { const n = Math.round(Number(v)); if (!Number.isFinite(n) || n < d.min || n > d.max) throw new Error(`${d.label} 超出范围 ${d.min}~${d.max}`); lit = String(n) }
      src = src.replace(new RegExp(`^(${PARAM_ASSIGN[k]}\\s*=\\s*)(?:\\d+|True|False)`, 'm'), `$1${lit}`)
    }
    if (typeof socialWarning === 'string' && socialWarning.trim()) {
      const safe = socialWarning.replace(/["\\\n\r]/g, ' ').trim().slice(0, 200)
      src = src.replace(/^(_SOCIAL_WARNING\s*=\s*)"[^"\n]*"/m, `$1"${safe}"`)
    }
    fs.writeFileSync(file, src, 'utf8')
    return { ok: true, needRestartAstrbot: true }
  },
  allowlist() {
    const c = readJson(PATHS().astrbotPluginCfg, {}) || {}
    return { users: c.allow_users || [], groups: c.allow_groups || [] }
  },
  saveAllowlist({ users, groups }) {
    const c = readJson(PATHS().astrbotPluginCfg, {}) || {}
    const clean = (a) => [...new Set((a || []).map((x) => String(x).trim()).filter((x) => /^\d{5,12}$/.test(x)))]
    if (users) c.allow_users = clean(users)
    if (groups) c.allow_groups = clean(groups)
    ensureDir(PATHS().backupsDir)
    try { fs.copyFileSync(PATHS().astrbotPluginCfg, path.join(PATHS().backupsDir, `plugin_cfg.${Date.now()}.bak`)) } catch {}
    writeJson(PATHS().astrbotPluginCfg, c)
    return { ok: true, needRestartAstrbot: true, ...pluginParams.allowlist() }
  },
}

// ───────────── 发 QQ 消息 ─────────────
export async function sendQq({ userId, groupId = 0, text }) {
  if (!text || !String(text).trim()) throw new Error('消息为空')
  const uid = userId || OWNER_QQ()
  if (!groupId && !uid) throw new Error('没有收件人：请在设置里填主人 QQ 号，或指定 user_id/group_id')
  const body = groupId ? { group_id: Number(groupId), message: String(text) } : { user_id: Number(uid), message: String(text) }
  return onebot(groupId ? 'send_group_msg' : 'send_private_msg', body, 15000)
}

// ───────────── 计划任务 ─────────────
export async function scheduledTasks() {
  const r = await psJson(`Get-ScheduledTask -TaskName 'QQBot*' -ErrorAction SilentlyContinue | ForEach-Object { $i=Get-ScheduledTaskInfo -TaskName $_.TaskName; [pscustomobject]@{ name=$_.TaskName; state=[string]$_.State; last=if($i.LastRunTime){$i.LastRunTime.ToString('o')}else{''}; result=$i.LastTaskResult; next=if($i.NextRunTime){$i.NextRunTime.ToString('o')}else{''} } } | ConvertTo-Json -Compress`)
  return r || []
}
export async function runTask(name) {
  if (!/^QQBot-[\w-]+$/.test(name)) throw new Error('非法任务名')
  const r = await run('powershell.exe', ['-NoProfile', '-Command', `Start-ScheduledTask -TaskName '${name}'`], { timeout: 15000 })
  return { ok: r.ok, stderr: r.stderr }
}
export async function setTaskEnabled(name, enabled) {
  if (!/^QQBot-[\w-]+$/.test(name)) throw new Error('非法任务名')
  const r = await run('powershell.exe', ['-NoProfile', '-Command', `${enabled ? 'Enable' : 'Disable'}-ScheduledTask -TaskName '${name}'`], { timeout: 15000 })
  return { ok: r.ok, stderr: r.stderr }
}

// ───────────── 指标 / 余额 ─────────────
export async function metrics() {
  const script = path.join(PATHS().toolsDir, 'metrics.ps1')
  const r = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { timeout: 30000, env: { QQBOT_CONFIG: config.configFilePath() } })
  return r.stdout
}

// ───────────── 体检（一键诊断） ─────────────
export async function diagnose() {
  const st = await status()
  const items = []
  const add = (ok, name, hint) => items.push({ ok, name, hint: ok ? '' : hint })
  if (!st.configured) add(false, '基础设置', '去“设置”里填部署根目录、主人 QQ、机器人 QQ')
  add(st.ports.ingress, 'DSH ingress (3188)', '桌面 App 没开或 dsh-astrbot-ingress 插件未加载')
  add(st.ports.astrbotUi, 'AstrBot WebUI (6185)', '点“启动 AstrBot”，没装过就点“一键部署”')
  add(st.ports.astrbotWs, 'AstrBot 反向 WS (6199)', 'AstrBot 未就绪')
  add(st.ports.napcat, 'NapCat OneBot (3002)', st.login.phase === 'blocked' ? '账号被风控，需手机解除' : '点“启动 NapCat”，没装过就点“一键部署”，必要时扫码')
  add(!!st.bot, '机器人账号在线', st.login.message || '未登录')
  add(st.ports.tts, 'GPT-SoVITS (9880)', '语音服务未启动（需要发语音时再开，占显存）')
  let ws = false
  if (st.ports.astrbotWs && st.ports.napcat) ws = await wsLinked()
  add(ws, 'NapCat ↔ AstrBot 已连通', '重启 AstrBot 或 NapCat')
  const free = await diskFree()
  if (free) { const sys = process.platform === 'win32' ? (PATHS().root.slice(0, 1) || 'C') : '/'; if (free[sys] != null) add(free[sys] > 10, `${sys} 盘剩余 ${free[sys]}GB`, '部署盘空间偏紧（虚拟内存/临时文件）') }
  return { items, status: st }
}
async function wsLinked() {
  const r = await run('powershell.exe', ['-NoProfile', '-Command', `(Get-NetTCPConnection -State Established -RemotePort ${PORTS().astrbotWs} -ErrorAction SilentlyContinue | Measure-Object).Count`], { timeout: 8000 })
  return Number(String(r.stdout).trim()) > 0
}
async function diskFree() {
  try {
    const out = {}
    const roots = process.platform === 'win32' ? [...new Set([PATHS().root.slice(0, 1), 'C'])] : ['/']
    for (const d of roots) { const s = fs.statfsSync(process.platform === 'win32' ? `${d}:\\` : d); out[d] = Math.round((s.bavail * s.bsize) / 1073741824) }
    return out
  } catch { return null }
}

// ───────────── 备份 ─────────────
export function backupNow() {
  ensureDir(PATHS().backupsDir)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dir = ensureDir(path.join(PATHS().backupsDir, `snapshot-${stamp}`))
  const copy = (src, name) => { try { fs.cpSync(src, path.join(dir, name), { recursive: true }) } catch {} }
  copy(PATHS().agents, 'AGENTS.md'); copy(PATHS().memoryDir, 'memory'); copy(PATHS().voiceCfg, 'voice.json')
  copy(PATHS().stickerIndex, 'stickers-index.json'); copy(PATHS().astrbotPluginCfg, 'plugin_cfg.json'); copy(addonMainPy(), 'addon.main.py')
  copy(config.configFilePath(), 'qqbot.config.json')
  return { ok: true, dir }
}

export function bootstrap() {
  ensureDir(PATHS().logsDir)
  const c = loadConfig()
  if (c.watchdog.enabled) startWatchdog()
  return c
}
export { os, config }
