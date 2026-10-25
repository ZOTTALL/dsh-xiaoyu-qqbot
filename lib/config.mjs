// dsh-xiaoyu-qqbot —— 统一配置层。
//
// 所有会跟着部署环境变化的东西（根目录、各组件版本目录、端口、主人/机器人 QQ 号、
// Python 解释器路径）都从这里读，禁止在其他文件里写死路径或 QQ 号。
//
// 配置文件优先级（从高到低）：
//   1. 环境变量 QQBOT_CONFIG（指向一个 json 文件的绝对路径）
//   2. <本插件目录>/qqbot.config.json（随仓库一起、不提交真实值，见 .gitignore）
//   3. 内置默认值（假设一个干净的全新部署，路径均在 ROOT 下）
//
// 首次运行若找不到配置文件，会在 (2) 的位置写一份默认值，方便用户直接改。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.join(HERE, '..')
// 用函数而不是冻在模块加载时的 const：QQBOT_CONFIG 可能在测试里按用例切换，
// 一旦固化成 const，缓存的 config.mjs 模块实例就会一直指向第一次看到的文件。
export function configFilePath() { return process.env.QQBOT_CONFIG || path.join(PLUGIN_ROOT, 'qqbot.config.json') }
/** @deprecated 用 configFilePath()；留这个只是兼容外部直接读「当前」路径的调用点。 */
export function CONFIG_FILE_NOW() { return configFilePath() }

// 一个全新部署时的合理默认：把所有东西都放在同一个根目录下。
// 用户可以把根目录指到别处（比如已经装好的 NapCat/AstrBot 所在位置），
// 其余相对路径会跟着根目录走，不需要逐项改。
function defaultRoot() {
  // Windows：优先用当前盘根下的 DSH-QQBOT；没有合适信息就退回用户目录。
  if (process.platform === 'win32') {
    const drive = (process.env.SystemDrive || 'C:').replace(/\\$/, '')
    return `${drive}\\DSH-QQBOT`
  }
  return path.join(os.homedir(), 'dsh-qqbot')
}

export const DEFAULTS = {
  // ── 部署根目录；其余相对路径均在它之下 ──
  root: defaultRoot(),
  // ── 身份：主人（唯一不受陌生人限额的 QQ 号）与机器人小号 ──
  // 两者都是占位符：用户必须在「设置」里填自己的号才能真正收发消息。
  ownerQq: '',
  botQq: '',
  // ── 端口 ──
  ports: { napcatHttp: 3002, napcatWebui: 6099, astrbotUi: 6185, astrbotWs: 6199, ingress: 3188, tts: 9880 },
  // ── 各组件相对根目录的子路径（遵循本项目 docs/DEPLOY.md 的目录约定） ──
  paths: {
    napcatDir: 'onekey/NapCat.Shell',
    napcatExe: 'onekey/NapCat.Shell/NapCatWinBootMain.exe',
    // NapCat 的二维码/配置目录藏在 versions/<具体版本号>/ 下，版本号随发行版变化；
    // 留空表示「自动在 napcatDir 下找最新的 versions/* 目录」，见 lib/core.mjs 的 resolveNapcatVersionDir()。
    napcatVersionDir: '',
    astrbotDir: 'astrbot-src',
    astrbotVenvPy: 'astrbot-src/.venv/Scripts/python.exe',
    astrbotPluginMain: 'astrbot-src/data/plugins/astrbot_plugin_dsh/main.py',
    astrbotPluginCfg: 'astrbot-src/data/config/astrbot_plugin_dsh_config.json',
    addonDir: 'astrbot-src/data/plugins/dsh_xiaoyu_addon',
    workspace: 'workspace',
    agents: 'workspace/AGENTS.md',
    memoryDir: 'workspace/memory',
    stickersDir: 'workspace/stickers',
    stickerIndex: 'workspace/stickers/index.json',
    voiceCfg: 'workspace/voice.json',
    voiceRefDir: 'voice/ref',
    voiceDir: 'voice/GPT-SoVITS',
    logsDir: 'logs',
    backupsDir: 'backups',
    tmpDir: 'tmp',
  },
  // ── 外部解释器 ──（GPT-SoVITS 通常用独立的 conda/venv，和 AstrBot 的不是同一个）
  voicePy: '',
  // ── 守护 / 自启（与原来一致的默认值） ──
  watchdog: { enabled: false, intervalSec: 30, restartAstrbot: true, restartNapcat: false, maxRestartsPerHour: 3 },
  autostart: { napcat: false, astrbot: false, tts: false },
}

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object') return base
  const out = Array.isArray(base) ? [...base] : { ...base }
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object'
      ? deepMerge(base[k], v) : v
  }
  return out
}

