# 部署说明

本插件管理四个组件，面板「总览」页每个组件都有自己的卡片：

| 组件 | 作用 | 一键部署能做到什么 |
|---|---|---|
| NapCat | QQ 协议端，机器人账号登录用它 | 下载官方一体包、解压到部署根目录 |
| AstrBot | QQ ⇄ LLM 网关 | `git clone` 官方仓库、建 venv、`pip install` |
| GPT-SoVITS | 语音合成 | `git clone` 官方仓库；权重/独立环境需手动按官方文档装 |
| DSH ingress | DSH 桌面端自带的入站插件 | 不部署，只检测是否可用并给出修复提示 |

## 目录约定

一键部署和各工具脚本都假设这样的目录结构（根目录在「设置」页配置，默认 `%SystemDrive%\DSH-QQBOT`）：

```
<根目录>/
├─ onekey/NapCat.Shell/          NapCat 一体包
├─ astrbot-src/                  AstrBot 源码 + .venv
│  └─ data/plugins/
│     ├─ astrbot_plugin_dsh/     官方 DSH 桥接插件（需要你单独装，见下）
│     └─ dsh_xiaoyu_addon/       本插件附带的扩展（见 docs/ADDON.md）
├─ voice/
│  ├─ GPT-SoVITS/                GPT-SoVITS 源码
│  └─ ref/                       参考音色 wav
├─ workspace/                    机器人人设与记忆（见 persona-template/）
│  ├─ AGENTS.md
│  ├─ memory/
│  ├─ stickers/
│  └─ voice.json
├─ logs/
├─ backups/
└─ tmp/
```

如果你已经在别的地方装过 NapCat/AstrBot，不用重新部署：把「设置」页的根目录和各组件相对路径
指过去即可（相对路径在 `qqbot.config.json` 的 `paths.*` 字段里改，或让它们保持绝对路径）。

## 必须手动做的两步

1. **安装官方 `astrbot_plugin_dsh`**：到 <https://github.com/CCYellowStar2/astrbot_plugin_dsh>
   按它的 README 装进 AstrBot（AstrBot WebUI → 插件市场 搜索安装，或手动放进
   `astrbot-src/data/plugins/`）。本插件的面板会读写它的配置和限额常量，但不会替你装它——
   这是一个独立维护的第三方项目。
2. **启用 DSH 侧的 `dsh-astrbot-ingress`**：DSH 桌面端自带，在 profile 里启用即可，面板「总览」
   的 DSH ingress 卡片会显示它是否可用。

## GPT-SoVITS 的额外步骤

一键部署只会 `git clone` 源码。接下来你还需要：

1. 按官方仓库的 `install.sh`（或一键包）装好预训练模型权重和依赖；
2. 准备一个独立的 Python 环境（官方推荐 conda，因为依赖版本比较挑）；
3. 在控制台「设置」页填这个环境的 `python.exe` 完整路径。

## 验证清单

部署完成后，「总览」页的体检应该全绿；如果某一项失败，面板会给出具体提示（缺哪个可执行文件、
哪个端口没开、风控状态等）。
