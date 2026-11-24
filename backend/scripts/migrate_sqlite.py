"""把旧的 SQLite（backend/data/app.db）整库搬到 Postgres，id 原样保留。

用法（在 backend 目录）：
    uv run python scripts/migrate_sqlite.py                       # 搬到本机 Postgres
    DATABASE_URL='postgresql://…' uv run python scripts/migrate_sqlite.py   # 搬到 Neon
目标库里已经有用户就停下，不覆盖。
"""
from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from psycopg.types.json import Jsonb  # noqa: E402

import db  # noqa: E402

SRC = Path(__file__).resolve().parents[1] / "data" / "app.db"
TABLES = ["users", "accounts", "positions", "orders", "equity_snapshots", "watchlists"]


def main() -> None:
    src = sqlite3.connect(SRC)
    src.row_factory = sqlite3.Row
    with db.conn() as c:
        if c.execute("select count(*) n from users").fetchone()["n"]:
            sys.exit("目标库已经有用户了，没搬。要重来先清空目标库。")
        for t in TABLES:
            rows = [dict(r) for r in src.execute(f"select * from {t}")]
            if not rows:
                print(f"{t}: 0")
                continue
            cols = list(rows[0])
            sql = f"insert into {t} ({', '.join(cols)}) values ({', '.join(['%s'] * len(cols))})"
            for r in rows:
                if t == "watchlists":
                    r["items"] = Jsonb(json.loads(r["items"]))
                c.execute(sql, list(r.values()))
            print(f"{t}: {len(rows)}")
        # 自增 id 从现有最大值往后接
        for t in ("users", "orders"):
            c.execute(f"select setval(pg_get_serial_sequence('{t}', 'id'), coalesce((select max(id) from {t}), 0) + 1, false)")
    print("搬完了 →", db.DATABASE_URL.split("@")[-1])


if __name__ == "__main__":
    main()
