#!/usr/bin/env python3
"""表情包仓库：收集、检索、发送（通过 NapCat HTTP API）。

特性：
  - lib/ 存图 + index.json 元数据；candidate / library / trash 三层
  - SHA-1 精确去重 + dHash 感知去重（重压缩/改尺寸也能认出来）
  - 标签/描述/来源检索（中英文 OR 匹配，按命中数 + 使用次数排序）
  - 发送到 QQ：调 NapCat HTTP API（默认发给设置里配置的主人 QQ）
  - 发送闸门：10 分钟内最多 6 张（防止刷屏）

用法：
  python sticker.py add <图片路径> --tags 开心,撒娇 --desc "描述" [--source qq] [--layer candidate]
  python sticker.py search "开心 撒娇" -n 10
  python sticker.py pick "开心"                 # 只输出路径（给 agent 用）
  python sticker.py send --path "<路径>" [--text "接住！"] [--user <qq>] [--group <群号>]
  python sticker.py send-random --tag 开心 [--text "..."]
  python sticker.py list [-n 20] [--layer all]
  python sticker.py stats
  python sticker.py trash <id> / restore <id> / rm <id>
  python sticker.py dedupe
"""
import argparse
import base64
import hashlib
import json
import os
import random
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import qqbot_config as qc  # noqa: E402

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

CFG = qc.load()
ROOT = qc.path_for(CFG, "stickersDir")
LIB = ROOT / "lib"
INDEX = qc.path_for(CFG, "stickerIndex")
NAPCAT = f"http://127.0.0.1:{CFG['ports']['napcatHttp']}"
DEFAULT_USER = qc.owner_qq(CFG)
GATE_WINDOW_SEC = 600
GATE_MAX = 10
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}
LAYERS = ("candidate", "library", "trash")


def now() -> float:
    return time.time()


def load_index() -> dict:
    if INDEX.exists():
        try:
            data = json.loads(INDEX.read_text(encoding="utf-8"))
            data.setdefault("items", {})
            data.setdefault("sends", [])
            return data
        except Exception:
            pass
    return {"items": {}, "sends": []}


def save_index(data: dict) -> None:
    ROOT.mkdir(parents=True, exist_ok=True)
    tmp = INDEX.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, INDEX)


def sha1_file(path: Path) -> str:
    h = hashlib.sha1()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def dhash_file(path: Path) -> str:
    """9x8 灰度 dHash（64bit → 16 hex）。Pillow 不可用时返回空串。"""
    try:
        from PIL import Image
    except Exception:
        return ""
    try:
        with Image.open(path) as im:
            im = im.convert("L").resize((9, 8), Image.LANCZOS)
            px = list(im.getdata())
        bits = ""
        for y in range(8):
            for x in range(8):
                bits += "1" if px[y * 9 + x] > px[y * 9 + x + 1] else "0"
        return "".join(f"{int(bits[i:i+4], 2):x}" for i in range(0, 64, 4))
    except Exception:
        return ""


def hamming(a: str, b: str) -> int:
    if not a or not b or len(a) != len(b):
        return 999
    return sum(bin(int(x, 16) ^ int(y, 16)).count("1") for x, y in zip(a, b))


def find_exact(data: dict, sha1: str):
    for sid, it in data["items"].items():
        if it.get("sha1") == sha1:
            return sid, it
    return None, None


def find_near(data: dict, dhash: str, max_dist: int = 5):
    if not dhash:
        return None, None
    best = (999, None, None)
    for sid, it in data["items"].items():
        if it.get("layer") == "trash" or not it.get("dhash"):
            continue
        d = hamming(dhash, it["dhash"])
        if d < best[0]:
            best = (d, sid, it)
    if best[0] <= max_dist:
        return best[1], best[2]
    return None, None


def to_hex_id(sha1: str) -> str:
    return sha1[:10]


def real_ext(path: Path) -> str:
    """按真实图片格式返回扩展名（QQ 保存的图常把 jpg 存成 .png）。"""
    try:
        from PIL import Image

        with Image.open(path) as im:
            fmt = (im.format or "").lower()
        return {
            "jpeg": ".jpg",
            "png": ".png",
            "gif": ".gif",
            "webp": ".webp",
            "bmp": ".bmp",
        }.get(fmt, path.suffix.lower())
    except Exception:
        return path.suffix.lower()


