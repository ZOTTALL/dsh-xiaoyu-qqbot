"""dsh_xiaoyu_addon —— QQ BOT 控制台扩展。

依赖官方 astrbot_plugin_dsh（https://github.com/CCYellowStar2/astrbot_plugin_dsh）已经装好并在跑；
本插件不转发任何消息，只在消息即将发出前（`on_decorating_result` 钩子）做三件事：

  1. 陌生人聊天限额：主人之外的人，超过条数就丢弃回复，不让对方无限占用。
  2. 短回复自动配一张表情包：从本地表情包仓库里按关键词挑一张，附带发出。
  3. 清理舞台动作括号：模型偶尔会写"（做了个动作）"这类描写，QQ 消息里默认去掉。

分段发送（一句一条消息）**不需要我们做**：AstrBot 自带「分段回复」功能
（WebUI → 平台设置 → segmented_reply），开启后就会按标点把长文本拆成多条消息，
这是更稳的官方实现，别重复发明。

配置：下面几个常量可以直接改源码，也可以通过 dsh-xiaoyu-qqbot 控制台的
「限额 / 白名单」页面改（面板用正则读写这些常量，不依赖导入本模块）。
"""
from __future__ import annotations

import json
import os
import random
import re
import time
from pathlib import Path
from typing import Any

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.event.filter import on_decorating_result
from astrbot.api.star import Context, Star, register
from astrbot.core.message.components import Image, Plain


def _config_path() -> Path:
    env = os.environ.get("QQBOT_CONFIG", "").strip()
    if env:
        return Path(env)
    # 本插件装在 astrbot-src/data/plugins/dsh_xiaoyu_addon/ 下；
    # dsh-xiaoyu-qqbot 插件目录在同一个部署根目录下的约定位置。
    here = Path(__file__).resolve()
    # 向上找到部署根目录的标志文件 qqbot.config.json；找不到就用默认值运行。
    for parent in here.parents:
        candidate = parent / "qqbot.config.json"
        if candidate.exists():
            return candidate
    return here.parents[4] / "qqbot.config.json" if len(here.parents) > 4 else here


def _load_config() -> dict[str, Any]:
    p = _config_path()
    try:
        return json.loads(p.read_text(encoding="utf-8-sig"))
    except Exception:
        return {}


_CFG = _load_config()

# ── 陌生人聊天限额（主人之外）────────────────────────────
# 这些常量是人设层面的硬约束；dsh-xiaoyu-qqbot 控制台的「限额/白名单」页会改这几行。
_SOCIAL_OWNER_IDS = {str(_CFG.get("ownerQq") or "")} - {""}
_SOCIAL_LIMIT = 10          # 最多 10 条
_SOCIAL_WARN_AT = 9         # 第 9 条末尾提醒
_SOCIAL_WINDOW_SEC = 1800   # 同一对话 30 分钟没互动就重新计数
_SOCIAL_WARNING = "主人设置了每人每轮最多聊这么多句，有需要请找主人。"

# ── 表情包自动补发（给主人的短回复）────────────────────────
_AUTO_STICKER_ENABLED = True
_AUTO_STICKER_MAX_CHARS = 120       # 超过这么多字（长回答/汇报）就不补图
_AUTO_STICKER_MIN_GAP_SEC = 20      # 两条自动补图之间至少隔 20 秒
_root = _CFG.get("root") or ""
_stickers_rel = (_CFG.get("paths") or {}).get("stickersDir") or "workspace/stickers"
_AUTO_STICKER_ROOT = Path(_root) / _stickers_rel if _root else None
_AUTO_STICKER_INDEX = (_AUTO_STICKER_ROOT / "index.json") if _AUTO_STICKER_ROOT else None
_AUTO_STICKER_GATE_WINDOW = 600
_AUTO_STICKER_GATE_MAX = 10

# ── 舞台动作括号清理 ─────────────────────────────────────
_ACTION_PAREN = re.compile(r"(?:（[^（）\n]{1,24}）|\([^()\n]{1,24}\))")
_ACTION_WORDS = re.compile(r"低头|抬头|把.+搁|打哈欠|撇嘴|抱着|抱碗|拽衣|歪头|眨眼|挥手|敲桌|扶额|蹭|捂脸|咬牙|摊手|趴在|靠在")

_napcat_port = (_CFG.get("ports") or {}).get("napcatHttp") or 3002
_social_state: dict[str, list] = {}


def _normalize_qq_text(text: str) -> str:
    t = str(text or "")
    t = _ACTION_PAREN.sub(lambda m: "" if _ACTION_WORDS.search(m.group(0)) else m.group(0), t)
    return t


