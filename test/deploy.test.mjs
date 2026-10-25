import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function tempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-deploy-test-'))
  const cfgFile = path.join(dir, 'qqbot.config.json')
  fs.writeFileSync(cfgFile, JSON.stringify({ root: dir, ownerQq: '10000', botQq: '20000' }))
  process.env.QQBOT_CONFIG = cfgFile
  return dir
}
async function freshDeploy() { return import('../lib/deploy.mjs?' + Math.random()) }

test('检测函数：全新目录判定三个组件都未安装', async () => {
  tempRoot()
  const deploy = await freshDeploy()
  const status = deploy.groupedDeployStatus()
  assert.deepEqual(status, { napcat: false, astrbot: false, tts: false })
})

test('检测函数：放好对应文件后判定已安装（幂等跳过网络的前提）', async () => {
  const root = tempRoot()
  const deploy = await freshDeploy()
  fs.mkdirSync(path.join(root, 'onekey', 'NapCat.Shell'), { recursive: true })
  fs.writeFileSync(path.join(root, 'onekey', 'NapCat.Shell', 'NapCatWinBootMain.exe'), '')
  fs.mkdirSync(path.join(root, 'astrbot-src', '.venv', 'Scripts'), { recursive: true })
  fs.writeFileSync(path.join(root, 'astrbot-src', '.venv', 'Scripts', 'python.exe'), '')
  fs.writeFileSync(path.join(root, 'astrbot-src', 'main.py'), '')
  fs.mkdirSync(path.join(root, 'voice', 'GPT-SoVITS'), { recursive: true })
  fs.writeFileSync(path.join(root, 'voice', 'GPT-SoVITS', 'api_v2.py'), '')
  assert.deepEqual(deploy.groupedDeployStatus(), { napcat: true, astrbot: true, tts: true })
})

test('deployNapcat 在已安装时立即 done，不触发下载', async () => {
  const root = tempRoot()
  const deploy = await freshDeploy()
  fs.mkdirSync(path.join(root, 'onekey', 'NapCat.Shell'), { recursive: true })
  fs.writeFileSync(path.join(root, 'onekey', 'NapCat.Shell', 'NapCatWinBootMain.exe'), '')
  const r = await deploy.deployNapcat()
  const job = await new Promise((resolve) => {
    const tick = () => { const j = deploy.getDeployJob(r.id); if (j.status !== 'running') resolve(j); else setTimeout(tick, 20) }
    tick()
  })
  assert.equal(job.status, 'done')
  assert.ok(job.steps.some((s) => s.text.includes('已检测到 NapCat')))
})

test('checkIngress 返回明确的 ok/detail 或 ok/hint 形状，不抛异常', async () => {
  tempRoot()
  const deploy = await freshDeploy()
  const r = await deploy.checkIngress()
  assert.equal(typeof r.ok, 'boolean')
  if (r.ok) assert.ok('detail' in r)
  else assert.ok(typeof r.hint === 'string' && r.hint.length > 0)
})