def add_file(src: Path, tags, desc, source, layer, force: bool = False, forced_id: str = "") -> tuple[str, str]:
    """入库通用实现：返回 (status, id)；status = new | dup | dup-near | error。"""
    if not src.is_file() or src.suffix.lower() not in IMAGE_EXTS:
        return "error", ""
    data = load_index()
    sha1 = sha1_file(src)
    sid, it = find_exact(data, sha1)
    if it:
        return "dup", sid
    dh = dhash_file(src)
    nid, nit = find_near(data, dh)
    if nit and not force:
        return "dup-near", nid
    sid = forced_id or to_hex_id(sha1)
    while sid in data["items"]:
        sid = sid + "x"
    LIB.mkdir(parents=True, exist_ok=True)
    ext = real_ext(src)
    dest = LIB / f"{sid}{ext}"
    dest.write_bytes(src.read_bytes())
    data["items"][sid] = {
        "id": sid,
        "file": str(dest),
        "ext": ext,
        "size": dest.stat().st_size,
        "sha1": sha1,
        "dhash": dh,
        "tags": [t.strip() for t in (tags or "").replace("，", ",").split(",") if t.strip()],
        "desc": desc or "",
        "source": source or "",
        "layer": layer,
        "capturedAt": now(),
        "useCount": 0,
        "lastUsedAt": 0,
    }
    save_index(data)
    return "new", sid


def cmd_add(args) -> None:
    status, sid = add_file(
        Path(args.image), args.tags, args.desc, args.source, args.layer, args.force, args.id
    )
    if status == "new":
        dest = LIB / (sid + Path(args.image).suffix.lower())
        print(f"added id={sid} layer={args.layer} tags={args.tags} path={dest}")
    elif status == "dup":
        print(f"dup: already exists id={sid}")
    elif status == "dup-near":
        print(f"dup-near: similar to id={sid} (dHash dist<=5); use --force to add anyway")
    else:
        print("error: not a supported image file")
        sys.exit(1)


def cmd_import_dir(args) -> None:
    root = Path(args.dir)
    if not root.is_dir():
        print(f"not a directory: {root}")
        sys.exit(1)
    files = [f for f in sorted(root.rglob("*")) if f.is_file() and f.suffix.lower() in IMAGE_EXTS]
    new_ids = []
    dup = near = 0
    for f in files:
        status, sid = add_file(f, args.tags, "", args.source, args.layer, args.force)
        if status == "new":
            new_ids.append(sid)
        elif status == "dup":
            dup += 1
        elif status == "dup-near":
            near += 1
    print(f"imported={len(new_ids)} dup={dup} dup_near={near} scanned={len(files)}")
    for sid in new_ids:
        print(f"  new id={sid}  (未打标签，用 untagged / set 补标)")


def _hay(it: dict) -> str:
    return " ".join(
        [
            " ".join(it.get("tags") or []),
            it.get("desc") or "",
            it.get("source") or "",
            Path(it.get("file") or "").stem,
        ]
    ).lower()


def _rank(query: str, data: dict, limit: int, layer: str = "all"):
    terms = [t for t in (query or "").replace("，", " ").replace("、", " ").split() if t]
    hits = []
    for sid, it in data["items"].items():
        if it.get("layer") == "trash" and layer != "trash":
            continue
        if layer not in ("all", "trash") and it.get("layer") != layer:
            continue
        hay = _hay(it)
        n = sum(1 for t in terms if t.lower() in hay) if terms else 0
        if terms and n == 0:
            continue
        hits.append((n, it.get("useCount", 0), it.get("capturedAt", 0), sid, it))
    hits.sort(key=lambda x: (-x[0], -x[1], -x[2]))
    return hits[:limit]


def cmd_search(args) -> None:
    data = load_index()
    hits = _rank(args.query, data, args.limit, args.layer)
    if not hits:
        print("no match")
        return
    for n, used, _, sid, it in hits:
        print(f"[{sid}] {it.get('file')}")
        if it.get("tags"):
            print(f"    tags={','.join(it['tags'])}")
        if it.get("desc"):
            print(f"    desc={it['desc']}")
        print(f"    layer={it.get('layer')} used={used}")


def cmd_pick(args) -> None:
    data = load_index()
    hits = _rank(args.query, data, args.limit, "all")
    if not hits:
        print("")
        sys.exit(2)
    if args.random:
        _n, _u, _c, sid, it = random.choice(hits)
    else:
        _n, _u, _c, sid, it = hits[0]
    print(it.get("file"))


def cmd_list(args) -> None:
    data = load_index()
    items = [it for it in data["items"].values() if it.get("layer") != "trash"]
    if args.layer != "all":
        items = [it for it in items if it.get("layer") == args.layer]
    items.sort(key=lambda it: it.get("capturedAt", 0), reverse=True)
    for it in items[: args.limit]:
        print(f"[{it['id']}] {it.get('layer')} tags={','.join(it.get('tags') or [])} {it.get('file')}")


