import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function tempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-host-test-'))
  const cfgFile = path.join(dir, 'qqbot.config.json')
  fs.writeFileSync(cfgFile, JSON.stringify({ root: dir, ownerQq: '10000', botQq: '20000' }))
  process.env.QQBOT_CONFIG = cfgFile
  return dir
}

// 用最小 mock 的 ctx 起一个真实 HTTP 服务，验证路由、栅栏、CSRF 与注入行
async function boot() {
  tempRoot()
  const { apply } = await import('../lib/index.js?' + Math.random())
  const routes = []; let tap = null
  const handlersOn = {}
  const root = {
    effect() {},
    on(ev, fn) { handlersOn[ev] = fn; return () => {} },
    inject(_names, cb) {
      cb({
        get() { return null },
        webServer: { register(r) { routes.push(r); return () => {} }, tapIndex(fn) { tap = fn; return () => {} } },
      })
    },
  }
  apply(root)
  const route = routes[0]
  const server = http.createServer((req, res) => route.handler(req, res))
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, handlersOn, tap: () => tap })))
}
const call = (port, p, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
    const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ code: res.statusCode, text: Buffer.concat(c).toString('utf8'), headers: res.headers }))
  })
  req.on('error', reject); if (body) req.write(body); req.end()
})

test('桌面端注入行与网页端 tapIndex', async () => {
  const b = await boot()
  const table = []
  b.handlersOn['webserver/index-inject'](table)
  b.handlersOn['webserver/index-inject'](table) // 重复调用不应重复注入
  assert.equal(table.length, 1)
  assert.match(table[0].text, /\/dsh-xiaoyu-qqbot\/widget\.js/)
  assert.match(b.tap()('<html><body>x</body></html>'), /<script defer src="\/dsh-xiaoyu-qqbot\/widget\.js">/)
  b.server.close()
})

test('页面与静态资源可取', async () => {
  const b = await boot()
  for (const [p, re] of [['/dsh-xiaoyu-qqbot/ui', /QQ BOT 控制台/], ['/dsh-xiaoyu-qqbot/console.js', /use strict/], ['/dsh-xiaoyu-qqbot/console.css', /--pri/], ['/dsh-xiaoyu-qqbot/widget.js', /dshqq-handle/]]) {
    const r = await call(b.port, p); assert.equal(r.code, 200, p); assert.match(r.text, re, p)
    if (p.endsWith('/widget.js')) assert.doesNotMatch(r.text, /#dshqq-fab\{|dshqq-pop|window\.open\(/)
  }
  b.server.close()
})

test('只读接口：status / diagnose / params / docs / settings', async () => {
  const b = await boot()
  const st = JSON.parse((await call(b.port, '/dsh-xiaoyu-qqbot/api/status')).text)
  assert.ok(st.ports && st.login)
  assert.equal(st.configured, true)
  const settings = JSON.parse((await call(b.port, '/dsh-xiaoyu-qqbot/api/settings')).text)
  assert.ok(settings.raw.root)
  assert.ok('napcat' in settings.deploy && 'astrbot' in settings.deploy && 'tts' in settings.deploy)
  const bad = await call(b.port, '/dsh-xiaoyu-qqbot/api/docs/read?name=' + encodeURIComponent('..\\..\\Windows\\win.ini'))
  assert.equal(bad.code, 400)
  b.server.close()
})

test('栅栏：非回环 Host / 跨站 / 异源 Origin 一律拒绝', async () => {
  const b = await boot()
  assert.equal((await call(b.port, '/dsh-xiaoyu-qqbot/api/status', { headers: { host: 'evil.example.com' } })).code, 403)
  assert.equal((await call(b.port, '/dsh-xiaoyu-qqbot/api/status', { headers: { 'sec-fetch-site': 'cross-site' } })).code, 403)
  assert.equal((await call(b.port, '/dsh-xiaoyu-qqbot/api/status', { headers: { origin: 'http://evil.example.com' } })).code, 403)
  b.server.close()
})

test('写接口必须带 CSRF，且未知目标被拒；部署目标未知也被拒', async () => {
  const b = await boot()
  const noTok = await call(b.port, '/dsh-xiaoyu-qqbot/api/stop', { method: 'POST', body: '{"target":"x"}', headers: { 'content-type': 'application/json' } })
  assert.equal(noTok.code, 403)
  const { token } = JSON.parse((await call(b.port, '/dsh-xiaoyu-qqbot/api/csrf')).text)
  const r = await call(b.port, '/dsh-xiaoyu-qqbot/api/stop', { method: 'POST', body: '{"target":"bogus"}', headers: { 'content-type': 'application/json', 'x-dsh-csrf': token } })
  assert.equal(r.code, 400); assert.match(r.text, /未知目标/)
  const dis = await call(b.port, '/dsh-xiaoyu-qqbot/api/task/run', { method: 'POST', body: '{"name":"evil; calc"}', headers: { 'content-type': 'application/json', 'x-dsh-csrf': token } })
  assert.equal(dis.code, 400)
  const dep = await call(b.port, '/dsh-xiaoyu-qqbot/api/deploy', { method: 'POST', body: '{"target":"bogus"}', headers: { 'content-type': 'application/json', 'x-dsh-csrf': token } })
  assert.equal(dep.code, 400); assert.match(dep.text, /未知部署目标/)
  b.server.close()
})

test('一键部署接口：已安装时立即判定完成，不触发任何网络下载', async () => {
  const b = await boot()
  // 预先在临时根目录放一个假 NapCat 可执行文件：isNapcatInstalled() 应判定为已装，
  // deployNapcat() 据此直接跳过下载分支（真实网络请求留给人工/集成测试去验证）。
  const cfgFile = process.env.QQBOT_CONFIG
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
  const napcatExe = path.join(cfg.root, 'onekey', 'NapCat.Shell', 'NapCatWinBootMain.exe')
  fs.mkdirSync(path.dirname(napcatExe), { recursive: true })
  fs.writeFileSync(napcatExe, '')

  const { token } = JSON.parse((await call(b.port, '/dsh-xiaoyu-qqbot/api/csrf')).text)
  const h = { 'content-type': 'application/json', 'x-dsh-csrf': token }
  const r = await call(b.port, '/dsh-xiaoyu-qqbot/api/deploy', { method: 'POST', body: '{"target":"napcat"}', headers: h })
  assert.equal(r.code, 200)
  const body = JSON.parse(r.text)
  assert.ok(body.job.id)
  await new Promise((resolve) => setTimeout(resolve, 50))
  const jr = await call(b.port, '/dsh-xiaoyu-qqbot/api/deploy/job?id=' + body.job.id)
  const job = JSON.parse(jr.text).job
  assert.equal(job.status, 'done')
  assert.ok(job.steps.some((s) => s.text.includes('已检测到 NapCat')))
  b.server.close()
})

