"""When is a job due? Pure functions of (job, persisted state, now): no clock reads, no I/O, so restarts cannot cause bursts and tests are exact.

  Every(n):  due n minutes after the last ATTEMPT (not the last success), so a failing job cannot hot-loop. After failures the wait doubles
             per consecutive failure (n, 2n, 4n ... capped at 60 minutes). A small jitter is added so jobs do not all line up.
  Slots:     local wall-clock times. The latest slot that has passed is "open" until a non-empty answer arrives after it; while it is open the
             job retries every `retry_min` minutes, at most `max_attempts` times per slot. A restart never re-runs a slot that already succeeded.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from .catalog import Every, Job, Slots

BACKOFF_CAP_S = 3600
OK_OUTCOMES = {"ok", "unchanged"}  # a non-empty answer; 'empty' is an attempt but not a success


@dataclass(frozen=True)
class JobState:
    last_attempt_at: datetime | None = None
    last_success_at: datetime | None = None
    last_outcome: str | None = None
    consecutive_failures: int = 0
    slot_key: str | None = None
    slot_attempts: int = 0


@dataclass(frozen=True)
class Due:
    due: bool
    next_at: datetime | None
    reason: str
    slot_key: str | None = None


def slot_datetimes(day: date, times, tz: ZoneInfo) -> list[datetime]:
    return [datetime.combine(day, t, tzinfo=tz).astimezone(timezone.utc) for t in times]


def is_due(job: Job, st: JobState, now: datetime, tz: ZoneInfo, jitter_s: float = 0.0) -> Due:
    sch = job.schedule
    if isinstance(sch, Every):
        if st.last_attempt_at is None:
            return Due(True, None, "never run")
        gap = sch.minutes * 60
        if st.consecutive_failures > 0:
            gap = min(max(gap, gap * (2 ** min(st.consecutive_failures, 10))), max(BACKOFF_CAP_S, gap))
        nxt = st.last_attempt_at + timedelta(seconds=gap + jitter_s)
        return Due(now >= nxt, nxt, "interval" if now >= nxt else "waiting")
    assert isinstance(sch, Slots)
    local_day = now.astimezone(tz).date()
    today = slot_datetimes(local_day, sch.times, tz)
    passed = [s for s in today if s <= now]
    if not passed:
        return Due(False, today[0], "before first slot")
    slot = passed[-1]
    key = slot.isoformat()
    later = [s for s in today if s > now]
    next_slot = later[0] if later else slot_datetimes(local_day + timedelta(days=1), sch.times, tz)[0]
    if st.last_success_at is not None and st.last_success_at >= slot:
        return Due(False, next_slot, "slot satisfied", key)
    attempts = st.slot_attempts if st.slot_key == key else 0
    if attempts >= sch.max_attempts:
        return Due(False, next_slot, "slot attempts used up", key)
    if attempts == 0 or st.last_attempt_at is None:
        return Due(True, None, "slot open", key)
    nxt = st.last_attempt_at + timedelta(seconds=sch.retry_min * 60 + jitter_s)
    return Due(now >= nxt, nxt, "slot retry" if now >= nxt else "waiting", key)


def next_wakeup(candidates: list[datetime | None], now: datetime, floor_s: float = 30.0, cap_s: float = 300.0) -> float:
    """Seconds to sleep until the earliest known due time (never less than floor_s, never more than cap_s so pause flags are noticed)."""
    known = [c for c in candidates if c is not None]
    if not known:
        return cap_s
    return max(floor_s, min(cap_s, (min(known) - now).total_seconds()))
