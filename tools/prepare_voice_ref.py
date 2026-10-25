# -*- coding: utf-8 -*-
"""Prepare a bounded GPT-SoVITS reference WAV.
stdout's last line is JSON. Uploaded bytes are never imported as Python.
Usage: prepare_voice_ref.py <input> <output> <start> <duration> <remove_music 0|1>
"""
from __future__ import annotations
import json, shutil, subprocess, sys, tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import qqbot_config as qc  # noqa: E402

CFG = qc.load()
ROOT = Path(CFG["root"])
GPT = qc.path_for(CFG, "voiceDir")
UVR = GPT / "tools" / "uvr5"
WEIGHT = UVR / "uvr5_weights" / "HP2_all_vocals.pth"
REF_DIR = qc.path_for(CFG, "voiceRefDir")
TMP = qc.path_for(CFG, "tmpDir")

FFMPEG = shutil.which("ffmpeg") or "ffmpeg"


def run(cmd, cwd=None, timeout=600):
    return subprocess.run(cmd, cwd=str(cwd) if cwd else None, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace", timeout=timeout)


def main():
    if len(sys.argv) != 6:
        raise SystemExit("usage: prepare_voice_ref.py input output start duration remove_music")
    inp, out = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
    start, duration, remove = float(sys.argv[3]), float(sys.argv[4]), sys.argv[5] == "1"
    if not inp.is_file() or inp.stat().st_size > 30 * 1024 * 1024:
        raise ValueError("invalid input")
    if out.suffix.lower() != ".wav" or not str(out).lower().startswith(str(REF_DIR.resolve()).lower()):
        raise ValueError("invalid output")
    if not 3 <= duration <= 10:
        raise ValueError("duration must be 3..10")
    if shutil.which("ffmpeg") is None and FFMPEG == "ffmpeg":
        raise RuntimeError("ffmpeg 不在 PATH 里；请安装 ffmpeg 并确保命令行里能直接运行 ffmpeg")
    out.parent.mkdir(parents=True, exist_ok=True)
    TMP.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=str(TMP)) as td:
        source = inp
        if remove and WEIGHT.exists():
            # UVR5 是可选步骤；装不了就退回纯 ffmpeg 转换，不影响生成参考音。
            try:
                sys.path.insert(0, str(UVR))
                from vr import AudioPre
                ins, voc = Path(td) / "ins", Path(td) / "voc"
                ins.mkdir(); voc.mkdir()
                AudioPre(agg=10, model_path=str(WEIGHT), device="cuda", is_half=True)._path_audio_(str(inp), str(ins), str(voc), format="wav", is_hp3=False)
                candidates = list(voc.glob("*.wav"))
                if candidates:
                    source = candidates[0]
            except Exception:
                pass
        cmd = [FFMPEG, "-y", "-ss", str(start), "-t", str(duration), "-i", str(source), "-vn", "-ac", "1", "-ar", "32000", "-c:a", "pcm_s16le", str(out)]
        r = run(cmd, cwd=GPT)
        if r.returncode != 0 or not out.exists():
            raise RuntimeError((r.stderr or r.stdout)[-1000:])
    print(json.dumps({"ok": True, "durationSec": duration, "bytes": out.stat().st_size}, ensure_ascii=False))


if __name__ == "__main__":
    main()
