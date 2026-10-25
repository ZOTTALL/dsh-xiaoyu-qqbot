# astrbot-bridge-addon 说明

这是本仓库自带的一个小型 AstrBot 插件（`astrbot-bridge-addon/`，加载后包名是
`dsh_xiaoyu_addon`），用来补充官方 `astrbot_plugin_dsh` 没有覆盖的三件事：

1. **陌生人聊天限额**：主人之外的人，超过条数自动停止回复（可配置条数、提醒文案、重新计数间隔）。
2. **自动补表情包**：给主人的短回复会尝试附带一张相关表情包（从 `workspace/stickers` 挑）。
3. **动作描写清理**：去掉模型偶尔写的"（做了个动作）"类舞台指示，QQ 消息更自然。

它通过 AstrBot 官方的 `on_decorating_result` 钩子，在**消息即将发出前**做处理，不转发、不拦截
正常消息流程，和 `astrbot_plugin_dsh` 是两个独立安装、独立运行的插件。

## 为什么不内置到一键部署里

`astrbot_plugin_dsh` 是 [CCYellowStar2](https://github.com/CCYellowStar2/astrbot_plugin_dsh)
维护的独立项目，有自己的版本号和发行节奏。本仓库不分发它的任何代码，只是假设你已经按照它的
README 装好。一键部署只处理 NapCat / AstrBot 本体 / GPT-SoVITS 这三个我们直接管理的组件。

## 安装 dsh_xiaoyu_addon

把 `astrbot-bridge-addon/` 整个目录复制到 `<AstrBot 目录>/data/plugins/dsh_xiaoyu_addon/`，
在 AstrBot WebUI 的插件页重载即可。目录名必须是 `dsh_xiaoyu_addon`（AstrBot 按目录名识别插件）。

## 关于分段发送

"一句话一条 QQ 消息"**不需要这个插件来做**：AstrBot 自带「分段回复」功能
（WebUI → 平台设置 → `segmented_reply`），按标点分段，比在插件里正则切字符串更可靠，直接在
AstrBot 后台开启即可。

## 配置

常量写在 `astrbot-bridge-addon/main.py` 顶部：

```python
_SOCIAL_LIMIT = 10
_SOCIAL_WARN_AT = 9
_SOCIAL_WINDOW_SEC = 1800
_SOCIAL_WARNING = "……"
_AUTO_STICKER_ENABLED = True
_AUTO_STICKER_MAX_CHARS = 120
_AUTO_STICKER_MIN_GAP_SEC = 20
_AUTO_STICKER_GATE_MAX = 10
```

dsh-xiaoyu-qqbot 控制台的「限额 / 白名单」页用正则直接改这些行，改完提示重启 AstrBot 生效；
也可以直接手改源码。`_SOCIAL_OWNER_IDS` 读取 `qqbot.config.json` 里的 `ownerQq`，不需要手填。
