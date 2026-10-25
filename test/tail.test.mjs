import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function tempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-tail-test-'))
  const cfgFile = path.join(dir, 'qqbot.config.json')
  fs.writeFileSync(cfgFile, JSON.stringify({ root: dir, ownerQq: '10000', botQq: '20000' }))
  process.env.QQBOT_CONFIG = cfgFile
  return dir
}

test('tail：追加到日志文件的内容会进入日志环，并解析登录状态', async () => {
  tempRoot()
  const core = await import('../lib/core.mjs?' + Math.random())
  const file = core.LOGFILE('napcat')
  core.ensureDir(path.dirname(file))
  fs.writeFileSync(file, '')
  assert.equal(core.tailAttach('napcat', { fromStart: true }), true)
  fs.appendFileSync(file, '10-24 14:00:00 [warn] 请扫描下面的二维码，然后在手Q上授权登录：\n')
  await sleep(1600)
  const lines = core.recentLogs('napcat', 20)
  assert.ok(lines.some((l) => l.text.includes('请扫描下面的二维码')), JSON.stringify(lines.slice(-3)))
  assert.equal(core.login.phase, 'qr')
  // 半行不应被当作完整行推入
  fs.appendFileSync(file, '10-24 14:00:05 [info] 半行')
  await sleep(1600)
  assert.ok(!core.recentLogs('napcat', 20).some((l) => l.text.includes('半行')))
  fs.appendFileSync(file, '结束\n')
  await sleep(1600)
  assert.ok(core.recentLogs('napcat', 20).some((l) => l.text.includes('半行结束')))
  fs.writeFileSync(file, '')
})

test('sleep', async () => { await sleep(10); assert.ok(true) })
