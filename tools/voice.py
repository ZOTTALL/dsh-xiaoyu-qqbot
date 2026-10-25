#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""语音工具：调用本地 GPT-SoVITS API，合成语音并可发到 QQ。

用法：
  voice.bat status                       查看 TTS 服务/参考音频状态
  voice.bat start                        启动 GPT-SoVITS API（后台）
  voice.bat stop                         停止（/control exit）
  voice.bat say --text "..." [--send]    合成语音（--send 发到 QQ）
  voice.bat say --text "..." --out a.wav --speed 1.05

配置来自 qqbot_config.py 读到的 qqbot.config.json（根目录/voice.json 路径/端口/QQ 号）。
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import qqbot_config as qc  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

CFG = qc.load()
ROOT = Path(CFG["root"])
CONFIG = qc.path_for(CFG, "voiceCfg")
GPT = qc.path_for(CFG, "voiceDir")
API = f"http://127.0.0.1:{CFG['ports']['tts']}"
NAPCAT = f"http://127.0.0.1:{CFG['ports']['napcatHttp']}"
ENV_PY = CFG.get("voicePy") or ""
LOG = qc.path_for(CFG, "logsDir") / "voice-server.log"

DEFAULT_CONFIG = {
    "api": API,
    "ref_audio": str(qc.path_for(CFG, "voiceRefDir") / "reference.wav"),
    "prompt_text": "",
    "prompt_lang": "zh",
    "text_lang": "zh",
    "default_user": qc.owner_qq(CFG),
}


def load_config() -> dict:
    if CONFIG.exists():
        try:
            cfg = json.loads(CONFIG.read_text(encoding="utf-8-sig"))
        except Exception:
            cfg = {}
    else:
        cfg = {}
    for k, v in DEFAULT_CONFIG.items():
        cfg.setdefault(k, v)
    return cfg


def save_config(cfg: dict) -> None:
    CONFIG.parent.mkdir(parents=True, exist_ok=True)
    CONFIG.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")


def api_alive(api: str, timeout: float = 1.5) -> bool:
    try:
        host = api.split("//", 1)[-1].split("/")[0]
        h, p = host.rsplit(":", 1)
        with socket.create_connection((h, int(p)), timeout=timeout):
            return True
    except Exception:
        return False


def post_json(url: str, payload: dict, timeout: int = 120) -> bytes:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json; charset=utf-8"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def cmd_status(args) -> None:
    cfg = load_config()
    print(f"api={cfg['api']} alive={api_alive(cfg['api'])}")
    ref = Path(cfg.get("ref_audio", ""))
    print(f"ref_audio={ref} exists={ref.is_file()}")
    print(f"prompt_text={cfg.get('prompt_text','')!r} prompt_lang={cfg.get('prompt_lang')} text_lang={cfg.get('text_lang')}")
    if not ref.is_file():
        print(f"提示：参考音频不存在。把 5~10 秒的 wav 放到 {qc.path_for(CFG, 'voiceRefDir')} 并在 voice.json 里改 ref_audio。")


def cmd_start(args) -> None:
    cfg = load_config()
    if api_alive(cfg["api"]):
        print("already running")
        return
    py = ENV_PY if ENV_PY and Path(ENV_PY).is_file() else sys.executable
    LOG.parent.mkdir(parents=True, exist_ok=True)
    logf = open(LOG, "ab")
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    env["CUDAGraph"] = "0"  # 部分显卡上开 CUDA Graph 每次要多等十几秒，关掉更快进入可用状态
    cmd = [py, "api_v2.py", "-a", "127.0.0.1", "-p", str(CFG["ports"]["tts"]), "-c", "GPT_SoVITS/configs/tts_infer.yaml"]
    creationflags = 0x00000008 if os.name == "nt" else 0
    subprocess.Popen(cmd, cwd=str(GPT), stdout=logf, stderr=logf, stdin=subprocess.DEVNULL, creationflags=creationflags, env=env)
    for _ in range(60):
        if api_alive(cfg["api"]):
            print("started")
            return
        time.sleep(1)
    print(f"failed to start in 60s; see {LOG}")
    sys.exit(1)


def cmd_stop(args) -> None:
    try:
        req = urllib.request.Request(f"{API}/control?command=exit", method="GET")
        with urllib.request.urlopen(req, timeout=10) as r:
            print("stopped:", r.read().decode("utf-8", "replace")[:120])
    except Exception as e:
        print(f"stop failed: {e}")


def cmd_say(args) -> None:
    cfg = load_config()
    if not api_alive(cfg["api"]):
        print("TTS 服务未启动，正在尝试启动…")
        cmd_start(args)
    ref = Path(cfg.get("ref_audio", ""))
    if not ref.is_file():
        print(f"参考音频不存在：{ref}")
        print(f"把 5~10 秒 wav 放到 {qc.path_for(CFG, 'voiceRefDir')} 并改 voice.json 的 ref_audio")
        sys.exit(1)
    payload = {
        "text": args.text,
        "text_lang": args.text_lang or cfg.get("text_lang", "zh"),
        "ref_audio_path": str(ref),
        "prompt_text": cfg.get("prompt_text", ""),
        "prompt_lang": cfg.get("prompt_lang", "zh"),
        "text_split_method": "cut5",
        "batch_size": 1,
        "media_type": "wav",
        "streaming_mode": False,
        "speed_factor": float(args.speed),
        "repetition_penalty": 1.35,
    }
    try:
        audio = post_json(cfg["api"].rstrip("/") + "/tts", payload, timeout=180)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:800]
        print(f"TTS HTTP {e.code}: {body}")
        sys.exit(1)
    out = Path(args.out) if args.out else ROOT / "downloads" / "voice" / f"tts_{int(time.time())}.wav"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(audio)
    print(f"saved {out} ({len(audio)} bytes)")
    if args.send:
        send_record(out, args.user, args.group)


def send_record(wav: Path, user: int = 0, group: int = 0) -> None:
    b64 = base64.b64encode(wav.read_bytes()).decode()
    message = [{"type": "record", "data": {"file": "base64://" + b64}}]
    if group:
        payload = {"group_id": group, "message": message}
        url = NAPCAT + "/send_group_msg"
    else:
        uid = user or qc.owner_qq(CFG)
        if not uid:
            print("没有收件人：加 --user 或在设置里填主人 QQ 号")
            sys.exit(1)
        payload = {"user_id": uid, "message": message}
        url = NAPCAT + "/send_private_msg"
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json; charset=utf-8"}, method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:
        print("qq:", r.read().decode("utf-8", "replace")[:300])


def cmd_init(args) -> None:
    cfg = load_config()
    save_config(cfg)
    print(f"config written: {CONFIG}")
    print(json.dumps(cfg, ensure_ascii=False, indent=2))


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd")

    sub.add_parser("status")
    sub.add_parser("start")
    sub.add_parser("stop")
    sub.add_parser("init")

    p = sub.add_parser("say")
    p.add_argument("--text", required=True)
    p.add_argument("--text-lang", default="")
    p.add_argument("--speed", default="1.0")
    p.add_argument("--out", default="")
    p.add_argument("--send", action="store_true")
    p.add_argument("--user", type=int, default=0)
    p.add_argument("--group", type=int, default=0)

    args = ap.parse_args()
    if not args.cmd:
        ap.print_help()
        return
    fn = {
        "status": cmd_status,
        "start": cmd_start,
        "stop": cmd_stop,
        "say": cmd_say,
        "init": cmd_init,
    }[args.cmd]
    fn(args)


if __name__ == "__main__":
    main()
