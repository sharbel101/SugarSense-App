"""Operator commands (run from the garmin-service folder with its venv):

  python -m gsvc.cli run-worker   the polling worker (what the systemd unit runs). Exits at once if polling is disabled or another worker holds the lock.
  python -m gsvc.cli once         run whatever is due right now, a single cycle, then exit (still through the Gate and all pause flags)
  python -m gsvc.cli status       print pause flags and the Gate state (offline; sends nothing)
  python -m gsvc.cli pause        stop polling without touching stored data (creates state/PAUSED; the worker notices within a minute)
  python -m gsvc.cli resume       remove state/PAUSED and state/AUTH_FAILED (NEEDS_LOGIN is removed only by a successful manual `connector_client.py login`)

There is deliberately no command here that signs in.
"""
from __future__ import annotations

import asyncio
import json
import logging
import signal
import sys
import time
from datetime import datetime, timezone

import connector_client as cc
from oauth_support import NEEDS_LOGIN_FLAG
from rate_gate import Gate

from .config import ConfigError, load_settings
from .gateway import Gateway
from .store import PgStore
from .worker import AUTH_FAILED_FILE, PAUSED_FILE, Worker


def _build(settings):
    if not settings.worker_db_url:
        raise ConfigError("GARMIN_WORKER_DATABASE_URL is not set")
    store = PgStore(settings.worker_db_url)
    gate = Gate()
    return Worker(settings, store, gate, Gateway(cc.load_config(), gate), NEEDS_LOGIN_FLAG), store


def cmd_status(settings) -> int:
    snap = Gate().snapshot()
    now = time.time()
    print(
        json.dumps(
            {
                "polling_enabled": settings.polling_enabled,
                "paused_file": (settings.state_dir / PAUSED_FILE).exists(),
                "auth_failed_file": (settings.state_dir / AUTH_FAILED_FILE).exists(),
                "needs_login_file": NEEDS_LOGIN_FLAG.exists(),
                "gate": {"consecutive_failures": snap["consecutive_failures"], "backoff_seconds_left": max(0, int(snap["backoff_until"] - now)), "breaker_seconds_left": max(0, int(snap["breaker_open_until"] - now))},
                "intervals_min": {"fast": settings.fast_interval_min, "stress": settings.stress_interval_min},
            },
            indent=1,
        )
    )
    return 0


async def _run_worker(settings) -> int:
    worker, store = _build(settings)
    if not settings.polling_enabled:
        print("polling is disabled (GARMIN_POLLING_ENABLED is not true); exiting")
        return 0
    if not store.acquire_singleton():
        print("another garmin worker holds the lock; exiting")
        return 0
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, worker.stop)
    logging.info(json.dumps({"event": "worker_start", "fast_min": settings.fast_interval_min, "at": datetime.now(timezone.utc).isoformat(timespec="seconds")}))
    try:
        await worker.run_forever()
    finally:
        store.close()
    return 0


async def _once(settings) -> int:
    worker, store = _build(settings)
    reason = worker.paused_reason()
    if reason:
        print("not running:", reason)
        return 3
    print(json.dumps(await worker.run_cycle(), default=str, indent=1))
    worker.heartbeat(None, "manual once")
    return 0


def main(argv: list[str]) -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    cmd = argv[0] if argv else ""
    try:
        s = load_settings()
        if cmd == "status":
            return cmd_status(s)
        if cmd == "pause":
            s.state_dir.mkdir(parents=True, exist_ok=True)
            (s.state_dir / PAUSED_FILE).write_text("paused by operator\n")
            print("paused: stored data is untouched; run `resume` to continue")
            return 0
        if cmd == "resume":
            for n in (PAUSED_FILE, AUTH_FAILED_FILE):
                (s.state_dir / n).unlink(missing_ok=True)
            print("resumed (if NEEDS_LOGIN exists, polling stays paused until a manual sign-in)")
            return 0
        if cmd == "run-worker":
            return asyncio.run(_run_worker(s))
        if cmd == "once":
            return asyncio.run(_once(s))
    except ConfigError as e:
        print("config error:", e)
        return 2
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