@register("dsh_xiaoyu_addon", "dsh-xiaoyu-qqbot contributors", "陌生人限额 / 自动表情包 / 动作清理", "1.0.0")
class XiaoyuAddon(Star):
    def __init__(self, context: Context, config=None):
        super().__init__(context)
        self.config = config or {}
        self._last_auto_sticker = 0.0

    def _is_admin(self, event: AstrMessageEvent) -> bool:
        try:
            return bool(event.is_admin())
        except Exception:
            return False

    def _social_is_owner(self, event: AstrMessageEvent) -> bool:
        if str(event.get_sender_id() or "") in _SOCIAL_OWNER_IDS:
            return True
        return self._is_admin(event)

    def _social_key(self, event: AstrMessageEvent) -> str:
        gid = str(event.get_group_id() or "")
        sid = str(event.get_sender_id() or "")
        return f"g:{gid}" if gid else f"u:{sid}"

    def _social_gate(self, event: AstrMessageEvent, text: str) -> tuple[str, bool]:
        if self._social_is_owner(event):
            return text, True
        key = self._social_key(event)
        now = time.time()
        rec = _social_state.get(key) or [0, 0.0]
        count, last = int(rec[0]), float(rec[1])
        if now - last > _SOCIAL_WINDOW_SEC:
            count = 0
        nxt = count + 1
        if nxt > _SOCIAL_LIMIT:
            logger.info("social-limit: 丢弃 %s 的第 %d 条（上限 %d）", key, nxt, _SOCIAL_LIMIT)
            _social_state[key] = [count, now]
            return "", False
        if nxt == _SOCIAL_WARN_AT:
            text = (text + "\n" + _SOCIAL_WARNING).strip()
        _social_state[key] = [nxt, now]
        return text, True

    def _auto_sticker_tag(self, text: str) -> str:
        t = text or ""
        rules = [
            (("困", "睡", "哈欠", "累", "疲惫"), "困"),
            (("饿", "饭", "吃", "干饭", "肚子"), "干饭"),
            (("好耶", "开心", "高兴", "棒", "厉害", "嘻嘻"), "开心"),
            (("无语", "沉默", "啧", "……", "呵呵"), "无语"),
            (("生气", "哼", "讨厌", "烦", "气死"), "生气"),
            (("得意", "骄傲", "嘿嘿", "聪明"), "得意"),
            (("委屈", "呜呜", "欺负", "难过"), "委屈"),
            (("撒娇", "抱抱", "蹭"), "撒娇"),
            (("震惊", "啊？", "居然", "什么"), "震惊"),
            (("早", "晚上好", "来了", "在吗"), "打招呼"),
        ]
        for keys, tag in rules:
            if any(k in t for k in keys):
                return tag
        return ""

    def _load_auto_sticker(self, tag: str):
        if _AUTO_STICKER_INDEX is None:
            return None
        try:
            data = json.loads(_AUTO_STICKER_INDEX.read_text(encoding="utf-8"))
        except Exception:
            return None
        items = data.get("items") or {}
        pool = []
        for it in items.values():
            if not isinstance(it, dict) or it.get("layer") == "trash":
                continue
            tags = it.get("tags") or []
            desc = it.get("desc") or ""
            if tag and (tag in tags or tag in desc):
                pool.append(it)
        if not pool:
            pool = [it for it in items.values() if isinstance(it, dict) and it.get("layer") != "trash"]
        if not pool:
            return None
        it = random.choice(pool)
        rel = str(it.get("file") or it.get("path") or "")
        if not rel:
            return None
        fp = Path(rel)
        if not fp.is_absolute() and _AUTO_STICKER_ROOT is not None:
            fp = _AUTO_STICKER_ROOT / rel
        return fp if fp.is_file() else None

    def _auto_sticker_allowed(self, text: str) -> bool:
        if not _AUTO_STICKER_ENABLED or not text or _AUTO_STICKER_INDEX is None:
            return False
        if len(text) > _AUTO_STICKER_MAX_CHARS or "```" in text:
            return False
        now = time.time()
        if now - self._last_auto_sticker < _AUTO_STICKER_MIN_GAP_SEC:
            return False
        try:
            data = json.loads(_AUTO_STICKER_INDEX.read_text(encoding="utf-8"))
            recent = [t for t in data.get("sends", []) if now - float(t) < _AUTO_STICKER_GATE_WINDOW]
            if len(recent) >= _AUTO_STICKER_GATE_MAX:
                return False
        except Exception:
            pass
        return True

    def _record_auto_sticker_send(self) -> None:
        self._last_auto_sticker = time.time()
        if _AUTO_STICKER_INDEX is None:
            return
        try:
            data = json.loads(_AUTO_STICKER_INDEX.read_text(encoding="utf-8"))
            data.setdefault("sends", []).append(self._last_auto_sticker)
            data["sends"] = data["sends"][-200:]
            _AUTO_STICKER_INDEX.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        except Exception:
            pass

    @on_decorating_result()
    async def decorate(self, event: AstrMessageEvent) -> None:
        result = event.get_result()
        if result is None or not result.chain:
            return

        # 1) 动作括号清理 + 2) 陌生人限额，只处理纯文本段
        is_owner = self._social_is_owner(event)
        combined_text = ""
        new_chain = []
        for comp in result.chain:
            if isinstance(comp, Plain):
                cleaned = _normalize_qq_text(comp.text)
                if not is_owner:
                    cleaned, ok = self._social_gate(event, cleaned)
                    if not ok:
                        event.stop_event()
                        result.chain = []
                        return
                if cleaned.strip():
                    combined_text += cleaned
                    new_chain.append(Plain(cleaned))
            else:
                new_chain.append(comp)
        result.chain = new_chain
        if not result.chain:
            return

        # 3) 自动补表情包（只在给主人的短回复后触发，避免刷屏陌生人）
        if is_owner and self._auto_sticker_allowed(combined_text):
            tag = self._auto_sticker_tag(combined_text)
            fp = self._load_auto_sticker(tag)
            if fp is not None:
                result.chain.append(Image.fromFileSystem(str(fp)))
                self._record_auto_sticker_send()
                logger.info("auto-sticker: 补发 tag=%s file=%s", tag or "(any)", fp.name)
