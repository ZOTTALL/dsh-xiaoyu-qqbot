// dsh-xiaoyu-qqbot —— 宿主插件：把「QQ BOT 控制台」挂进 DSH 桌面端。
//
// 形态：
//   · 路由前缀 /dsh-xiaoyu-qqbot/*（api + 页面 + 静态资源），全部套信任栅栏（回环 Host、同源 Origin、写请求必须本机、CSRF token）
//   · 桌面端（Electron）通过 `webserver/index-inject` 注入一个内联 <script>，由它在页面边缘挂一个把手，
//     点击后以侧边抽屉 iframe 打开 /dsh-xiaoyu-qqbot/ui。网页端另有 tapIndex 同样注入。
//   · 注入脚本自己建 DOM 且吞掉 onerror：路由不在时静默失败，绝不拖垮宿主启动。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import * as core from './core.mjs'
import * as voiceRefs from './voice-refs.mjs'
import * as deploy from './deploy.mjs'
import * as config from './config.mjs'

export const name = 'dsh-xiaoyu-qqbot'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ASSETS = path.join(HERE, '..', 'assets')
const PREFIX = '/dsh-xiaoyu-qqbot'
const MAX_BODY = 12 * 1024 * 1024
const CSRF = crypto.randomBytes(24).toString('hex')

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' }

// ───── 信任栅栏 ─────
function isLoopbackHostname(hn) {
  const h = String(hn || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (!h) return false
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  return !!m && Number(m[1]) === 127 && [m[2], m[3], m[4]].every((x) => Number(x) <= 255)
}
export function trustFailure(req, conn) {
  try {
    const headers = req.headers || {}
    let hostUrl
    try { hostUrl = new URL('http://' + String(headers.host || '')) } catch { return 403 }
    // 控制台能启停进程、改人设文件、跑一键部署：只允许回环访问，不接受任何“受信任主机”扩展
    if (!isLoopbackHostname(hostUrl.hostname)) return 403
    if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return 403
    const origin = headers.origin
    if (typeof origin === 'string' && origin && origin !== 'null') {
      let o
      try { o = new URL(origin) } catch { return 403 }
      if (o.host.toLowerCase() !== hostUrl.host.toLowerCase()) return 403
    }
    if (conn && typeof conn.requestRejection === 'function') {
      const code = conn.requestRejection(req)
      if (code !== undefined && code !== null && code !== false) return typeof code === 'number' ? code : 403
    }
    return null
  } catch { return 403 }
}

// ───── 小工具 ─────
const json = (res, code, body) => {
  const text = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}
function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(new Error('请求体过大')); req.destroy(); return } chunks.push(c) })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}
async function readJson(req) {
  const b = await readBody(req, 1024 * 1024)
  if (!b.length) return {}
  try { return JSON.parse(b.toString('utf8')) } catch { throw new Error('JSON 解析失败') }
}
function serveFile(res, file, { cache = false } = {}) {
  try {
    const buf = fs.readFileSync(file)
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': cache ? 'max-age=60' : 'no-store', 'content-length': buf.length })
    res.end(buf)
  } catch { res.writeHead(404); res.end('not found') }
}

