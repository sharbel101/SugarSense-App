"""Persistent guard for Garmin username/password logins.

GOLDEN RULE of this project: nothing that runs automatically may ever log in with a username and password. Only first_login.py can,
by hand, and only through this guard. Every attempt is written to disk BEFORE it is made (so a crash or Ctrl-C still counts), the file
survives restarts, and a login is refused when ANY of these is true:

  * an attempt (any result, including one that never finished) happened in the last 15 minutes
  * any attempt in the last 24 hours got a 429 / 403 / "locked" answer
  * 3 or more attempts were made in the last 24 hours

When it refuses it prints the exact time the next attempt is allowed. There is no flag, environment variable or function argument in
the production path that skips these rules; the only way around the guard is to edit the log file by hand, which is a human decision.
If the log file cannot be read it REFUSES (fails closed) instead of starting from an empty history.

This module is cross-platform (Linux VM and a Windows/macOS laptop) and uses only the standard library.
"""
from __future__ import annotations

import json
import os
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

TOKEN_DIR = Path.home() / ".garminconnect"
ATTEMPTS_PATH = TOKEN_DIR / "login_attempts.json"

MIN_GAP_S = 15 * 60
WINDOW_S = 24 * 60 * 60
MAX_ATTEMPTS_PER_WINDOW = 3


class LoginRefused(Exception):
    """The guard does not allow a login attempt now. `next_allowed_epoch` is None only when the log is unreadable (a human must look)."""

    def __init__(self, message: str, next_allowed_epoch: float | None = None, reasons: list[str] | None = None):
        super().__init__(message)
        self.next_allowed_epoch = next_allowed_epoch
        self.reasons = reasons or []


@dataclass
class Decision:
    allowed: bool
    next_allowed_epoch: float | None = None
    reasons: list[str] = field(default_factory=list)


def classify_error(error: BaseException | str | None) -> tuple[int | None, bool]:
    """(status, locked) from an exception or text. 429 / 403 / locked answers make the next 24 hours blocked."""
    if error is None:
        return None, False
    text = (str(error) + " " + type(error).__name__ if isinstance(error, BaseException) else str(error)).lower()
    status: int | None = None
    if "429" in text or "toomanyrequests" in text or "too many requests" in text or "rate limit" in text:
        status = 429
    elif "403" in text or "forbidden" in text:
        status = 403
    locked = any(w in text for w in ("locked", "suspended", "account is blocked", "accountlocked"))
    return status, locked


def _fmt(epoch: float) -> str:
    utc = datetime.fromtimestamp(epoch, timezone.utc)
    local = datetime.fromtimestamp(epoch).astimezone()
    return f"{utc:%Y-%m-%d %H:%M:%S} UTC ({local:%Y-%m-%d %H:%M:%S %Z} on this computer)"


def _chmod(path: Path, mode: int) -> None:
    try:
        os.chmod(path, mode)
    except OSError:  # Windows or a filesystem without modes
        pass


class _Lock:
    """Exclusive cross-process lock on a sidecar file (fcntl on POSIX, msvcrt on Windows)."""

    def __init__(self, path: Path):
        self.path = path
        self.fh = None

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


