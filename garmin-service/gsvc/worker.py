"""The poller: one small loop that reads Garmin's official Personal API every few minutes and stores what it returns.

  * One request set per cycle (default every 10 minutes): heart rate, the day summary, and (every 30 minutes) sleep, HRV and body battery; the exercise list hourly.
    About 5 requests per cycle, a few hundred a day. The watch only syncs in batches, so polling faster would just return the same answer.
  * Rate limited (429) or Garmin down: exponential backoff (never faster than configured because requests succeed). Key rejected: polling pauses (state/AUTH_FAILED) until a
    person fixes the key and runs `python -m gsvc.cli resume`. Nothing here can sign in anywhere; the key only reads.
  * Pressing refresh in the app runs `Worker.refresh()` (through POST /refresh in the API process): everything is fetched right now, with no schedule or minimum gap.
    The background loop only keeps the database warm for the insights engine; it can be switched off (GARMIN_POLLING_ENABLED=false) and refresh still works.
"""
from __future__ import annotations

import json
import random
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Callable

from . import parsers as P
from .config import Settings
from .personal import ApiError, PersonalClient
from .store import WORKER_ROW, RunRecord, scrub

PAUSED_FILE = "PAUSED"
AUTH_FAILED_FILE = "AUTH_FAILED"
RUN_RETENTION_DAYS = 30
SLOW_EVERY_MIN = 30  # sleep, HRV and body battery change a few times a day
ACTIVITIES_EVERY_MIN = 60
BACKOFF_CAP_S = 3600


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


@dataclass(frozen=True)
class Call:
    name: str  # the run-log name and the job group shown by /status
    groups: tuple[str, ...]
    path: str
    parse: Callable
    day: date
    every_min: int | None = None  # None = every cycle