// ───── API 分发 ─────
// GET 为只读；POST 需要 x-dsh-csrf（同源页先 GET /api/csrf 取）。
const READ = {
  'status': async () => core.status(),
  'ping': async () => core.statusLight(),
  'diagnose': async () => core.diagnose(),
  'logs': async (q) => ({ lines: q.get('src') === 'all' ? core.allRecentLogs(Number(q.get('n') || 300)) : core.recentLogs(q.get('src') || 'napcat', Number(q.get('n') || 200)) }),
  'config': async () => core.loadConfig(),
  'settings': async () => ({ raw: config.loadRawConfig({ fresh: true }), deploy: deploy.groupedDeployStatus() }),
  'tasks': async () => ({ tasks: await core.scheduledTasks() }),
  'metrics': async () => ({ text: await core.metrics() }),
  'voice/config': async () => ({ cfg: core.voice.cfg(), refs: [...core.voice.refs(), ...voiceRefs.listRefs()] }),
  'voice/job': async (q) => ({ ok: true, job: voiceRefs.getJob(q.get('id')) || { status: 'missing', error: '任务不存在' } }),
  'stickers/stats': async () => core.stickers.stats(),
  'stickers/list': async (q) => ({ items: core.stickers.list({ layer: q.get('layer') || 'all', q: q.get('q') || '' }).slice(0, Number(q.get('n') || 120)) }),
  'docs/list': async () => ({ docs: core.docs.list() }),
  'docs/read': async (q) => ({ name: q.get('name'), content: core.docs.read(q.get('name')) }),
  'params': async () => ({ ...core.pluginParams.read(), allow: core.pluginParams.allowlist() }),
  'deploy/job': async (q) => ({ ok: true, job: deploy.getDeployJob(q.get('id')) || { status: 'missing', error: '任务不存在' } }),
  'deploy/ingress': async () => deploy.checkIngress(),
}
const WRITE = {
  'start': async (b) => ({ ok: true, result: await ({ napcat: core.startNapcat, astrbot: core.startAstrbot, tts: core.startTts, all: core.startAll }[b.target] || (() => { throw new Error('未知目标') }))() }),
  'stop': async (b) => ({ ok: true, result: await ({ napcat: core.stopNapcat, astrbot: core.stopAstrbot, tts: core.stopTts, all: core.stopAll }[b.target] || (() => { throw new Error('未知目标') }))() }),
  'restart': async (b) => ({ ok: true, result: await ({ napcat: core.restartNapcat, astrbot: core.restartAstrbot }[b.target] || (() => { throw new Error('未知目标') }))() }),
  'config': async (b) => { const c = core.saveConfig(b.patch || {}); core.startWatchdog(); return { ok: true, config: c } },
  'settings': async (b) => { const c = config.saveRawConfig(b.patch || {}); return { ok: true, settings: c } },
  'deploy': async (b) => {
    const fn = { napcat: deploy.deployNapcat, astrbot: deploy.deployAstrbot, tts: deploy.deployTts }[b.target]
    if (!fn) throw new Error('未知部署目标')
    return { ok: true, job: await fn() }
  },
  'send': async (b) => ({ ok: true, result: await core.sendQq({ userId: b.userId, groupId: b.groupId, text: b.text }) }),
  'task/run': async (b) => core.runTask(String(b.name)),
  'task/enable': async (b) => core.setTaskEnabled(String(b.name), !!b.enabled),
  'voice/say': async (b) => {
    const text = String(b.text || '').trim(); if (!text) throw new Error('文本为空')
    if (text.length > 300) throw new Error('单次最多 300 字')
    const r = await core.voice.say(text, { send: !!b.send, speed: b.speed })
    return { ok: r.ok, stdout: r.stdout.slice(-800), stderr: r.stderr.slice(-400) }
  },
  'voice/config': async (b) => ({ ok: true, cfg: core.voice.saveCfg(voiceRefs.applyRefConfig(core.voice.cfg(), String(b.refName || path.basename(String(b.ref_audio || ''))), b.prompt_text)) }),
  'voice/prepare': async (b) => ({ ok: true, job: voiceRefs.startPrepare(String(b.id), b) }),
  'stickers/send': async (b) => { const r = await core.stickers.send(String(b.id), { text: b.text, force: !!b.force }); return { ok: r.ok, out: (r.stdout + r.stderr).trim().slice(-300) } },
  'stickers/set': async (b) => { const r = await core.stickers.set(String(b.id), b); return { ok: r.ok, out: (r.stdout + r.stderr).trim().slice(-300) } },
  'stickers/trash': async (b) => { const r = await core.stickers.trash(String(b.id)); return { ok: r.ok, out: r.stdout.trim() } },
  'stickers/restore': async (b) => { const r = await core.stickers.restore(String(b.id)); return { ok: r.ok, out: r.stdout.trim() } },
  'docs/write': async (b) => core.docs.write(String(b.name), String(b.content ?? '')),
  'params': async (b) => core.pluginParams.write(b.values || {}, b.socialWarning),
  'allowlist': async (b) => core.pluginParams.saveAllowlist(b),
  'backup': async () => core.backupNow(),
}

