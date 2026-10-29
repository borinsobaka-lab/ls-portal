#!/usr/bin/env python3
"""Агент синхронизации старого портала аналитики Lady Stretch с порталом.

Ставится на сервер старого портала (analytics.lady-stretching.ru) и раз в
две минуты отправляет порталу изменения его данных (ANALYTICS_PLAN.md, §3.2).
Только читает: базы SQLite открываются в режиме mode=ro, код старого
портала, его службы и данные не меняются. Пароли, токены сессий и ключи в
открытом виде не отправляются.

Протокол — POST <PORTAL_URL>/api/analytics/replica, тело — JSON в gzip:
  {"batch": "...", "items": [{"target": "an_...", "rows": [...], "delete": [...]}],
   "agent": {...}}
Заголовки: X-Replica-Time (unix-секунды), X-Replica-Gzip: 1,
X-Replica-Signature = hex(HMAC-SHA256(REPLICA_SECRET, "<время>.<sha256 тела hex>")).

Что отправлено, агент помнит в своей базе (STATE_DIR/state.sqlite3):
  * diff   — хэш каждой строки: отправляются новые и изменённые строки и
             ключи удалённых;
  * append — таблицы, куда только добавляют (журналы): строки с id больше
             последнего отправленного.
Состояние записывается только после ответа портала «принято», поэтому
сбой связи или портала ничего не теряет: следующий запуск отправит то же.

Запуск:
  agent.py             — отправить изменения (так запускает таймер systemd)
  agent.py --check     — проверить связь и подпись с порталом
  agent.py --status    — что и когда отправлено
  agent.py --reset T   — забыть отправленное по таблице T (или all) —
                         следующий запуск отправит её целиком
Настройки — /etc/lady-analytics-replica/agent.env (--config): PORTAL_URL,
REPLICA_SECRET, пути к базам (PORTAL_DB …), STATE_DIR, MODULES (через запятую;
не задано — все модули).
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import hmac
import json
import os
import socket
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

VERSION = "1.0"
DEFAULT_CONFIG = "/etc/lady-analytics-replica/agent.env"

# Пачка — не больше стольких строк и примерно байт JSON до сжатия.
BATCH_ROWS = 5000
BATCH_BYTES = 8_000_000
HTTP_TIMEOUT = 120


@dataclass(frozen=True)
class Source:
    """Таблица старого портала → таблица-получатель портала."""

    module: str
    target: str
    db: str  # ключ пути базы в настройках
    table: str
    columns: tuple[str, ...]
    keys: tuple[str, ...]
    mode: str = "diff"  # diff | append
    # Таблицу заводит модуль старого портала при первом использовании —
    # пока её нет, источник пропускается.
    optional: bool = False


# Ядро (portal.sqlite3): люди, права, партнёры, журнал, активное время.
# Без password_hash и token_hash.
SOURCES: tuple[Source, ...] = (
    Source("core", "an_legacy_users", "PORTAL_DB", "users",
           ("id", "login", "full_name", "role", "is_active", "created_at", "position",
            "partner_city", "is_targetologist", "is_lead_manager"), ("id",)),
    Source("core", "an_legacy_dashboard_access", "PORTAL_DB", "user_dashboard_access",
           ("user_id", "dashboard_name"), ("user_id", "dashboard_name")),
    Source("core", "an_legacy_partner_cities", "PORTAL_DB", "user_partner_cities",
           ("user_id", "city"), ("user_id", "city")),
    Source("core", "an_legacy_partner_profiles", "PORTAL_DB", "partner_profiles",
           ("user_id", "phone", "telegram", "max_messenger", "individual_entrepreneur", "inn"),
           ("user_id",)),
    Source("core", "an_legacy_partner_city_settings", "PORTAL_DB", "partner_city_settings",
           ("user_id", "city", "trial_price", "directions"), ("user_id", "city")),
    Source("core", "an_legacy_fitbase_connections", "PORTAL_DB", "user_fitbase_connections",
           ("user_id", "connection_id", "domain", "club_id"), ("user_id", "connection_id"),
           optional=True),
    Source("core", "an_legacy_sessions", "PORTAL_DB", "user_sessions",
           ("id", "user_id", "created_at", "last_seen_at", "ended_at", "last_active_at",
            "active_seconds", "expires_at"), ("id",)),
    Source("core", "an_legacy_activity", "PORTAL_DB", "activity_samples",
           ("id", "session_id", "user_id", "dashboard_name", "recorded_at", "active_seconds"),
           ("id",), mode="append"),
    Source("core", "an_legacy_audit", "PORTAL_DB", "audit_log",
           ("id", "user_id", "event", "details", "created_at"), ("id",), mode="append"),
)

DEFAULTS = {
    "PORTAL_DB": "/opt/lady-analytics/portal.sqlite3",
    "STATE_DIR": "/var/lib/lady-analytics-replica",
}


class AgentError(Exception):
    pass


# --- Настройки --------------------------------------------------------------------


def load_config(path: str) -> dict[str, str]:
    cfg = dict(DEFAULTS)
    p = Path(path)
    if p.exists():
        for line in p.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            cfg[k.strip()] = v.strip().strip('"').strip("'")
    for k in ("PORTAL_URL", "REPLICA_SECRET", "PORTAL_DB", "STATE_DIR", "MODULES"):
        if os.environ.get(k):
            cfg[k] = os.environ[k]
    return cfg


def require(cfg: dict[str, str], key: str) -> str:
    v = cfg.get(key, "").strip()
    if not v:
        raise AgentError(f"Не задан {key} в настройках агента")
    return v


# --- Связь с порталом ----------------------------------------------------------------


def sign(secret: str, stamp: str, body: bytes) -> str:
    digest = hashlib.sha256(body).hexdigest()
    return hmac.new(secret.encode(), f"{stamp}.{digest}".encode(), hashlib.sha256).hexdigest()


def post(cfg: dict[str, str], payload: dict) -> dict:
    url = require(cfg, "PORTAL_URL").rstrip("/") + "/api/analytics/replica"
    secret = require(cfg, "REPLICA_SECRET")
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), default=_json_value)
    body = gzip.compress(raw.encode("utf-8"), compresslevel=6)
    stamp = str(int(time.time()))
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Replica-Gzip": "1",
            "X-Replica-Time": stamp,
            "X-Replica-Signature": sign(secret, stamp, body),
            "User-Agent": f"lady-analytics-replica/{VERSION}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            text = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", "replace")
        try:
            message = json.loads(text).get("error") or text
        except ValueError:
            message = text[:300]
        raise AgentError(f"Портал ответил {e.code}: {message}") from None
    except (urllib.error.URLError, socket.timeout, ConnectionError) as e:
        raise AgentError(f"Нет связи с порталом: {e}") from None
    try:
        return json.loads(text)
    except ValueError:
        raise AgentError(f"Портал ответил не JSON: {text[:300]}") from None


def _json_value(v):
    if isinstance(v, (bytes, bytearray, memoryview)):
        # bytea в Postgres принимает текст «\x…».
        return "\\x" + bytes(v).hex()
    return str(v)


# --- Состояние ----------------------------------------------------------------------


class State:
    def __init__(self, state_dir: str):
        Path(state_dir).mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(Path(state_dir) / "state.sqlite3"))
        self.db.executescript(
            """
            CREATE TABLE IF NOT EXISTS rows (
              target TEXT NOT NULL, key TEXT NOT NULL, hash TEXT NOT NULL,
              PRIMARY KEY (target, key)) WITHOUT ROWID;
            CREATE TABLE IF NOT EXISTS cursors (target TEXT PRIMARY KEY, last_id INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS runs (
              target TEXT PRIMARY KEY, at INTEGER NOT NULL, sent INTEGER NOT NULL,
              deleted INTEGER NOT NULL, total INTEGER NOT NULL, error TEXT);
            """
        )

    def hashes(self, target: str) -> dict[str, str]:
        return dict(self.db.execute("SELECT key, hash FROM rows WHERE target = ?", (target,)))

    def save_rows(self, target: str, upserts: list[tuple[str, str]], deletes: list[str]):
        with self.db:
            self.db.executemany(
                "INSERT INTO rows (target, key, hash) VALUES (?, ?, ?) "
                "ON CONFLICT (target, key) DO UPDATE SET hash = excluded.hash",
                [(target, k, h) for k, h in upserts],
            )
            self.db.executemany("DELETE FROM rows WHERE target = ? AND key = ?",
                                [(target, k) for k in deletes])

    def cursor(self, target: str) -> int:
        row = self.db.execute("SELECT last_id FROM cursors WHERE target = ?", (target,)).fetchone()
        return int(row[0]) if row else 0

    def save_cursor(self, target: str, last_id: int):
        with self.db:
            self.db.execute(
                "INSERT INTO cursors (target, last_id) VALUES (?, ?) "
                "ON CONFLICT (target) DO UPDATE SET last_id = excluded.last_id",
                (target, last_id),
            )

    def save_run(self, target: str, sent: int, deleted: int, total: int, error: str | None):
        with self.db:
            self.db.execute(
                "INSERT INTO runs (target, at, sent, deleted, total, error) VALUES (?, ?, ?, ?, ?, ?) "
                "ON CONFLICT (target) DO UPDATE SET at = excluded.at, sent = excluded.sent, "
                "deleted = excluded.deleted, total = excluded.total, error = excluded.error",
                (target, int(time.time()), sent, deleted, total, error),
            )

    def reset(self, target: str | None):
        with self.db:
            if target is None:
                self.db.execute("DELETE FROM rows")
                self.db.execute("DELETE FROM cursors")
            else:
                self.db.execute("DELETE FROM rows WHERE target = ?", (target,))
                self.db.execute("DELETE FROM cursors WHERE target = ?", (target,))

    def runs(self) -> list[tuple]:
        return self.db.execute("SELECT target, at, sent, deleted, total, error FROM runs ORDER BY target").fetchall()


# --- Чтение баз старого портала --------------------------------------------------------


def open_ro(path: str) -> sqlite3.Connection:
    if not Path(path).exists():
        raise AgentError(f"Нет базы {path}")
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=30)
    conn.execute("PRAGMA query_only = 1")
    return conn


def table_exists(conn: sqlite3.Connection, table: str) -> bool:
    return conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
                        (table,)).fetchone() is not None


def select_sql(src: Source) -> str:
    cols = ", ".join(f'"{c}"' for c in src.columns)
    return f'SELECT {cols} FROM "{src.table}"'


def row_key(src: Source, row: dict) -> str:
    return json.dumps([row[k] for k in src.keys], ensure_ascii=False, separators=(",", ":"))


def row_hash(row: dict) -> str:
    raw = json.dumps(row, ensure_ascii=False, separators=(",", ":"), sort_keys=True, default=_json_value)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:24]


def chunks(rows: list, max_rows: int = BATCH_ROWS, max_bytes: int = BATCH_BYTES):
    cur: list = []
    size = 0
    for r in rows:
        n = len(json.dumps(r, ensure_ascii=False, default=_json_value))
        if cur and (len(cur) >= max_rows or size + n > max_bytes):
            yield cur
            cur, size = [], 0
        cur.append(r)
        size += n
    if cur:
        yield cur


@dataclass
class Report:
    target: str
    sent: int = 0
    deleted: int = 0
    total: int = 0
    error: str | None = None
    skipped: str | None = None
    extra: dict = field(default_factory=dict)


def send_item(cfg: dict[str, str], batch: str, target: str, rows: list, delete: list) -> None:
    res = post(cfg, {"batch": batch, "items": [{"target": target, "rows": rows, "delete": delete}]})
    results = res.get("results") or []
    errors = [r.get("error") for r in results if r.get("error")]
    if errors or not res.get("ok"):
        raise AgentError(errors[0] if errors else res.get("error") or "Портал не принял пачку")


def sync_diff(cfg, state: State, conn, src: Source, batch: str) -> Report:
    rep = Report(src.target)
    known = state.hashes(src.target)
    seen: set[str] = set()
    changed: list[tuple[str, str, dict]] = []
    cur = conn.execute(select_sql(src))
    names = [d[0] for d in cur.description]
    for values in cur:
        row = dict(zip(names, values))
        k = row_key(src, row)
        h = row_hash(row)
        seen.add(k)
        if known.get(k) != h:
            changed.append((k, h, row))
    rep.total = len(seen)
    gone = [k for k in known if k not in seen]

    for part in chunks(changed):
        send_item(cfg, batch, src.target, [r for _, _, r in part], [])
        state.save_rows(src.target, [(k, h) for k, h, _ in part], [])
        rep.sent += len(part)
    for part in chunks(gone):
        delete = [dict(zip(src.keys, json.loads(k))) for k in part]
        send_item(cfg, batch, src.target, [], delete)
        state.save_rows(src.target, [], part)
        rep.deleted += len(part)
    return rep


def sync_append(cfg, state: State, conn, src: Source, batch: str) -> Report:
    rep = Report(src.target)
    id_col = src.keys[0]
    last = state.cursor(src.target)
    rep.total = conn.execute(f'SELECT count(*) FROM "{src.table}"').fetchone()[0]
    while True:
        cur = conn.execute(f'{select_sql(src)} WHERE "{id_col}" > ? ORDER BY "{id_col}" LIMIT ?',
                           (last, BATCH_ROWS))
        names = [d[0] for d in cur.description]
        rows = [dict(zip(names, v)) for v in cur]
        if not rows:
            break
        for part in chunks(rows):
            send_item(cfg, batch, src.target, part, [])
            last = int(part[-1][id_col])
            state.save_cursor(src.target, last)
            rep.sent += len(part)
        if len(rows) < BATCH_ROWS:
            break
    return rep


def run_sync(cfg: dict[str, str]) -> int:
    # MODULES в настройках — только эти модули; не задано — все.
    modules = {m.strip() for m in cfg.get("MODULES", "").split(",") if m.strip()}
    modules = modules or {s.module for s in SOURCES}
    state = State(cfg["STATE_DIR"])
    batch = f"{socket.gethostname()}-{time.strftime('%Y%m%dT%H%M%S')}"
    reports: list[Report] = []
    conns: dict[str, sqlite3.Connection] = {}
    for src in SOURCES:
        if src.module not in modules:
            continue
        rep = Report(src.target)
        try:
            if src.db not in conns:
                conns[src.db] = open_ro(require(cfg, src.db))
            conn = conns[src.db]
            if not table_exists(conn, src.table):
                if not src.optional:
                    raise AgentError(f"Нет таблицы {src.table}")
                rep.skipped = "нет таблицы"
            elif src.mode == "append":
                rep = sync_append(cfg, state, conn, src, batch)
            else:
                rep = sync_diff(cfg, state, conn, src, batch)
        except (AgentError, sqlite3.Error) as e:
            rep.error = str(e)
        state.save_run(src.target, rep.sent, rep.deleted, rep.total, rep.error)
        reports.append(rep)
        if rep.error:
            print(f"[ошибка] {src.target}: {rep.error}", flush=True)
        elif rep.sent or rep.deleted:
            print(f"{src.target}: отправлено {rep.sent}, удалено {rep.deleted}, всего {rep.total}", flush=True)
    for c in conns.values():
        c.close()

    errors = [r for r in reports if r.error]
    heartbeat = {
        "version": VERSION,
        "host": socket.gethostname(),
        "modules": sorted(modules),
        "sources": [
            {"target": r.target, "sent": r.sent, "deleted": r.deleted, "total": r.total,
             "error": r.error, "skipped": r.skipped}
            for r in reports
        ],
    }
    try:
        post(cfg, {"batch": batch, "items": [], "agent": heartbeat})
    except AgentError as e:
        print(f"[ошибка] отметка «агент на связи»: {e}", flush=True)
        return 1
    return 1 if errors else 0


def run_check(cfg: dict[str, str]) -> int:
    res = post(cfg, {"batch": "check", "items": [],
                     "agent": {"version": VERSION, "host": socket.gethostname(), "check": True}})
    if not res.get("ok"):
        print(f"Портал не принял проверку: {res.get('error')}")
        return 1
    print("Связь с порталом есть, подпись принята.")
    for key in sorted({s.db for s in SOURCES}):
        path = cfg.get(key, "")
        mark = "есть" if path and Path(path).exists() else "НЕТ"
        print(f"  {key} = {path} — {mark}")
    return 0


def run_status(cfg: dict[str, str]) -> int:
    state = State(cfg["STATE_DIR"])
    rows = state.runs()
    if not rows:
        print("Агент ещё ничего не отправлял.")
        return 0
    for target, at, sent, deleted, total, error in rows:
        when = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(at))
        line = f"{target}: {when}, строк {total}, отправлено {sent}, удалено {deleted}"
        print(line + (f" — ОШИБКА: {error}" if error else ""))
    return 0


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Синхронизация старого портала аналитики с порталом")
    ap.add_argument("--config", default=DEFAULT_CONFIG)
    ap.add_argument("--check", action="store_true", help="проверить связь с порталом")
    ap.add_argument("--status", action="store_true", help="что и когда отправлено")
    ap.add_argument("--reset", metavar="TARGET", help="забыть отправленное (таблица портала или all)")
    args = ap.parse_args(argv)
    cfg = load_config(args.config)
    try:
        if args.status:
            return run_status(cfg)
        if args.reset:
            known = {s.target for s in SOURCES}
            if args.reset != "all" and args.reset not in known:
                raise AgentError(f"Нет такой таблицы: {args.reset}")
            State(cfg["STATE_DIR"]).reset(None if args.reset == "all" else args.reset)
            print("Готово: следующий запуск отправит заново.")
            return 0
        if args.check:
            return run_check(cfg)
        return run_sync(cfg)
    except AgentError as e:
        print(f"[ошибка] {e}", flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