class Worker:
    def __init__(self, settings: Settings, store, client: PersonalClient, now_fn=utcnow, sleep_fn=time.sleep, rand=random.random):
        self.s, self.store, self.client, self.now, self.sleep, self.rand = settings, store, client, now_fn, sleep_fn, rand
        self.last_run: dict[str, datetime] = {}
        self.fail_streak = 0
        self.backoff_until: datetime | None = None
        self.stopped = False
        self.counters = {"requests": 0, "errors": 0, "rate_limits": 0, "rows_new": 0, "cycles": 0}
        self._last_prune: datetime | None = None

    # ------------------------------------------------------------------ pause logic
    def flag(self, name: str) -> Path:
        return self.s.state_dir / name

    def paused_reason(self, manual: bool = False) -> str | None:
        """`manual` = a refresh pressed in the app: it works even when background polling is switched off, but never without a key or after a rejected key."""
        if not manual and not self.s.polling_enabled:
            return "disabled (GARMIN_POLLING_ENABLED is not true)"
        if not self.s.personal_api_key:
            return "no Personal API key (GARMIN_PERSONAL_API_KEY is not set)"
        if self.flag(PAUSED_FILE).exists():
            return "paused by an operator (state/PAUSED)"
        if self.flag(AUTH_FAILED_FILE).exists():
            return "Garmin rejected the Personal API key (state/AUTH_FAILED); create a new key in Garmin Connect, update the service, then run: python -m gsvc.cli resume"
        return None

    def _set_flag(self, name: str, reason: str) -> None:
        p = self.flag(name)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps({"reason": scrub(reason), "at": self.now().isoformat()}) + "\n", encoding="utf-8")
        try:
            p.chmod(0o600)
        except OSError:
            pass

    # ------------------------------------------------------------------ what to fetch
    def plan(self, now: datetime) -> list[Call]:
        local = now.astimezone(self.s.tz)
        d = local.date()
        y = d - timedelta(days=1)
        early = local.hour < 2  # shortly after midnight the previous day is still being completed by the last sync
        days = [y, d] if early else [d]
        calls: list[Call] = []
        for day in days:
            calls.append(Call("fast", ("fast",), f"/wellness-service/wellness/dailyHeartRate?date={day}", P.parse_heart_rate, day))
            calls.append(Call("fast", ("fast", "spo2_resp"), f"/usersummary-service/v2/dailysummaries?startDate={day}&endDate={day}", P.parse_daily_summary, day))
        calls.append(Call("fast", ("fast",), "/activitylist-service/activities/search/activities?start=0&limit=10", P.parse_activities, d, ACTIVITIES_EVERY_MIN))
        calls.append(Call("stress", ("stress",), f"/wellness-service/wellness/bodyBattery/reports/daily?startDate={y}&endDate={d}&chunks=1", P.parse_body_battery, d, SLOW_EVERY_MIN))
        calls.append(Call("sleep", ("sleep", "spo2_resp"), f"/sleep-service/sleep/dailySleep?date={d}", P.parse_sleep, d, SLOW_EVERY_MIN))
        calls.append(Call("hrv", ("hrv",), f"/hrv-service/hrv/{d}", P.parse_hrv, d, SLOW_EVERY_MIN))
        return calls

    def _due(self, call: Call, now: datetime) -> bool:
        if call.every_min is None:
            return True
        last = self.last_run.get(call.path.split("?")[0] + str(call.day))
        return last is None or now - last >= timedelta(minutes=call.every_min)

    # ------------------------------------------------------------------ one cycle
    def run_cycle(self, manual: bool = False) -> dict:
        """One pass over the plan. `manual` (a person pressed refresh) fetches EVERYTHING now, ignoring the slow-call schedule, and a transient Garmin
        error never starts a long backoff (only a 429 does, for as long as Garmin asks)."""
        now = self.now()
        if self.backoff_until and now < self.backoff_until:
            return {"ran": [], "requests": 0, "rows_new": 0, "failed": [], "backoff_until": self.backoff_until, "note": f"backing off until {self.backoff_until.isoformat(timespec='seconds')}"}
        self.counters["cycles"] += 1
        outcomes: dict[str, dict] = {}  # group -> {"rows": [...], "outcome": ..., "requests": n, ...}
        ran: list[str] = []
        failed: list[str] = []
        requests = rows_new = 0
        stop = False
        for call in self.plan(now):
            if not manual and not self._due(call, now):
                continue
            started = self.now()
            rec = RunRecord(call.name, started, "ok")
            try:
                payload = self.client.get(call.path)
                rec.requests = 1
                self.counters["requests"] += 1
                rows = call.parse(payload, P.Ctx(self.s.tz, call.day, self.now()))
                rec.outcome = "ok" if rows else "empty"
            except P.SchemaDrift as e:
                rows, rec.outcome, rec.error_class, rec.error_text = [], "schema_drift", "SchemaDrift", str(e)
            except ApiError as e:
                rows = []
                rec.error_class, rec.error_text = "ApiError", f"{e.kind} {e.status}"
                rec.outcome = {"auth": "auth_failed", "rate_limited": "rate_limited"}.get(e.kind, "error")
                self.counters["errors"] += 1
                failed.append(e.kind)
                stop = self._after_failure(e, manual) or stop
            new = changed = 0
            if rows:
                new, changed = self.store.upsert_observations(rows, self.now())
                rec.outcome = "ok" if (new or changed) else "unchanged"
            rec.rows_seen, rec.rows_new = len(rows), new
            rec.latest_measured_at = max((o.measured_at for o in rows), default=None)
            rec.finished_at = self.now()
            rec.duration_ms = int((rec.finished_at - started).total_seconds() * 1000)
            self.store.record_run(rec)
            self.counters["rows_new"] += new
            requests += rec.requests
            rows_new += new
            if call.every_min is not None and rec.outcome not in ("error", "rate_limited", "auth_failed"):
                self.last_run[call.path.split("?")[0] + str(call.day)] = now
            ran.append(call.name)
            for g in call.groups:
                agg = outcomes.setdefault(g, {"ok": False, "new": False, "latest": None, "outcome": rec.outcome})
                good = rec.outcome in ("ok", "unchanged")
                agg["ok"] = agg["ok"] or good
                agg["new"] = agg["new"] or new > 0
                agg["outcome"] = rec.outcome if (not agg["ok"] or good) else agg["outcome"]
                if rec.latest_measured_at and (agg["latest"] is None or rec.latest_measured_at > agg["latest"]):
                    agg["latest"] = rec.latest_measured_at
            if stop:
                break
        for g, agg in outcomes.items():
            self._state(g, now, agg)
        if not stop and outcomes and all(a["outcome"] not in ("error", "rate_limited", "auth_failed") for a in outcomes.values()):
            self.fail_streak = 0
            self.backoff_until = None
        return {"ran": ran, "requests": requests, "rows_new": rows_new, "failed": failed, "backoff_until": self.backoff_until if self.backoff_until and self.backoff_until > self.now() else None}

    def refresh(self) -> dict:
        """What the app's refresh button runs: a full fetch right now. Returns {ok, outcome, requests, rows_new, ...}; never raises for a Garmin problem."""
        reason = self.paused_reason(manual=True)
        if reason:
            return {"ok": False, "outcome": "paused", "message": reason, "requests": 0, "rows_new": 0}
        res = self.run_cycle(manual=True)
        failed = res["failed"]
        until = res.get("backoff_until")
        if "auth" in failed:
            outcome = "auth_failed"
        elif until or "rate_limited" in failed:
            outcome = "rate_limited"
        elif failed and len(failed) >= len(res["ran"]):
            outcome = "unavailable"
        elif failed:
            outcome = "partial"
        else:
            outcome = "ok"
        return {"ok": outcome in ("ok", "partial"), "outcome": outcome, "requests": res["requests"], "rows_new": res["rows_new"], "retry_at": until}

    def _after_failure(self, e: ApiError, manual: bool = False) -> bool:
        """Returns True when the cycle must stop."""
        if e.kind == "auth":
            self._set_flag(AUTH_FAILED_FILE, str(e))
            return True
        if manual:
            if e.kind == "rate_limited":
                self.counters["rate_limits"] += 1
                self.backoff_until = self.now() + timedelta(seconds=min(BACKOFF_CAP_S, max(60, e.retry_after or 0)))
                return True
            return e.kind == "transient"  # stop on a Garmin outage, but no backoff: pressing refresh again just tries again
        self.fail_streak += 1
        if e.kind == "rate_limited":
            self.counters["rate_limits"] += 1
            wait = max(e.retry_after or 0, min(BACKOFF_CAP_S, 300 * 2 ** (self.fail_streak - 1)))
        elif e.kind == "transient":
            wait = min(BACKOFF_CAP_S, self.s.poll_min * 60 * 2 ** (self.fail_streak - 1))
        else:  # client error: one path is wrong, the others may still work
            return False
        self.backoff_until = self.now() + timedelta(seconds=wait)
        return True

    def _state(self, group: str, now: datetime, agg: dict) -> None:
        st = self.store.get_state(group)
        failed = agg["outcome"] in ("error", "rate_limited", "auth_failed", "schema_drift")
        fields: dict = {"last_attempt_at": now, "last_outcome": agg["outcome"], "consecutive_failures": (st.consecutive_failures + 1) if failed else 0}
        if agg["ok"]:
            fields["last_success_at"] = self.now()
        if agg["new"]:
            fields["last_new_data_at"] = self.now()
        if agg["latest"] is not None:
            fields["last_measured_at"] = agg["latest"]
        self.store.put_state(group, **fields)

    # ------------------------------------------------------------------ heartbeat + loop
    def heartbeat(self, reason: str | None, note: str = "") -> None:
        extra = {
            "paused_reason": reason,
            "note": note,
            "counters": dict(self.counters),
            "gate": {
                "consecutive_failures": self.fail_streak,
                "backoff_level": self.fail_streak,
                "backoff_until": self.backoff_until.isoformat(timespec="seconds") if self.backoff_until and self.backoff_until > self.now() else None,
                "breaker_open_until": None,
            },
            "intervals": {"fast_min": self.s.poll_min, "stress_min": SLOW_EVERY_MIN},
        }
        self.store.put_state(WORKER_ROW, last_attempt_at=self.now(), extra=extra)

    def stop(self) -> None:
        self.stopped = True

    def _nap(self, seconds: float) -> None:
        end = time.monotonic() + seconds
        while not self.stopped and time.monotonic() < end:
            self.sleep(min(5.0, max(0.0, end - time.monotonic())))

    def run_forever(self) -> None:
        self._nap(5 + self.rand() * 25)  # startup jitter: a restart is never an instant burst
        while not self.stopped:
            reason = self.paused_reason()
            self.heartbeat(reason)
            if reason:
                self._nap(60)
                continue
            try:
                res = self.run_cycle()
            except Exception as e:  # noqa: BLE001 - the loop must not die into a restart storm
                res = {"note": f"cycle error: {type(e).__name__}"}
                self.counters["errors"] += 1
            self.heartbeat(None, res.get("note", ""))
            self._maybe_prune()
            wait = self.poll_wait()
            self._nap(wait)

    def poll_wait(self) -> float:
        if self.backoff_until:
            left = (self.backoff_until - self.now()).total_seconds()
            if left > 0:
                return min(300.0, left + 5)
        return self.s.poll_min * 60 + self.rand() * 30

    def _maybe_prune(self) -> None:
        now = self.now()
        if self._last_prune is None or now - self._last_prune > timedelta(hours=24):
            try:
                self.store.prune_runs(now - timedelta(days=RUN_RETENTION_DAYS))
            finally:
                self._last_prune = now
