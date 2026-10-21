"""Command line. By default prints only counts, categories and timings: no glucose values, notes or insight text reach logs/journald.

  python -m sugarsense_insights run morning|evening|event --user UUID | --all-users [--now ISO] [--no-llm] [--dry-run] [--show]
  python -m sugarsense_insights tick --all-users          # what the systemd timer runs: decides which of morning/evening/event is due
Environment: DATABASE_URL (required unless --dry-run with a test source), INSIGHTS_LLM_URL (default http://127.0.0.1:8181).
"""
from __future__ import annotations

import argparse

import json
import os
import sys
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from .config import LlmConfig
from .features import hhmm
from .llm import LlamaClient
from .pipeline import run
from .store import InMemoryStore, PgStore

LOCK = os.environ.get("INSIGHTS_LOCK", "/tmp/sugarsense-insights.lock")
DUE_WINDOW_H = 6   # a missed 07:00 briefing is still produced until 13:00 local, then skipped for the day


def due_kinds(tz: str, wake: str, recap: str, now: datetime) -> list[str]:
    """Which scheduled kinds are due now, in the user's own timezone. Pure; unit-tested."""
    try:
        z = ZoneInfo(tz)
    except Exception:
        z = ZoneInfo("UTC")
    loc = now.astimezone(z)
    out = []
    for kind, at in (("morning", wake), ("evening", recap)):
        t = hhmm(at)
        start = loc.replace(hour=t.hour, minute=t.minute, second=0, microsecond=0)
        if start <= loc < start + timedelta(hours=DUE_WINDOW_H):
            out.append(kind)
    return out


def _summary(user: str, r) -> dict:
    s = r.stats
    return {"user": user[:8], "run_key": r.run_key, "state": r.state, "insights": s.get("insights"), "categories": s.get("categories"),
            "candidates": s.get("candidates"), "llm_calls": s.get("llm_calls"), "llm_latency_s": s.get("llm_latency_s"), "fallbacks": s.get("fallbacks"),
            "violations": s.get("violations"), "llm_error": s.get("llm_error"), "total_s": s.get("total_s"), "error": s.get("error")}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="sugarsense_insights")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("run", "tick"):
        p = sub.add_parser(name)
        if name == "run":
            p.add_argument("kind", choices=["morning", "evening", "event"])
        p.add_argument("--user")
        p.add_argument("--all-users", action="store_true")
        p.add_argument("--now")
        p.add_argument("--no-llm", action="store_true")
        p.add_argument("--dry-run", action="store_true", help="compute and print; write nothing")
        p.add_argument("--show", action="store_true", help="print insight content (health data) to stdout; never used by the timers")
    a = ap.parse_args(argv)

    import fcntl
    lock_f = open(LOCK, "w")
    try:
        fcntl.flock(lock_f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print(json.dumps({"state": "busy", "reason": "another insights run holds the lock"}))
        return 0

    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("DATABASE_URL is not set", file=sys.stderr)
        return 2
    from .db_source import PgSource
    source = PgSource(dsn)
    store = InMemoryStore() if a.dry_run else PgStore(dsn)
    llm_cfg = LlmConfig(url=os.environ.get("INSIGHTS_LLM_URL", LlmConfig.url))
    llm = None if a.no_llm else LlamaClient(llm_cfg)
    now = datetime.fromisoformat(a.now).astimezone(timezone.utc) if a.now else datetime.now(timezone.utc)
    users = [a.user] if a.user else (source.list_users() if a.all_users else [])
    if not users:
        print("give --user UUID or --all-users", file=sys.stderr)
        return 2
    code = 0
    for u in users:
        if a.cmd == "run":
            kinds = [a.kind]
        else:
            snap = source.load(u, now, 1)
            kinds = due_kinds(snap.settings.timezone, snap.settings.th.wake, snap.settings.th.recap, now) + ["event"]
        for kind in kinds:
            r = run(kind, u, now, source, store, llm, model_version=None if a.no_llm else "Qwen3.5-4B-Q4_K_M", persist=not a.dry_run)
            print(json.dumps(_summary(u, r)))
            if a.show:
                for rec in r.insights:
                    print(json.dumps({"category": rec["category"], "content": rec["content"]}, default=str))
            if r.state == "failed":
                code = 1
    return code
