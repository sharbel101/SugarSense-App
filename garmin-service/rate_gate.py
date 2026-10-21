"""Shared request gate for the AthleteData connector client (same rules as ~/garmin-api/garmin_data.py, kept separate on purpose).

State lives in ~/garmin-mcp/state/gate_state.json and survives restarts; a file lock makes it safe across processes:
  * at least 2 s (plus up to 0.5 s of jitter) between any two requests
  * a poll cycle at most every 5 minutes
  * after an error that looks like a rate limit: wait 5 min, then 15, 60, 180, and at most 6 h for each further consecutive one
  * 3 consecutive failures open a circuit breaker: ALL calls are refused for 30 minutes, then ONE probe call is let through
Unreadable state pauses everything instead of allowing it.
"""
from __future__ import annotations

import json
import os
import random
import time
from pathlib import Path
from typing import Callable

HERE = Path(__file__).resolve().parent
STATE_PATH = HERE / "state" / "gate_state.json"

MIN_REQUEST_GAP_S = 2.0
JITTER_MAX_S = 0.5
POLL_MIN_INTERVAL_S = 5 * 60
BACKOFF_SCHEDULE_MIN = (5, 15, 60, 180, 360)
BREAKER_THRESHOLD = 3
BREAKER_PAUSE_S = 30 * 60

_DEFAULT = {"last_request_epoch": 0.0, "last_poll_epoch": 0.0, "backoff_level": 0, "backoff_until": 0.0, "consecutive_failures": 0, "breaker_open_until": 0.0, "breaker_half_open": False}


class CallBlocked(Exception):
    def __init__(self, reason: str, until_epoch: float | None = None):
        super().__init__(reason)
        self.reason, self.until_epoch = reason, until_epoch


def _chmod(path: Path, mode: int) -> None:
    try:
        os.chmod(path, mode)
    except OSError:
        pass


class _Lock:
    def __init__(self, path: Path):
        self.path, self.fh = path, None

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.fh = open(self.path, "a+")
        if os.name == "nt":
            import msvcrt

            self.fh.seek(0)
            msvcrt.locking(self.fh.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl

            fcntl.flock(self.fh, fcntl.LOCK_EX)
        return self

    def __exit__(self, *exc):
        try:
            if os.name == "nt":
                import msvcrt

                self.fh.seek(0)
                msvcrt.locking(self.fh.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(self.fh, fcntl.LOCK_UN)
        finally:
            self.fh.close()


class Gate:
    def __init__(self, path: Path | None = None, clock: Callable[[], float] = time.time, sleep: Callable[[float], None] = time.sleep, jitter: Callable[[], float] | None = None):
        self.path = Path(path) if path is not None else STATE_PATH
        self.clock, self.sleep = clock, sleep
        self.jitter = jitter or (lambda: random.uniform(0, JITTER_MAX_S))

    def _lock(self) -> _Lock:
        return _Lock(self.path.with_name(self.path.name + ".lock"))

    def _load(self) -> dict:
        if not self.path.exists():
            return dict(_DEFAULT)
        try:
            return {**_DEFAULT, **json.loads(self.path.read_text(encoding="utf-8"))}
        except Exception:
            return {**_DEFAULT, "breaker_open_until": self.clock() + BREAKER_PAUSE_S, "consecutive_failures": BREAKER_THRESHOLD}

    def _save(self, st: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        _chmod(self.path.parent, 0o700)
        tmp = self.path.with_name(self.path.name + ".tmp")
        tmp.write_text(json.dumps(st, indent=1), encoding="utf-8")
        _chmod(tmp, 0o600)
        os.replace(tmp, self.path)

    def may_poll(self) -> tuple[bool, float]:
        with self._lock():
            wait = self._load()["last_poll_epoch"] + POLL_MIN_INTERVAL_S - self.clock()
            return (wait <= 0, max(0.0, wait))

    def mark_polled(self) -> None:
        with self._lock():
            st = self._load()
            st["last_poll_epoch"] = self.clock()
            self._save(st)

    def before_request(self) -> None:
        with self._lock():
            st = self._load()
            now = self.clock()
            if st["backoff_until"] > now:
                raise CallBlocked("backing off after a rate-limit answer", st["backoff_until"])
            if st["breaker_open_until"] > now:
                raise CallBlocked("circuit breaker open after 3 consecutive failures", st["breaker_open_until"])
            if st["consecutive_failures"] >= BREAKER_THRESHOLD and not st["breaker_half_open"]:
                st["breaker_half_open"] = True
            gap = st["last_request_epoch"] + MIN_REQUEST_GAP_S + self.jitter() - now
            if gap > 0:
                self.sleep(gap)
            st["last_request_epoch"] = self.clock()
            self._save(st)

    def record_success(self) -> None:
        with self._lock():
            st = self._load()
            st.update(consecutive_failures=0, backoff_level=0, backoff_until=0.0, breaker_open_until=0.0, breaker_half_open=False)
            self._save(st)

    def record_failure(self, rate_limited: bool, retry_after_s: float | None = None) -> None:
        """A rate-limit answer waits for the longer of the schedule step and the server's Retry-After (capped at the schedule's last step, 6 h)."""
        with self._lock():
            st = self._load()
            now = self.clock()
            st["consecutive_failures"] += 1
            if rate_limited:
                st["backoff_level"] = min(st["backoff_level"] + 1, len(BACKOFF_SCHEDULE_MIN))
                wait = BACKOFF_SCHEDULE_MIN[st["backoff_level"] - 1] * 60
                if retry_after_s and retry_after_s > 0:
                    wait = max(wait, min(float(retry_after_s), BACKOFF_SCHEDULE_MIN[-1] * 60))
                st["backoff_until"] = now + wait
            if st["consecutive_failures"] >= BREAKER_THRESHOLD:
                st["breaker_open_until"] = now + BREAKER_PAUSE_S
                st["breaker_half_open"] = False
            self._save(st)

    def snapshot(self) -> dict:
        with self._lock():
            return self._load()
