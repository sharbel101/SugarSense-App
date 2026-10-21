"""The polling worker: one long-lived process, one job at a time, every request through the shared Gate (2 s gap, 5 min poll floor, 429 backoff, breaker).

What it will never do: sign in (to Garmin or to the gateway), retry a rejected session, or run faster than configured because requests succeed.
  * NeedsLogin / auth failure -> polling pauses (flag files in the state dir) until a human fixes it. Rate limit -> the Gate's backoff, no requests until it ends.
  * Due times come from the database, so a restart cannot cause a burst; the frontend never triggers a fetch (the API only reads the database).
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import random
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

from rate_gate import CallBlocked, Gate

from .catalog import Every, Job, ToolCall, build_jobs
from .config import Settings
from .gateway import Gateway, classify, retry_after_seconds
from .parsers import Ctx, SchemaDrift
from .scheduler import OK_OUTCOMES, is_due, next_wakeup
from .store import WORKER_ROW, RunRecord, scrub

PAUSED_FILE = "PAUSED"
AUTH_FAILED_FILE = "AUTH_FAILED"
RUN_RETENTION_DAYS = 30


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class Counters:
    requests: int = 0
    errors: int = 0
    rate_limits: int = 0
    cache_hits: int = 0
    rows_new: int = 0
    cycles: int = 0

    def as_dict(self) -> dict:
        return dict(self.__dict__)


class Worker:
    def __init__(self, settings: Settings, store, gate: Gate, gateway: Gateway, needs_login_flag: Path, now_fn=utcnow, rand=random.random, jobs: list[Job] | None = None):
        self.s, self.store, self.gate, self.gw = settings, store, gate, gateway
        self.needs_login_flag, self.now, self.rand = needs_login_flag, now_fn, rand
        self.jobs = jobs or build_jobs(settings)
        self.counters = Counters()
        self._hashes: dict[tuple, str] = {}
        self._stop = asyncio.Event()
        self._last_prune: datetime | None = None

    # ------------------------------------------------------------------ pause logic
    def pause_flag(self, name: str) -> Path:
        return self.s.state_dir / name

    def paused_reason(self) -> str | None:
        if not self.s.polling_enabled:
            return "disabled (GARMIN_POLLING_ENABLED is not true)"
        if self.pause_flag(PAUSED_FILE).exists():
            return "paused by an operator (state/PAUSED)"
        if self.needs_login_flag.exists():
            return "needs a manual gateway sign-in (NEEDS_LOGIN)"
        if self.pause_flag(AUTH_FAILED_FILE).exists():
            return "the gateway rejected the account/session (state/AUTH_FAILED); fix it, then run: python -m gsvc.cli resume"
        return None

    def _set_flag(self, name: str, reason: str) -> None:
        p = self.pause_flag(name)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps({"reason": scrub(reason), "at": self.now().isoformat()}) + "\n", encoding="utf-8")
        try:
            p.chmod(0o600)
        except OSError:
            pass

    # ------------------------------------------------------------------ scheduling
    def _jitter(self) -> float:
        return self.rand() * 30.0

    def due_jobs(self, now: datetime) -> list[Job]:
        out = []
        for job in self.jobs:
            d = is_due(job, self.store.get_state(job.name), now, self.s.tz, jitter_s=self._jitter() if isinstance(job.schedule, Every) else 0.0)
            if d.due:
                out.append(job)
        return out

    def _days(self, call: ToolCall, now: datetime):
        local = now.astimezone(self.s.tz)
        days = [local.date()]
        if call.previous_day_early and local.hour == 0 and local.minute < 20:
            days.insert(0, local.date() - timedelta(days=1))
        return days

    # ------------------------------------------------------------------ one cycle
    async def run_cycle(self) -> dict:
        now = self.now()
        due = self.due_jobs(now)
        if not due:
            return {"ran": [], "note": "nothing due"}
        ok, wait = self.gate.may_poll()
        if not ok:
            return {"ran": [], "note": f"poll floor: next gateway session in {int(wait)} s"}
        self.gate.mark_polled()  # before the first request, so a crash cannot become a hot loop
        self.counters.cycles += 1
        ran: list[str] = []
        try:
            async with self.gw.session() as session:
                self.gate.record_success()
                for job in due:
                    stop = await self._run_job(job, session, now)
                    ran.append(job.name)
                    if stop:
                        break
        except CallBlocked as b:
            return {"ran": ran, "note": f"blocked locally: {b.reason}"}
        except BaseException as e:  # noqa: BLE001 - connection level failure (nothing was fetched)
            if isinstance(e, (KeyboardInterrupt, SystemExit, asyncio.CancelledError)):
                raise
            if type(e).__module__.startswith("psycopg"):  # our own database, not the gateway: do not count it against the Gate
                self.counters.errors += 1
                return {"ran": ran, "note": "database error; will retry on the next loop"}
            kind = classify(e)
            self._after_failure(kind, e)
            rec = RunRecord("(connect)", now, _outcome_for(kind), finished_at=self.now(), error_class=type(e).__name__, error_text=str(e))
            self.store.record_run(rec)
            for job in due:  # the attempt counts, so Every-jobs back off instead of hot-looping
                self._attempt(job, now, _outcome_for(kind), success=False)
            return {"ran": ran, "note": f"connection failed ({kind})"}
        return {"ran": ran}

    def _after_failure(self, kind: str, e: BaseException) -> None:
        self.counters.errors += 1
        if kind == "needs_login":
            return  # oauth_support already wrote NEEDS_LOGIN; nothing was sent that counts against the service
        if kind == "auth_failed":
            self._set_flag(AUTH_FAILED_FILE, f"{type(e).__name__}: {e}")
            return
        if kind == "rate_limited":
            self.counters.rate_limits += 1
            self.gate.record_failure(rate_limited=True, retry_after_s=retry_after_seconds(e))
        elif kind == "transient":
            self.gate.record_failure(rate_limited=False)

    async def _run_job(self, job: Job, session, now: datetime) -> bool:
        """Run one job; returns True when the cycle must stop (rate limit, auth, connection trouble)."""
        t0 = time.monotonic()
        started = self.now()
        rec = RunRecord(job.name, started, "ok")
        rows = []
        pending_hashes: dict[tuple, str] = {}
        stop = False
        for call in job.calls:
            for day in self._days(call, now):
                try:
                    payload = await session.call(call.tool, call.args(day))
                except BaseException as e:  # noqa: BLE001
                    if isinstance(e, (KeyboardInterrupt, SystemExit, asyncio.CancelledError)):
                        raise
                    if isinstance(e, CallBlocked):
                        rec.outcome, rec.error_class, rec.error_text = "blocked", "CallBlocked", e.reason
                        stop = True
                        break
                    kind = classify(e)
                    rec.error_class, rec.error_text = type(e).__name__, str(e)
                    rec.outcome = _outcome_for(kind)
                    self._after_failure(kind, e)
                    if kind != "tool_error":
                        stop = True
                        break
                    continue  # the gateway answered; other tools in this job may still work
                self.gate.record_success()
                rec.requests += 1
                self.counters.requests += 1
                h = hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()
                key = (call.tool, day)
                if self._hashes.get(key) == h:
                    rec.cache_hits += 1
                    self.counters.cache_hits += 1
                    continue
                try:
                    obs = call.parse(payload, Ctx(self.s.tz, day, self.now()))
                except SchemaDrift as e:
                    rec.outcome, rec.error_class, rec.error_text = "schema_drift", "SchemaDrift", str(e)
                    continue
                rows.extend(obs)
                pending_hashes[key] = h
            if stop:
                break
        fetched_at = self.now()
        new = changed = 0
        if rows:
            new, changed = self.store.upsert_observations(rows, fetched_at)
            self._hashes.update(pending_hashes)  # remembered only after the rows are safely stored
        else:
            self._hashes.update(pending_hashes)
        rec.rows_seen, rec.rows_new = len(rows), new
        rec.latest_measured_at = max((o.measured_at for o in rows), default=None)
        if rec.outcome == "ok":
            if rows and (new or changed):
                rec.outcome = "ok"
            elif rows or rec.cache_hits:
                rec.outcome = "unchanged"
            else:
                rec.outcome = "empty"
        elif rec.outcome == "error" and rows:
            rec.outcome = "partial"
        self.counters.rows_new += new
        rec.finished_at = self.now()
        rec.duration_ms = int((time.monotonic() - t0) * 1000)
        self.store.record_run(rec)
        self._attempt(job, now, rec.outcome, success=rec.outcome in OK_OUTCOMES, new=new > 0, latest=rec.latest_measured_at)
        return stop

    def _attempt(self, job: Job, now: datetime, outcome: str, success: bool, new: bool = False, latest: datetime | None = None) -> None:
        st = self.store.get_state(job.name)
        fields: dict = {"last_attempt_at": now, "last_outcome": outcome}
        failed = outcome in {"error", "rate_limited", "auth_failed", "needs_login", "schema_drift", "blocked"}
        fields["consecutive_failures"] = (st.consecutive_failures + 1) if failed else 0
        if success:
            fields["last_success_at"] = self.now()
        if new:
            fields["last_new_data_at"] = self.now()
        if latest is not None:
            fields["last_measured_at"] = latest
        sch = job.schedule
        if not isinstance(sch, Every):
            d = is_due(job, st, now, self.s.tz)
            key = d.slot_key
            if key is not None:
                fields["slot_key"] = key
                fields["slot_attempts"] = (st.slot_attempts if st.slot_key == key else 0) + 1
        self.store.put_state(job.name, **fields)

    # ------------------------------------------------------------------ heartbeat + loop
    def heartbeat(self, reason: str | None, note: str = "") -> None:
        try:
            snap = self.gate.snapshot()
        except Exception:  # noqa: BLE001
            snap = {}
        now_e = self.now().timestamp()
        extra = {
            "paused_reason": reason,
            "note": note,
            "counters": self.counters.as_dict(),
            "gate": {
                "consecutive_failures": snap.get("consecutive_failures", 0),
                "backoff_level": snap.get("backoff_level", 0),
                "backoff_until": _epoch_iso(snap.get("backoff_until")) if (snap.get("backoff_until") or 0) > now_e else None,
                "breaker_open_until": _epoch_iso(snap.get("breaker_open_until")) if (snap.get("breaker_open_until") or 0) > now_e else None,
            },
            "intervals": {"fast_min": self.s.fast_interval_min, "stress_min": self.s.stress_interval_min},
        }
        self.store.put_state(WORKER_ROW, last_attempt_at=self.now(), extra=extra)

    def stop(self) -> None:
        self._stop.set()

    async def _sleep(self, seconds: float) -> None:
        try:
            await asyncio.wait_for(self._stop.wait(), timeout=seconds)
        except asyncio.TimeoutError:
            pass

    async def run_forever(self) -> None:
        await self._sleep(5 + self.rand() * 25)  # startup jitter: a restart is never an instant request
        while not self._stop.is_set():
            reason = self.paused_reason()
            self.heartbeat(reason)
            if reason:
                await self._sleep(60)
                continue
            snap = self.gate.snapshot()
            blocked_until = max(snap.get("backoff_until", 0.0), snap.get("breaker_open_until", 0.0))
            if blocked_until > self.now().timestamp():
                await self._sleep(min(300.0, blocked_until - self.now().timestamp() + 5 + self.rand() * 10))
                continue
            try:
                res = await self.run_cycle()
            except Exception as e:  # noqa: BLE001 - never let the loop die loudly into a restart storm
                res = {"note": f"cycle error: {type(e).__name__}"}
                self.counters.errors += 1
            self.heartbeat(None, res.get("note", ""))
            self._maybe_prune()
            await self._sleep(self._until_next())

    def _until_next(self) -> float:
        now = self.now()
        cands = []
        for job in self.jobs:
            d = is_due(job, self.store.get_state(job.name), now, self.s.tz)
            cands.append(d.next_at if not d.due else now + timedelta(seconds=60))
        return next_wakeup(cands, now, floor_s=30.0, cap_s=300.0)

    def _maybe_prune(self) -> None:
        now = self.now()
        if self._last_prune is None or now - self._last_prune > timedelta(hours=24):
            try:
                self.store.prune_runs(now - timedelta(days=RUN_RETENTION_DAYS))
            finally:
                self._last_prune = now


def _outcome_for(kind: str) -> str:
    return {"needs_login": "needs_login", "auth_failed": "auth_failed", "rate_limited": "rate_limited", "tool_error": "error", "transient": "error"}[kind]


def _epoch_iso(e) -> str | None:
    return datetime.fromtimestamp(e, timezone.utc).isoformat(timespec="seconds") if e else None
