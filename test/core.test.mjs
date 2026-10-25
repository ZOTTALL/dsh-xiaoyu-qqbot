import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 每个测试用一个独立临时根目录 + 独立 qqbot.config.json，互不干扰、不碰真实部署。
function tempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-test-'))
  const cfgFile = path.join(dir, 'qqbot.config.json')
  fs.writeFileSync(cfgFile, JSON.stringify({ root: dir, ownerQq: '10000', botQq: '20000' }))
  process.env.QQBOT_CONFIG = cfgFile
  return dir
}

const HERE = path.dirname(fileURLToPath(import.meta.url))

async function freshCore() {
  // core.mjs 内部用模块级缓存，用查询串强制拿一份新实例，隔离各测试的 QQBOT_CONFIG。
  const mod = await import('../lib/core.mjs?' + Math.random())
  return mod
}

test('NapCat 登录状态机：二维码 → 扫码 → 风控168', async () => {
  tempRoot()
  const core = await freshCore()
  const feed = (line) => core.pushLog('napcat', line, { persist: false })
  feed('10-24 13:27:55 [warn] 请扫描下面的二维码，然后在手Q上授权登录：')
  assert.equal(core.login.phase, 'qr')
  feed('二维码解码URL: https://txz.qq.com/p?k=abc&f=1600001604')
  assert.equal(core.login.qrUrl, 'https://txz.qq.com/p?k=abc&f=1600001604')
  feed('10-24 13:29:44 [info] [Core] [Login] 二维码已被扫描，等待确认...')
  assert.equal(core.login.phase, 'scanned')
  feed('10-24 13:29:52 [error] [Core] [Login] Login Error , ErrInfo:  [1,{"account":"20000","serverErrorCode":168,"title":"","message":"你的账号近期存在安全风险，部分功能使用受限，请登录最新手机QQ并根据提示恢复账号使用。","additionalType":0}]')
  assert.equal(core.login.phase, 'blocked')
  assert.equal(core.login.code, 168)
  assert.match(core.login.message, /风控/)
})

test('NapCat 登录状态机：上线与被踢', async () => {
  tempRoot()
  const core = await freshCore()
  const feed = (line) => core.pushLog('napcat', line, { persist: false })
  feed('10-24 13:33:38 [info] [OneBot] [HTTP Server Adapter] Start On 127.0.0.1:3002')
  assert.equal(core.login.phase, 'online')
  feed('10-24 02:50:24 [info] 账号状态变更为离线')
  assert.equal(core.login.phase, 'error')
})

test('日志过滤二维码方块与 ANSI 颜色', async () => {
  tempRoot()
  const core = await freshCore()
  const feed = (line) => core.pushLog('napcat', line, { persist: false })
  const before = core.recentLogs('napcat', 999).length
  feed('█▄▄▄▄▄▄▄█▄█▄█▄███▄▄▄█▄▄███▄███▄▄███')
  feed('\x1b[32m10-24 13:33:38 [info]\x1b[39m 配置加载')
  const logs = core.recentLogs('napcat', 999)
  assert.equal(logs.length, before + 1)
  assert.ok(!logs.at(-1).text.includes('\x1b'))
})

test('插件参数读取与写入（临时副本）', async () => {
  const root = tempRoot()
  const core = await freshCore()
  const addonDir = path.join(root, 'astrbot-src', 'data', 'plugins', 'dsh_xiaoyu_addon')
  fs.mkdirSync(addonDir, { recursive: true })
  const sample = fs.readFileSync(path.join(HERE, '..', 'astrbot-bridge-addon', 'main.py'), 'utf8')
  fs.writeFileSync(path.join(addonDir, 'main.py'), sample)
  const r = core.pluginParams.read()
  assert.ok(r.params.find((p) => p.key === 'socialLimit' && p.value === 10), 'socialLimit=10')
  assert.ok(r.params.find((p) => p.key === 'autoStickerEnabled' && typeof p.value === 'boolean'))
})

test('状态汇总可运行', async () => {
  tempRoot()
  const core = await freshCore()
  const st = await core.status()
  assert.ok('ports' in st && 'login' in st && 'procs' in st)
  assert.ok(['ok', 'degraded'].includes(st.chain))
  assert.equal(st.configured, true)
})

test('未配置时 configured=false，启停给出明确提示', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-test-'))
  const cfgFile = path.join(dir, 'qqbot.config.json')
  fs.writeFileSync(cfgFile, JSON.stringify({ root: dir, ownerQq: '', botQq: '' }))
  process.env.QQBOT_CONFIG = cfgFile
  const core = await freshCore()
  const st = await core.status()
  assert.equal(st.configured, false)
  await assert.rejects(core.startNapcat(), /机器人账号|不存在/)
})

test('白名单文件列表包含 AGENTS.md 与 voice.json', async () => {
  const root = tempRoot()
  const core = await freshCore()
  fs.mkdirSync(path.join(root, 'workspace', 'memory'), { recursive: true })
  fs.writeFileSync(path.join(root, 'workspace', 'AGENTS.md'), '# test')
  fs.writeFileSync(path.join(root, 'workspace', 'voice.json'), '{}')
  const names = core.docs.list().map((d) => d.name)
  assert.ok(names.includes('AGENTS.md'))
  assert.ok(names.includes('voice.json'))
  assert.throws(() => core.docs.read('../../Windows/win.ini'), /白名单/)
})

test('表情包统计与检索', async () => {
  const root = tempRoot()
  const core = await freshCore()
  const stickersDir = path.join(root, 'workspace', 'stickers')
  fs.mkdirSync(stickersDir, { recursive: true })
  fs.writeFileSync(path.join(stickersDir, 'index.json'), JSON.stringify({
    items: { a1: { id: 'a1', file: path.join(stickersDir, 'a1.png'), tags: ['开心'], layer: 'library', capturedAt: Date.now() / 1000 } },
    sends: [],
  }))
  const s = core.stickers.stats()
  assert.ok(s.total > 0)
  assert.ok(core.stickers.list({ q: '开心' }).length >= 0)
})