async function handle(req, res, conn) {
  const deny = trustFailure(req, conn)
  if (deny !== null) { res.statusCode = deny; res.end('forbidden'); return }
  const url = new URL(req.url || '/', 'http://x')
  let rel = decodeURIComponent(url.pathname.slice(PREFIX.length)).replace(/^\/+/, '')
  const method = String(req.method || 'GET').toUpperCase()

  if (rel === '' || rel === 'ui') return serveFile(res, path.join(ASSETS, 'index.html'))
  if (rel === 'widget.js') return serveFile(res, path.join(ASSETS, 'widget.js'))
  if (rel === 'console.js') return serveFile(res, path.join(ASSETS, 'console.js'))
  if (rel === 'console.css') return serveFile(res, path.join(ASSETS, 'console.css'))

  if (!rel.startsWith('api/')) { res.writeHead(404); res.end('not found'); return }
  const ep = rel.slice(4)
  try {
    if (method === 'GET' && ep === 'csrf') return json(res, 200, { token: CSRF })
    if (method === 'GET' && ep === 'voice/ref') {
      const f = voiceRefs.refFile(url.searchParams.get('name') || '')
      if (!f) { res.writeHead(404); res.end('no ref'); return }
      return serveFile(res, f, { cache: false })
    }
    if (method === 'GET' && ep === 'qr.png') {
      const buf = core.qrBuffer()
      if (!buf) { res.writeHead(404); res.end('no qr'); return }
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', 'content-length': buf.length }); res.end(buf); return
    }
    if (method === 'GET' && ep === 'stickers/file') {
      const f = core.stickers.file(url.searchParams.get('id') || '')
      if (!f) { res.writeHead(404); res.end('no file'); return }
      return serveFile(res, f, { cache: true })
    }
    if (method === 'GET' && ep === 'logs/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' })
      const off = core.onLog((rec) => { try { res.write(`data: ${JSON.stringify(rec)}\n\n`) } catch {} })
      const ka = setInterval(() => { try { res.write(': ka\n\n') } catch {} }, 15000)
      req.on('close', () => { off(); clearInterval(ka) })
      return
    }
    if (method === 'GET') {
      const fn = READ[ep]
      if (!fn) return json(res, 404, { ok: false, error: `未知接口 ${ep}` })
      return json(res, 200, await fn(url.searchParams))
    }
    if (method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' })
    if (String(req.headers['x-dsh-csrf'] || '') !== CSRF) return json(res, 403, { ok: false, error: 'CSRF token 缺失或失效，刷新面板重试' })
    if (ep === 'stickers/upload') {
      const buf = await readBody(req)
      const q = url.searchParams
      const r = await core.stickers.add(buf, q.get('name') || 'upload.png', { tags: q.get('tags') || '', desc: q.get('desc') || '' })
      return json(res, 200, { ok: r.ok, out: (r.stdout + r.stderr).trim().slice(-300) })
    }
    if (ep === 'voice/upload') {
      const buf = await readBody(req, 30 * 1024 * 1024)
      return json(res, 200, { ok: true, upload: voiceRefs.uploadFile(buf, url.searchParams.get('name') || 'upload.wav') })
    }
    const fn = WRITE[ep]
    if (!fn) return json(res, 404, { ok: false, error: `未知接口 ${ep}` })
    return json(res, 200, await fn(await readJson(req)))
  } catch (e) {
    return json(res, 400, { ok: false, error: e?.message ?? String(e) })
  }
}

// ───── 桌面端注入行（内联 script，吞掉 onerror） ─────
const ROW_TEXT =
  '(function(){try{if(window.__DSH_XIAOYU_QQBOT_WIDGET__)return;var d=document.body||document.documentElement;if(!d)return;' +
  'var s=document.createElement("script");s.src="' + PREFIX + '/widget.js";s.onerror=function(){};d.appendChild(s)}catch(e){}})()'

export function apply(root) {
  const disposers = []
  root.effect(() => () => { for (const d of disposers) { try { d() } catch {} } try { core.stopWatchdog() } catch {} })

  // ① 桌面端结构化注入行：必须在 apply() 最开头注册（宿主启动时一次性收集）
  disposers.push(root.on('webserver/index-inject', (table) => {
    try {
      if (!Array.isArray(table)) return
      for (const row of table) {
        if (row && row.kind === 'script' && typeof row.text === 'string' && row.text.indexOf(PREFIX + '/widget.js') >= 0) return
      }
      table.push({ kind: 'script', placement: 'body', text: ROW_TEXT })
    } catch {}
  }))

  // ② 其余逻辑等 webServer 就绪
  root.inject(['webServer'], (ctx) => {
    const fence = () => { try { return ctx.get('connection') || ctx.connection } catch { return null } }
    disposers.push(ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler: (req, res) => handle(req, res, fence()) }))
    disposers.push(ctx.webServer.tapIndex((html) => {
      if (html.indexOf(PREFIX + '/widget.js') !== -1) return html
      const tag = '<script defer src="' + PREFIX + '/widget.js"></script>'
      return html.indexOf('</body>') !== -1 ? html.replace('</body>', tag + '</body>') : html + tag
    }))

    // 启动：给已有的 NapCat/AstrBot/TTS 日志文件挂 tail（DSH 重启后无缝接管），再按配置自启与守护
    core.bootstrap()
    core.tailAll()
    const cfg = core.loadConfig()
    ;(async () => {
      try {
        if (cfg.autostart.astrbot) await core.startAstrbot()
        if (cfg.autostart.napcat) await core.startNapcat()
        if (cfg.autostart.tts) await core.startTts()
      } catch (e) { core.pushLog('console', '自启失败：' + (e?.message ?? e)) }
    })()
    core.pushLog('console', 'dsh-xiaoyu-qqbot 已加载（面板：' + PREFIX + '/ui）')
  })
}

export default { name, apply }
