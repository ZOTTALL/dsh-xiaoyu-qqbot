#!/usr/bin/env python3
"""记忆库：本地 SQLite FTS5 检索（毫秒级，零依赖、零网络）。

用法:
  python memory_db.py sync                 # 扫描 memory/**/*.md 重建索引
  python memory_db.py search "关键词" -n 8   # 检索
  python memory_db.py stats                # 查看索引统计
  python memory_db.py add "一条记忆"        # 追加到当天日记并重建索引
"""
import argparse
import sqlite3
import sys
import time
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import qqbot_config as qc  # noqa: E402

# Windows 控制台默认 GBK，统一转 UTF-8，避免 emoji/中文报错
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

CFG = qc.load()
MEM = qc.path_for(CFG, "memoryDir")
DB = MEM / ".index.db"
CHUNK_MAX = 800


def connect() -> sqlite3.Connection:
    MEM.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB)
    con.execute("PRAGMA journal_mode=WAL")
    return con


def init(con: sqlite3.Connection) -> str:
    con.execute(
        "CREATE TABLE IF NOT EXISTS chunks("
        "id INTEGER PRIMARY KEY, path TEXT, day TEXT, mtime REAL, text TEXT)"
    )
    con.execute("CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT)")
    try:
        con.execute(
            "CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5("
            "text, content='chunks', content_rowid='id', tokenize='trigram')"
        )
        return "trigram"
    except sqlite3.OperationalError:
        con.execute(
            "CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5("
            "text, content='chunks', content_rowid='id', tokenize='unicode61')"
        )
        return "unicode61"


def split_chunks(text: str) -> list[str]:
    parts: list[str] = []
    buf: list[str] = []
    for line in text.splitlines():
        if line.strip() == "":
            if buf:
                parts.append("\n".join(buf))
                buf = []
        else:
            buf.append(line)
            if len("\n".join(buf)) >= CHUNK_MAX:
                parts.append("\n".join(buf))
                buf = []
    if buf:
        parts.append("\n".join(buf))
    out: list[str] = []
    for p in parts:
        p = p.strip()
        while len(p) > CHUNK_MAX:
            out.append(p[:CHUNK_MAX])
            p = p[CHUNK_MAX:]
        if len(p) >= 2:
            out.append(p)
    return out


def sync(verbose: bool = True) -> tuple[int, str]:
    t0 = time.time()
    con = connect()
    mode = init(con)
    con.execute("DELETE FROM chunks")
    n = 0
    for f in sorted(MEM.rglob("*.md")):
        if f.name.startswith("."):
            continue
        try:
            text = f.read_text(encoding="utf-8")
        except Exception:
            continue
        rel = str(f.relative_to(MEM)).replace("\\", "/")
        day = ""
        for part in f.parts:
            if len(part) == 10 and part[4] == "-" and part[7] == "-":
                day = part
        for ch in split_chunks(text):
            con.execute(
                "INSERT INTO chunks(path, day, mtime, text) VALUES(?,?,?,?)",
                (rel, day, f.stat().st_mtime, ch),
            )
            n += 1
    con.execute("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')")
    con.execute("INSERT OR REPLACE INTO meta(k, v) VALUES('last_sync', ?)", (str(time.time()),))
    con.commit()
    ms = int((time.time() - t0) * 1000)
    if verbose:
        print(f"synced {n} chunks in {ms} ms (tokenizer={mode})")
    return n, mode


def search(query: str, limit: int = 8) -> None:
    con = connect()
    init(con)
    # 记忆文件变过就自动增量重建，保证刚写的记忆也能被搜到
    try:
        last_sync = float(con.execute("SELECT v FROM meta WHERE k='last_sync'").fetchone()[0])
    except Exception:
        last_sync = 0.0
    newest = 0.0
    for f in MEM.rglob("*.md"):
        try:
            newest = max(newest, f.stat().st_mtime)
        except Exception:
            pass
    if newest > last_sync:
        sync(verbose=False)
        con = connect()
        init(con)
    q = (query or "").strip()
    if not q:
        print("empty query")
        return
    rows = []
    try:
        rows = con.execute(
            "SELECT c.path, c.day, snippet(chunks_fts, 0, '[', ']', '…', 12) "
            "FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid "
            "WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?",
            (q, limit),
        ).fetchall()
    except sqlite3.OperationalError:
        rows = []
    if not rows:  # 短查询（1–2 个汉字）trigram 不命中，退回 LIKE
        rows = con.execute(
            "SELECT path, day, substr(text, 1, 300) FROM chunks "
            "WHERE text LIKE ? ORDER BY mtime DESC LIMIT ?",
            (f"%{q}%", limit),
        ).fetchall()
    if not rows:
        print(f"no match for {q!r}")
        return
    for path, day, snip in rows:
        tag = f" ({day})" if day else ""
        print(f"--- {path}{tag}")
        print(str(snip).replace("\n", " ")[:400])


def add(text: str) -> None:
    today = date.today().isoformat()
    journal = MEM / "journal" / f"{today}.md"
    journal.parent.mkdir(parents=True, exist_ok=True)
    line = text.strip()
    if not line.startswith("-"):
        line = "- " + line
    if not journal.exists():
        journal.write_text(f"# {today}\n\n", encoding="utf-8")
    with journal.open("a", encoding="utf-8") as f:
        f.write(line + "\n")
    print(f"appended to {journal}")
    sync()


def stats() -> None:
    con = connect()
    init(con)
    total = con.execute("SELECT COUNT(*), COUNT(DISTINCT path) FROM chunks").fetchone()
    size = DB.stat().st_size if DB.exists() else 0
    print(f"chunks={total[0]} files={total[1]} db={size/1024:.1f} KB")
    for row in con.execute(
        "SELECT path, COUNT(*) c FROM chunks GROUP BY path ORDER BY c DESC LIMIT 12"
    ):
        print(f"  {row[0]}: {row[1]}")


def main() -> int:
    ap = argparse.ArgumentParser(description="记忆库检索")
    sub = ap.add_subparsers(dest="cmd")
    sub.add_parser("sync", help="重建索引")
    sp = sub.add_parser("search", help="检索")
    sp.add_argument("query")
    sp.add_argument("-n", "--limit", type=int, default=8)
    sub.add_parser("stats", help="索引统计")
    sa = sub.add_parser("add", help="追加记忆到当天日记")
    sa.add_argument("text")
    args = ap.parse_args()

    if args.cmd == "sync":
        sync()
    elif args.cmd == "search":
        search(args.query, args.limit)
    elif args.cmd == "add":
        add(args.text)
    elif args.cmd == "stats":
        stats()
    else:
        ap.print_help()
        print("\n示例: python memory_db.py search \"关键词\"")
    return 0


if __name__ == "__main__":
    sys.exit(main())
