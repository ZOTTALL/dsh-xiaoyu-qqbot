# 两端桥接与 GitHub 联动

消息路径：`QQ → NapCat / OneBot → AstrBot + astrbot_plugin_dsh → DSH + dsh-astrbot-ingress`。

## 安装

在总览点「一键部署配套环境」，勾选 AstrBot 和 ingress。AstrBot 的安装流程无论是否跳过已有环境，都会再检查官方桥接；也可单独点「检测 / 补装 DSH 桥接」。

安装器先在部署根目录的 tmp 暂存区初始化 Git 仓库、拉取 `tools/upstreams.json` 固定提交并校验 HEAD，确认 main.py / metadata.yaml 存在；上游若有 requirements.txt，则安装到 AstrBot 自己的虚拟环境。全部成功后才原子移动到 `data/plugins/astrbot_plugin_dsh`。失败暂存保留便于排查，不留下可被 AstrBot 误加载的半成品目录。

已有目录一律保留，不覆盖用户对桥接的修改，也不读写它的账号 / token 配置。目录存在但不完整时提示人工检查，不用 git reset 或强制覆盖“修复”。需要升级该上游时，先备份该插件目录和对应配置，再按上游说明更新。

DSH 一侧先用自动准备的 Git 获取固定 ingress 提交、校验 HEAD 并生成部署目录内的本地压缩包，再通过宿主 pluginManager 安装该包（`file:` 绝对路径），避免 DSH 包管理器依赖系统 Git。该本地包作为依赖来源保留在 `.deploy-tools/`，不要在包仍被引用时删除。已有服务在线就不改动；缺少宿主安装接口时给出 DSH 插件页指引；需要启用 / 重启时标记 partial，而不是声称在线。

## 加载与配置

- AstrBot 尚未启动：装好后随下次启动加载。
- AstrBot 正在运行：在 AstrBot WebUI 重载「DSH 桥」，或自行确认后重启 AstrBot。
- 同机桥接可根据上游说明自动发现 DSH ingress 信标；容器部署按上游配置 token / 地址映射。
- 安装器不复制 DSH 凭据，不改管理员、用户 / 群白名单或 private_passthrough。
- 最后按上游示例发送 `/dsh 你好` 自行验证；测试前应确认聊天接收方与可授予的工具权限。

上游文档：[AstrBot DSH 桥](https://github.com/CCYellowStar2/astrbot_plugin_dsh)、[DSH ingress](https://github.com/CCYellowStar2/dsh-astrbot-ingress)。

命令行等价入口（使用自己的 QQBOT_CONFIG）：

```powershell
node tools/install-bridge.mjs
```

GitHub 安装的是公开上游，而不是维护者私有环境中改动过的桥接文件。本项目自己的可选陌生人限额扩展仍按 [ADDON.md](ADDON.md) 单独安装。
