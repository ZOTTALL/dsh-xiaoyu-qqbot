# 配置说明

所有运行期配置都在一个 JSON 文件里：`qqbot.config.json`（插件目录下，首次加载自动生成默认值）。
可以在控制台「设置」页改，也可以直接编辑这个文件。

## 字段

```jsonc
{
  "root": "D:\\QQBot",       // 部署根目录，其余相对路径都在它之下
  "ownerQq": "",              // 主人 QQ 号（唯一不受陌生人限额的号），必填才能收发消息
  "botQq": "",                // 机器人账号 QQ 号（登录 NapCat 用），必填才能启动 NapCat
  "ports": {
    "napcatHttp": 3002, "napcatWebui": 6099,
    "astrbotUi": 6185, "astrbotWs": 6199,
    "ingress": 3188, "tts": 9880
  },
  "paths": {
    "napcatDir": "onekey/NapCat.Shell",
    "astrbotDir": "astrbot-src",
    "astrbotVenvPy": "astrbot-src/.venv/Scripts/python.exe",
    "astrbotPluginMain": "astrbot-src/data/plugins/astrbot_plugin_dsh/main.py",
    "astrbotPluginCfg": "astrbot-src/data/config/astrbot_plugin_dsh_config.json",
    "addonDir": "astrbot-src/data/plugins/dsh_xiaoyu_addon",
    "workspace": "workspace",
    "voiceRefDir": "voice/ref",
    "voiceDir": "voice/GPT-SoVITS",
    "logsDir": "logs",
    "backupsDir": "backups"
    // …完整默认值见 lib/config.mjs 的 DEFAULTS
  },
  "voicePy": "",               // GPT-SoVITS 的 Python 解释器完整路径
  "watchdog": { "enabled": false, "intervalSec": 30, "restartAstrbot": true, "restartNapcat": false, "maxRestartsPerHour": 3 },
  "autostart": { "napcat": false, "astrbot": false, "tts": false }
}
```

`paths.*` 支持相对路径（相对 `root`）或绝对路径——已经有现成部署、目录结构不一样时，把对应项
改成绝对路径即可，不用整体搬家。

## 环境变量

- `QQBOT_CONFIG`：覆盖配置文件位置（绝对路径）。Node 端（`lib/config.mjs`）和 Python 端
  （`tools/qqbot_config.py`）读的是同一份文件，字段含义一致。
- `QQBOT_ASTRBOT_PY`：`tools/*.bat` 调用 Python 脚本时优先用这个解释器（通常填 AstrBot 的
  `.venv/Scripts/python.exe`）。

## 身份与隐私

`ownerQq` / `botQq` 不会被提交进仓库——`.gitignore` 已经排除了生成后的 `qqbot.config.json`。
如果你 fork 本仓库继续开发，记得检查有没有不小心把真实号码写进了提交。