class LoginGuard:
    def __init__(self, path: Path | None = None, clock: Callable[[], float] = time.time):
        # `path` and `clock` exist so the tests can use a temporary folder and a fake clock. first_login.py never passes them.
        self.path = Path(path) if path is not None else ATTEMPTS_PATH
        self.clock = clock

    # ---------------------------------------------------------------- storage
    def _load(self) -> list[dict]:
        if not self.path.exists():
            return []
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            attempts = data["attempts"]
            if not isinstance(attempts, list):
                raise ValueError("attempts is not a list")
            for a in attempts:
                float(a["epoch"])
            return attempts
        except Exception as e:  # fail closed: never treat an unreadable history as an empty one
            raise LoginRefused(
                f"REFUSING: the login attempt log {self.path} cannot be read ({type(e).__name__}). "
                "Fix or restore it by hand; a guard that cannot see its history must not allow a login."
            ) from e

    def _save(self, attempts: list[dict]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        _chmod(self.path.parent, 0o700)
        tmp = self.path.with_name(self.path.name + ".tmp")
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump({"version": 1, "attempts": attempts}, fh, indent=1)
            fh.flush()
            os.fsync(fh.fileno())
        _chmod(tmp, 0o600)
        os.replace(tmp, self.path)
        _chmod(self.path, 0o600)

    def _lock(self) -> _Lock:
        return _Lock(self.path.with_name(self.path.name + ".lock"))

    # ---------------------------------------------------------------- rules
    @staticmethod
    def _evaluate(attempts: list[dict], now: float) -> Decision:
        reasons: list[str] = []
        waits: list[float] = []
        epochs = sorted(float(a["epoch"]) for a in attempts)
        recent = [e for e in epochs if now - e < WINDOW_S]
        if epochs and now - epochs[-1] < MIN_GAP_S:
            waits.append(epochs[-1] + MIN_GAP_S)
            reasons.append("an attempt was made in the last 15 minutes")
        blocked = [float(a["epoch"]) for a in attempts if now - float(a["epoch"]) < WINDOW_S and (a.get("status") in (429, 403) or a.get("locked"))]
        if blocked:
            waits.append(max(blocked) + WINDOW_S)
            reasons.append("an attempt in the last 24 hours was answered with 429 / 403 / locked")
        if len(recent) >= MAX_ATTEMPTS_PER_WINDOW:
            waits.append(recent[-MAX_ATTEMPTS_PER_WINDOW] + WINDOW_S)
            reasons.append(f"{len(recent)} attempts were made in the last 24 hours (the limit is {MAX_ATTEMPTS_PER_WINDOW - 1})")
        return Decision(allowed=not waits, next_allowed_epoch=max(waits) if waits else None, reasons=reasons)

    def evaluate(self) -> Decision:
        return self._evaluate(self._load(), self.clock())

    def _raise_if_refused(self, d: Decision) -> None:
        if d.allowed:
            return
        nxt = d.next_allowed_epoch
        raise LoginRefused(
            "LOGIN REFUSED by the guard: " + "; ".join(d.reasons) + f". The next attempt is allowed at {_fmt(nxt)}.",
            next_allowed_epoch=nxt,
            reasons=d.reasons,
        )

    def check_or_raise(self) -> None:
        with self._lock():
            self._raise_if_refused(self._evaluate(self._load(), self.clock()))

    # ---------------------------------------------------------------- recording
    def begin(self) -> int:
        """Re-check and record the attempt on disk BEFORE it is made. Returns an id for finish()."""
        with self._lock():
            attempts = self._load()
            now = self.clock()
            self._raise_if_refused(self._evaluate(attempts, now))
            attempts.append(
                {"epoch": now, "at": datetime.fromtimestamp(now, timezone.utc).isoformat(timespec="seconds"), "result": "started", "status": None, "locked": False, "error": None}
            )
            self._save(attempts)
            return len(attempts) - 1

    def finish(self, attempt_id: int, ok: bool, error: BaseException | str | None = None) -> None:
        with self._lock():
            attempts = self._load()
            rec = attempts[attempt_id]
            status, locked = classify_error(error)
            rec["result"] = "success" if ok else "failure"
            rec["status"] = None if ok else status
            rec["locked"] = False if ok else locked
            rec["error"] = None if ok or error is None else (type(error).__name__ + ": " if isinstance(error, BaseException) else "") + str(error)[:200]
            self._save(attempts)

    def describe(self) -> str:
        d = self.evaluate()
        n = len(self._load())
        if d.allowed:
            return f"login allowed now ({n} attempt(s) on record)"
        return "login NOT allowed: " + "; ".join(d.reasons) + f". Next attempt allowed at {_fmt(d.next_allowed_epoch)}."


def main(argv: list[str]) -> int:
    """Read-only status. There is deliberately no option here that records, clears or bypasses anything."""
    g = LoginGuard()
    try:
        print(g.describe())
        return 0
    except LoginRefused as e:
        print(e)
        return 3


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
