"""共享配置读取：所有 tools/*.py 都从这里拿根目录、端口、QQ 号，不再写死路径。

优先级：环境变量 QQBOT_CONFIG 指定的文件 > 本插件目录下的 qqbot.config.json > 内置默认值。
与 lib/config.mjs 是同一份配置文件，字段含义保持一致（见该文件顶部注释）。
"""
from __future__ import annotations

import json
import os
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_PLUGIN_ROOT = _HERE.parent

DEFAULTS = {
    "root": os.environ.get("SystemDrive", "C:") + "\\DSH-QQBOT",
    "ownerQq": "",
    "botQq": "",
    "ports": {"napcatHttp": 3002, "napcatWebui": 6099, "astrbotUi": 6185, "astrbotWs": 6199, "ingress": 3188, "tts": 9880},
    "paths": {
        "napcatDir": "onekey/NapCat.Shell",
        "astrbotDir": "astrbot-src",
        "workspace": "workspace",
        "memoryDir": "workspace/memory",
        "stickersDir": "workspace/stickers",
        "stickerIndex": "workspace/stickers/index.json",
        "voiceCfg": "workspace/voice.json",
        "voiceRefDir": "voice/ref",
        "voiceDir": "voice/GPT-SoVITS",
        "logsDir": "logs",
        "backupsDir": "backups",
        "tmpDir": "tmp",
    },
    "voicePy": "",
}


def _config_path() -> Path:
    env = os.environ.get("QQBOT_CONFIG", "").strip()
    if env:
        return Path(env)
    return _PLUGIN_ROOT / "qqbot.config.json"


def _deep_merge(base: dict, patch: dict) -> dict:
    out = dict(base)
    for k, v in (patch or {}).items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            out[k] = _deep_merge(base[k], v)
        else:
            out[k] = v
    return out


def load() -> dict:
    p = _config_path()
    try:
        on_disk = json.loads(p.read_text(encoding="utf-8-sig"))
    except Exception:
        on_disk = {}
    return _deep_merge(DEFAULTS, on_disk if isinstance(on_disk, dict) else {})


def path_for(cfg: dict, key: str) -> Path:
    root = Path(cfg["root"])
    rel = cfg["paths"][key]
    p = Path(rel)
    return p if p.is_absolute() else root / rel


def owner_qq(cfg: dict) -> int:
    v = str(cfg.get("ownerQq") or "").strip()
    return int(v) if v.isdigit() else 0


def bot_qq(cfg: dict) -> int:
    v = str(cfg.get("botQq") or "").strip()
    return int(v) if v.isdigit() else 0
