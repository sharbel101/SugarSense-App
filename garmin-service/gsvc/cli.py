"""Operator commands (run from the garmin-service folder with its venv):

  python -m gsvc.cli run-worker   the poller (what the systemd unit runs). Exits at once if polling is disabled, the key is missing, or another worker holds the lock.
  python -m gsvc.cli once         one cycle right now, then exit (still honours the pause flags)
  python -m gsvc.cli status       print the pause flags and the settings (offline; sends nothing)
  python -m gsvc.cli pause        stop polling without touching stored data (creates state/PAUSED; the worker notices within a minute)
  python -m gsvc.cli resume       remove state/PAUSED and state/AUTH_FAILED

The Personal API key comes from GARMIN_PERSONAL_API_KEY in the private service.env (chmod 600). There is nothing to sign in to.
"""
from __future__ import annotations

import json
import logging
import signal
import sys
from datetime import datetime, timezone

from .config import ConfigError, load_settings
from .personal import PersonalClient
from .store import PgStore
from .worker import AUTH_FAILED_FILE, PAUSED_FILE, Worker


def _build(settings):
    if not settings.worker_db_url:
        raise ConfigError("GARMIN_WORKER_DATABASE_URL is not set")
    if not settings.personal_api_key:
        raise ConfigError("GARMIN_PERSONAL_API_KEY is not set")
    store = PgStore(settings.worker_db_url)
    return Worker(settings, store, PersonalClient(settings.personal_api_key)), store


def cmd_status(settings) -> int:
    print(json.dumps({"polling_enabled": settings.polling_enabled, "key_configured": bool(settings.personal_api_key), "poll_min": settings.poll_min,
                      "paused_file": (settings.state_dir / PAUSED_FILE).exists(), "auth_failed_file": (settings.state_dir / AUTH_FAILED_FILE).exists()}, indent=1))
    return 0


def _run_worker(settings) -> int:
    if not settings.polling_enabled:
        print("polling is disabled (GARMIN_POLLING_ENABLED is not true); exiting")
        return 0
    worker, store = _build(settings)
    if not store.acquire_singleton():
        print("another garmin worker holds the lock; exiting")
        return 0
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: worker.stop())
    logging.info(json.dumps({"event": "worker_start", "poll_min": settings.poll_min, "at": datetime.now(timezone.utc).isoformat(timespec="seconds")}))
    try:
        worker.run_forever()
    finally:
        store.close()
    return 0


def _once(settings) -> int:
    worker, store = _build(settings)
    reason = worker.paused_reason()
    if reason:
        print("not running:", reason)
        return 3
    print(json.dumps(worker.run_cycle(), default=str, indent=1))
    worker.heartbeat(None, "manual once")
    store.close()
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
            print("resumed")
            return 0
        if cmd == "run-worker":
            return _run_worker(s)
        if cmd == "once":
            return _once(s)
    except ConfigError as e:
        print("config error:", e)
        return 2
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
