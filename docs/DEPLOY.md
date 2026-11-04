# Windows 桌面版部署

## 前提

DSH 桌面版 >=0.2.1-rc.2；本次实测为桌面自带运行时 0.2.1-rc.5。缺少 Git / uv 时，插件自动下载固定版本并校验 SHA256，准备在部署根目录 `.deploy-tools/` 下；不修改系统 PATH 或全局 Python。所有真实配置、依赖、日志、人格、记忆与模型保留在你自己的数据目录，不提交到插件仓库。

1. 在 DSH 插件页添加 `https://gh-proxy.com/https://github.com/ZOTTALL/dsh-xiaoyu-qqbot/releases/download/v1.1.2/dsh-xiaoyu-qqbot-1.1.2.tgz`，重载组件并刷新页面。
2. 在插件「设置」填写部署根目录和 QQ 号。已有配置不要被示例覆盖；推荐使用仓库外 QQBOT_CONFIG。
3. 在「总览」点「一键部署配套环境」，选择组件。安装器不会自动登录 QQ、批准好友或开放陌生人权限。
4. 配置完 OneBot / 模型 / 权限后再启动服务，并按 [BRIDGE.md](BRIDGE.md) 验证两端桥接。

## 默认目录

```text
<部署根目录>/
  .deploy-tools/                    便携 Git / uv、托管 Python 与缓存（不分发）
  astrbot-src/                       AstrBot 固定源码 + .venv
    data/plugins/astrbot_plugin_dsh/ 官方桥接（联动安装，已有目录不覆盖）
  onekey/NapCat.Shell/               NapCat OneKey 安装器及 bootmain
  voice/GPT-SoVITS/                  可选语音源码，权重与环境另备
  memory-runtime/                    可选本地记忆 Python / ONNX 模型
  workspace/AGENTS.md                你的人格文件
  workspace/memory/                  原始记忆，不提交
  workspace/data/                    派生索引与运行配置，不提交
  logs/ backups/ tmp/
```

## AstrBot 与桥接

固定源码来自 AstrBotDevs/AstrBot。当前固定版本使用 Python >=3.12 和 pyproject.toml；部署器通过 uv 建立独立环境并安装依赖，不再尝试已移除的 requirements.txt。源码在 tmp 暂存、检出固定提交并校验入口后才发布到目标；非空异常目录保留并提示检查。

然后联动补装 CCYellowStar2/astrbot_plugin_dsh。桥接有 main.py 就保留，不覆盖现有修改或配置。首次启动 AstrBot 还需要 WebUI 初始化和 OneBot 适配器；运行中补装桥接后需重载插件。

## NapCat

下载固定版本 Windows OneKey ZIP 并校验 GitHub asset SHA256。不同 OneKey 版本的启动器可能在 bootmain 子目录；本版兼容根目录 / bootmain 探测。

这一步准备的是上游安装器 / 启动器，不是已经登录的 QQ 环境。没有完成首次初始化时明确显示 partial。请运行部署目录的 NapCatInstaller.exe，按官方步骤准备 QQ / 协议端，再配置 OneBot 并扫码。不会静默操作当前系统中另一个 QQ 或复制其登录态。

## DSH ingress

它是 **DSH 的独立插件**，不是 AstrBot 插件，也不是本控制台自带的协议服务。总览按钮先检测配置端口；缺失时通过宿主 pluginManager 请求安装固定 GitHub 提交。宿主没有该接口、已有安装未启用或需要重启时会给出指引，不伪报在线。不要在正在运行的私有 profile 上进行隔离安装测试。

## GPT-SoVITS

一键准备固定源码。预训练 / 自训练模型、CUDA / CPU 环境、授权参考音频体积大且因机器不同，需要按官方文档安装；因此状态为 partial。在设置页填写自己的语音 Python 路径，再应用自己的参考音频。不会附带维护者的音色。

## 本地向量环境

可选，见 [MEMORY.md](MEMORY.md)。使用单独 Python 3.11，与 AstrBot 的 3.12 环境分离；CPU 推理，不占显存，不需要 Hindsight 线上账号。

## 升级与回退

升级前备份 QQBOT_CONFIG、workspace、AstrBot 配置与桥接目录。更新公开包不更新 / 覆盖这些运行数据。回退选择 `github:ZOTTALL/dsh-xiaoyu-qqbot#v1.0.1` 并重载组件；派生向量索引可保留，旧版不会使用它。不要为回退而删除原始记忆。

陌生人好友 / 群聊及 DSH 人格 / 密钥复用见 [CHAT-MODES.md](CHAT-MODES.md)。

## 1.1.1：从 1.1.0 故障恢复

更新插件并重载后，保留已有部署根目录和配置，先点“检查 / 准备部署工具”，或直接重新部署目标组件。失败的源码暂存目录与用户文件均保留，不需要清空整个目录。新任务使用独立下载临时文件，旧的下载残片不参与校验。

组件在同一根目录下排队，同组件重复请求返回同一个正在运行的任务；不同浏览器标签也受后端保护。首次依赖下载可能较久，请看任务日志，不要用反复点击来催动。下载网络失败仍会报告错误，不会取消证书或 SHA256 校验。

NapCat 的 `partial` 明确表示启动器已准备、首次初始化待完成；GPT-SoVITS 的 `partial` 表示源码已准备、环境 / 模型待补齐。账号登录、好友 / 群权限、模型密钥仍由使用者配置，不是自动安装工具的内容。

## 1.1.2：镜像与手动入口

本插件管理的安装资源默认镜像优先、官方最后，见 [MIRRORS.md](MIRRORS.md)。镜像不命中 / 哈希错误时会换源，已校验缓存直接复用。安装失败不需要清空运行目录，不会取消证书校验或改下 latest。

直接运行 `tools/setup-memory.ps1` 可传 `-Uv C:/path/to/uv.exe`（>=0.13.7）；没传则自动准备工具。脚本需要 Node，优先发现本机 Node / 桌面 DSH 自带 Electron，也可传 `-Node`。正常控制台部署直接用 DSH 自带运行时执行 `setup-memory.mjs`，没有全局 Node 前置要求。Python 3.11.16 / 3.12.14 分别用于记忆 / AstrBot，固定包清单见 `tools/python-runtime.manifest.json`。
