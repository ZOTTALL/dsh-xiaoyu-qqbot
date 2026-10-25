import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function tempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-voice-test-'))
  const cfgFile = path.join(dir, 'qqbot.config.json')
  fs.writeFileSync(cfgFile, JSON.stringify({ root: dir, ownerQq: '10000', botQq: '20000' }))
  process.env.QQBOT_CONFIG = cfgFile
  return dir
}
async function fresh() {
  const core = await import('../lib/core.mjs?' + Math.random())
  const refs = await import('../lib/voice-refs.mjs?' + Math.random())
  return { core, refs }
}

test('voice refs: upload filename/path safe and refs are bounded', async () => {
  const root = tempRoot()
  const { core, refs } = await fresh()
  const u = refs.uploadFile(Buffer.alloc(1024, 1), 'sample.wav')
  assert.ok(u.id.includes('sample.wav'))
  const safe = refs.uploadFile(Buffer.alloc(1024), '../evil.wav')
  assert.ok(!safe.id.includes('..'))
  const f = refs.refFile('not-a-path')
  assert.equal(f, null)
  // 放一个真实参考文件再测试 applyRefConfig
  const refDir = path.join(root, 'voice', 'ref')
  fs.mkdirSync(refDir, { recursive: true })
  fs.writeFileSync(path.join(refDir, 'reference.wav'), Buffer.alloc(16))
  const cfg = refs.applyRefConfig({ api: 'x' }, 'reference.wav', '准确台词')
  assert.ok(cfg.ref_audio.endsWith('reference.wav'))
  assert.equal(cfg.prompt_text, '准确台词')
  void core
})

test('voice refs: missing file rejected', async () => {
  tempRoot()
  const { refs } = await fresh()
  assert.throws(() => refs.startPrepare('missing-id', { durationSec: 6 }), /不存在/)
})