def cmd_stats(args) -> None:
    data = load_index()
    items = list(data["items"].values())
    by = {k: 0 for k in LAYERS}
    for it in items:
        by[it.get("layer", "library")] = by.get(it.get("layer", "library"), 0) + 1
    total_bytes = sum(it.get("size", 0) for it in items)
    print(f"total={len(items)} candidate={by['candidate']} library={by['library']} trash={by['trash']} size={total_bytes/1024:.1f}KB")
    if data.get("sends"):
        recent = [t for t in data["sends"] if now() - t < GATE_WINDOW_SEC]
        print(f"sends_last_{GATE_WINDOW_SEC}s={len(recent)} (gate max {GATE_MAX})")


def _gate_ok(data: dict, force: bool) -> bool:
    if force:
        return True
    recent = [t for t in data.get("sends", []) if now() - t < GATE_WINDOW_SEC]
    if len(recent) >= GATE_MAX:
        print(f"gate: {len(recent)} stickers in last {GATE_WINDOW_SEC}s >= {GATE_MAX}; 别再刷了（--force 可强发）")
        return False
    return True


def _post(action: str, payload: dict) -> dict:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{NAPCAT}/{action}", data=data, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def _send_image(path: Path, text: str, user: int = None, group: int = None) -> dict:
    b64 = base64.b64encode(path.read_bytes()).decode("ascii")
    msg = []
    if text:
        msg.append({"type": "text", "data": {"text": text}})
    msg.append({"type": "image", "data": {"file": "base64://" + b64}})
    if group:
        return _post("send_group_msg", {"group_id": group, "message": msg})
    uid = user or DEFAULT_USER
    if not uid:
        raise RuntimeError("没有收件人：加 --user 或在设置里填主人 QQ 号")
    return _post("send_private_msg", {"user_id": uid, "message": msg})


def cmd_send(args) -> None:
    data = load_index()
    if not _gate_ok(data, args.force):
        sys.exit(3)
    target = None
    if args.id:
        target = data["items"].get(args.id)
        if not target:
            print(f"no such sticker id={args.id}")
            sys.exit(4)
        if target.get("layer") == "trash":
            print("sticker is in trash")
            sys.exit(4)
        path = Path(target["file"])
    else:
        path = Path(args.path)
    if not path.is_file():
        print(f"image not found: {path}")
        sys.exit(4)
    try:
        resp = _send_image(path, args.text, args.user, args.group)
    except Exception as e:
        print(f"send failed: {e!r}")
        sys.exit(5)
    ok = str(resp.get("status")) == "ok"
    print(f"sent status={resp.get('status')} retcode={resp.get('retcode')} msg_id={(resp.get('data') or {}).get('message_id')}")
    if ok:
        data.setdefault("sends", []).append(now())
        data["sends"] = data["sends"][-200:]
        if target is not None:
            target["useCount"] = target.get("useCount", 0) + 1
            target["lastUsedAt"] = now()
            if target.get("layer") == "candidate":
                target["layer"] = "library"
        save_index(data)


def cmd_send_random(args) -> None:
    data = load_index()
    hits = _rank(args.tag or "", data, 200, "all")
    hits = [h for h in hits if h[4].get("layer") != "trash"]
    if not hits:
        print("no sticker matched")
        sys.exit(2)
    _n, _u, _c, sid, it = random.choice(hits)
    args.id = sid
    args.path = None
    cmd_send(args)


def cmd_trash(args) -> None:
    data = load_index()
    it = data["items"].get(args.id)
    if not it:
        print("no such id")
        return
    it["layer"] = "trash"
    it["trashedAt"] = now()
    save_index(data)
    print(f"trashed {args.id}")


def cmd_restore(args) -> None:
    data = load_index()
    it = data["items"].get(args.id)
    if not it:
        print("no such id")
        return
    it["layer"] = "library"
    it.pop("trashedAt", None)
    save_index(data)
    print(f"restored {args.id}")


def cmd_set(args) -> None:
    """补/改标签与描述（自动打标用）。"""
    data = load_index()
    it = data["items"].get(args.id)
    if not it:
        print(f"no such id: {args.id}")
        return
    if args.tags is not None:
        it["tags"] = [t.strip() for t in args.tags.replace("，", ",").split(",") if t.strip()]
    if args.desc is not None:
        it["desc"] = args.desc
    if args.layer:
        it["layer"] = args.layer
    save_index(data)
    print(f"updated {args.id} tags={it.get('tags')} desc={it.get('desc')}")


