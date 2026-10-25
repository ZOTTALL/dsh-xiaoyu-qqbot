// 参考音色：上传 → 裁剪/可选 UVR5 分离 → 生成 32kHz 单声道参考 WAV → 选择并应用。
// 不自动覆盖当前音色，不训练新的 GPT-SoVITS 权重。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { PATHS, run, ensureDir } from './core.mjs'

const uploadDirOf = () => path.join(PATHS().voiceRefDir, 'uploads')
const outDirOf = () => PATHS().voiceRefDir
const jobs = new Map()
const allowed = /\.(wav|mp3|m4a|flac|ogg|aac)$/i
const safeName = (n) => String(n || '').replace(/\.\./g, '_').replace(/[^\w.\-\u4e00-\u9fa5]/g, '_').slice(-100) || 'audio'
const id = () => crypto.randomBytes(8).toString('hex')

function under(p, root) {
  const r = path.resolve(p); const b = path.resolve(root)
  return r === b || r.startsWith(b + path.sep)
}

let ffmpegCache = null
/** 在 PATH 里找 ffmpeg；找不到就返回 null（调用方据此提示用户安装）。 */
export function ffmpegPath() {
  if (ffmpegCache !== null) return ffmpegCache || null
  const candidates = process.platform === 'win32' ? ['ffmpeg.exe', 'ffmpeg'] : ['ffmpeg']
  for (const c of candidates) {
    try { execFileSync(process.platform === 'win32' ? 'where' : 'which', [c], { stdio: 'ignore' }); ffmpegCache = c; return c } catch {}
  }
  ffmpegCache = ''
  return null
}
export function ffprobePath() {
  const f = ffmpegPath(); if (!f) return null
  return f.toLowerCase().includes('ffmpeg') ? f.replace(/ffmpeg(\.exe)?$/i, (m) => m.toLowerCase().startsWith('.exe') ? 'ffprobe.exe' : 'ffprobe') : 'ffprobe'
}

export function listRefs() {
  const outDir = outDirOf()
  ensureDir(outDir)
  return fs.readdirSync(outDir).filter((n) => /\.(wav|mp3|m4a|flac|ogg|aac)$/i.test(n)).map((name) => {
    const s = fs.statSync(path.join(outDir, name)); return { name, bytes: s.size, mtime: s.mtimeMs }
  })
}
export function refFile(name) {
  const outDir = outDirOf()
  const n = path.basename(String(name || ''))
  if (n !== name || !/^[\w\u4e00-\u9fa5.\-]+\.(?:wav|mp3|m4a|flac|ogg|aac)$/i.test(n)) return null
  const p = path.join(outDir, n)
  return fs.existsSync(p) && under(p, outDir) ? p : null
}
export function uploadFile(buf, name) {
  if (!allowed.test(name)) throw new Error('只支持 WAV/MP3/M4A/FLAC/OGG/AAC')
  if (!buf || buf.length < 256) throw new Error('音频文件太小或为空')
  if (buf.length > 30 * 1024 * 1024) throw new Error('上传文件不能超过 30MB')
  const uploadDir = uploadDirOf()
  ensureDir(uploadDir)
  const file = `${Date.now()}-${id()}-${safeName(name)}`
  const p = path.join(uploadDir, file); fs.writeFileSync(p, buf)
  return { id: file, name, bytes: buf.length }
}

function spawnPrepare(args) {
  return new Promise((resolve) => {
    const py = PATHS().voicePy || PATHS().astrbotPy
    if (!py) return resolve({ ok: false, error: '没有配置语音解释器（voicePy）；去“设置”里填。' })
    const script = path.join(PATHS().toolsDir, 'prepare_voice_ref.py')
    ensureDir(PATHS().tmpDir)
    const child = spawn(py, ['-X', 'utf8', script, ...args], {
      cwd: PATHS().root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', TMP: PATHS().tmpDir, TEMP: PATHS().tmpDir, QQBOT_CONFIG: process.env.QQBOT_CONFIG || '' },
    })
    let out = ''; let err = ''
    child.stdout.on('data', (b) => { out += b.toString('utf8').slice(-20000) })
    child.stderr.on('data', (b) => { err += b.toString('utf8').slice(-10000) })
    child.on('error', (e) => resolve({ ok: false, error: e.message }))
    child.on('exit', (code) => {
      if (code !== 0) return resolve({ ok: false, error: (err || out || `prepare exited ${code}`).slice(-1000) })
      try { resolve({ ok: true, result: JSON.parse(out.trim().split(/\r?\n/).at(-1)) }) } catch { resolve({ ok: false, error: '预处理输出不是有效 JSON：' + out.slice(-500) }) }
    })
  })
}

export function startPrepare(inputId, opts = {}) {
  if (Array.from(jobs.values()).some((j) => j.status === 'running')) throw new Error('已有一个参考音色在处理中，请等待完成')
  const uploadDir = uploadDirOf()
  const input = path.join(uploadDir, path.basename(String(inputId || '')))
  if (!under(input, uploadDir) || !fs.existsSync(input)) throw new Error('上传文件不存在')
  const jid = id(); const duration = Math.min(10, Math.max(3, Number(opts.durationSec) || 6)); const start = Math.max(0, Number(opts.startSec) || 0)
  const base = `ref_upload_${jid}.wav`; const output = path.join(outDirOf(), base)
  const job = { id: jid, status: 'running', stage: '准备中', createdAt: Date.now(), result: null, error: null }
  jobs.set(jid, job)
  job.promise = (async () => {
    try {
      job.stage = opts.removeMusic ? 'UVR5 分离人声中' : '裁剪与转换中'
      const r = await spawnPrepare([input, output, String(start), String(duration), opts.removeMusic ? '1' : '0'])
      if (!r.ok) throw new Error(r.error)
      job.status = 'done'; job.stage = '完成'; job.result = { ...r.result, name: base, ref_audio: output, prompt_text: String(opts.promptText || '').trim(), durationSec: r.result.durationSec || duration }
    } catch (e) { job.status = 'error'; job.stage = '失败'; job.error = e.message || String(e) }
    return job
  })()
  return { id: jid, status: 'running' }
}
export function getJob(jid) {
  const j = jobs.get(String(jid || '')); if (!j) return null
  const { promise, ...view } = j; return view
}
export function applyRefConfig(cfg, refName, promptText) {
  const p = refFile(refName); if (!p) throw new Error('参考音色必须是 voice/ref 下已存在的音频文件')
  return { ...cfg, ref_audio: p, prompt_text: String(promptText || '').trim() }
}