// cached 按配置文件路径分桶：同一进程内 QQBOT_CONFIG 切换（主要发生在测试里，每个用例一个
// 临时配置文件）时不会互相读到对方缓存的值；生产环境里通常只有一个路径，等价于单值缓存。
const cachedByPath = new Map()
export function loadRawConfig({ fresh = false } = {}) {
  const file = configFilePath()
  if (!fresh && cachedByPath.has(file)) return cachedByPath.get(file)
  let onDisk = {}
  try { onDisk = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) } catch { onDisk = null }
  if (onDisk === null) {
    // 配置文件不存在或损坏：写一份默认值，方便用户直接打开编辑。
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(DEFAULTS, null, 2), 'utf8')
    } catch {}
    onDisk = {}
  }
  const merged = deepMerge(DEFAULTS, onDisk)
  cachedByPath.set(file, merged)
  return merged
}
export function saveRawConfig(patch) {
  const file = configFilePath()
  const next = deepMerge(loadRawConfig(), patch)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
  fs.renameSync(tmp, file)
  cachedByPath.set(file, next)
  return next
}
export function invalidate() { cachedByPath.delete(configFilePath()) }

/** 把配置里的相对路径解析成绝对路径；已是绝对路径（含盘符）的直接返回。 */
function abs(root, p) {
  if (!p) return p
  if (path.isAbsolute(p)) return p
  return path.join(root, p)
}

/** 自动探测 NapCat 的 versions/<version> 目录（取字典序最大的一个，通常也是最新的）。 */
export function resolveNapcatVersionDir(cfg) {
  const configured = cfg.paths.napcatVersionDir
  if (configured) return abs(cfg.root, configured)
  const napcatDir = abs(cfg.root, cfg.paths.napcatDir)
  try {
    const versionsDir = path.join(napcatDir, 'versions')
    const entries = fs.readdirSync(versionsDir, { withFileTypes: true }).filter((e) => e.isDirectory())
    if (!entries.length) return null
    entries.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))
    return path.join(versionsDir, entries[0].name)
  } catch { return null }
}

/** 构造一份带绝对路径的运行时视图（PATHS/PORTS/身份等），供 core.mjs 等消费。 */
export function resolvePaths(cfg = loadRawConfig()) {
  const root = cfg.root
  const napcatVersionDir = resolveNapcatVersionDir(cfg)
  return {
    root,
    napcatDir: abs(root, cfg.paths.napcatDir),
    napcatExe: abs(root, cfg.paths.napcatExe),
    napcatQr: napcatVersionDir ? path.join(napcatVersionDir, 'resources', 'app', 'napcat', 'cache', 'qrcode.png') : null,
    napcatConfigDir: napcatVersionDir ? path.join(napcatVersionDir, 'resources', 'app', 'napcat', 'config') : null,
    astrbotDir: abs(root, cfg.paths.astrbotDir),
    astrbotPy: abs(root, cfg.paths.astrbotVenvPy),
    astrbotPluginMain: abs(root, cfg.paths.astrbotPluginMain),
    astrbotPluginCfg: abs(root, cfg.paths.astrbotPluginCfg),
    addonDir: abs(root, cfg.paths.addonDir),
    workspace: abs(root, cfg.paths.workspace),
    agents: abs(root, cfg.paths.agents),
    memoryDir: abs(root, cfg.paths.memoryDir),
    stickersDir: abs(root, cfg.paths.stickersDir),
    stickerIndex: abs(root, cfg.paths.stickerIndex),
    voiceCfg: abs(root, cfg.paths.voiceCfg),
    voiceRefDir: abs(root, cfg.paths.voiceRefDir),
    voiceDir: abs(root, cfg.paths.voiceDir),
    voicePy: cfg.voicePy || '',
    logsDir: abs(root, cfg.paths.logsDir),
    backupsDir: abs(root, cfg.paths.backupsDir),
    tmpDir: abs(root, cfg.paths.tmpDir),
    toolsDir: path.join(PLUGIN_ROOT, 'tools'),
  }
}

export function ownerQq(cfg = loadRawConfig()) { return String(cfg.ownerQq || '').trim() }
export function botQq(cfg = loadRawConfig()) { return String(cfg.botQq || '').trim() }
export function ports(cfg = loadRawConfig()) { return cfg.ports }
export function isConfigured(cfg = loadRawConfig()) {
  return !!(ownerQq(cfg) && botQq(cfg) && fs.existsSync(cfg.root))
}

export { PLUGIN_ROOT }