def cmd_untagged(args) -> None:
    """列出没标签/没描述的表情，供模型补标。"""
    data = load_index()
    rows = []
    for sid, it in data["items"].items():
        if it.get("layer") == "trash" and not args.include_trash:
            continue
        if not it.get("tags") or not it.get("desc"):
            rows.append((sid, it))
    rows.sort(key=lambda x: x[1].get("capturedAt", 0), reverse=True)
    for sid, it in rows[: args.limit]:
        print(f"[{sid}] tags={it.get('tags')} desc={it.get('desc')!r} {it.get('file')}")
    print(f"untagged={len(rows)}")


def cmd_rm(args) -> None:
    data = load_index()
    it = data["items"].pop(args.id, None)
    if not it:
        print("no such id")
        return
    try:
        Path(it["file"]).unlink(missing_ok=True)
    except Exception:
        pass
    save_index(data)
    print(f"removed {args.id}")


def cmd_dedupe(args) -> None:
    data = load_index()
    items = [(sid, it) for sid, it in data["items"].items() if it.get("layer") != "trash"]
    seen = []
    dups = []
    for sid, it in items:
        for osid, oit in seen:
            if hamming(it.get("dhash", ""), oit.get("dhash", "")) <= 3:
                dups.append((sid, osid))
                break
        else:
            seen.append((sid, it))
    for a, b in dups:
        print(f"near-dup: {a} ~ {b}")
    print(f"checked {len(items)} stickers, {len(dups)} near-duplicates")


def main() -> int:
    ap = argparse.ArgumentParser(description="表情包仓库")
    sub = ap.add_subparsers(dest="cmd")

    p = sub.add_parser("add")
    p.add_argument("image")
    p.add_argument("--tags", default="")
    p.add_argument("--desc", default="")
    p.add_argument("--source", default="")
    p.add_argument("--layer", default="library", choices=list(LAYERS[:-1]))
    p.add_argument("--id", default="")
    p.add_argument("--force", action="store_true")

    p = sub.add_parser("search")
    p.add_argument("query", nargs="?", default="")
    p.add_argument("-n", "--limit", type=int, default=10)
    p.add_argument("--layer", default="all")

    p = sub.add_parser("pick")
    p.add_argument("query", nargs="?", default="")
    p.add_argument("--random", action="store_true")
    p.add_argument("-n", "--limit", type=int, default=20)

    p = sub.add_parser("list")
    p.add_argument("-n", "--limit", type=int, default=20)
    p.add_argument("--layer", default="all")

    sub.add_parser("stats")

    p = sub.add_parser("send")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--path")
    g.add_argument("--id")
    p.add_argument("--text", default="")
    p.add_argument("--user", type=int, default=0)
    p.add_argument("--group", type=int, default=0)
    p.add_argument("--force", action="store_true")

    p = sub.add_parser("send-random")
    p.add_argument("--tag", default="")
    p.add_argument("--text", default="")
    p.add_argument("--user", type=int, default=0)
    p.add_argument("--group", type=int, default=0)
    p.add_argument("--force", action="store_true")

    for name in ("trash", "restore", "rm"):
        p = sub.add_parser(name)
        p.add_argument("id")

    p = sub.add_parser("import-dir")
    p.add_argument("dir")
    p.add_argument("--tags", default="")
    p.add_argument("--source", default="import")
    p.add_argument("--layer", default="candidate", choices=list(LAYERS[:-1]))
    p.add_argument("--force", action="store_true")

    p = sub.add_parser("set")
    p.add_argument("id")
    p.add_argument("--tags", default=None)
    p.add_argument("--desc", default=None)
    p.add_argument("--layer", default=None, choices=list(LAYERS))

    p = sub.add_parser("untagged")
    p.add_argument("--limit", type=int, default=50)
    p.add_argument("--include-trash", action="store_true")

    sub.add_parser("dedupe")

    args = ap.parse_args()
    if args.cmd == "add":
        cmd_add(args)
    elif args.cmd == "search":
        cmd_search(args)
    elif args.cmd == "pick":
        cmd_pick(args)
    elif args.cmd == "list":
        cmd_list(args)
    elif args.cmd == "stats":
        cmd_stats(args)
    elif args.cmd == "send":
        cmd_send(args)
    elif args.cmd == "send-random":
        cmd_send_random(args)
    elif args.cmd == "trash":
        cmd_trash(args)
    elif args.cmd == "restore":
        cmd_restore(args)
    elif args.cmd == "rm":
        cmd_rm(args)
    elif args.cmd == "set":
        cmd_set(args)
    elif args.cmd == "untagged":
        cmd_untagged(args)
    elif args.cmd == "import-dir":
        cmd_import_dir(args)
    elif args.cmd == "dedupe":
        cmd_dedupe(args)
    else:
        ap.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
