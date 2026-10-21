"""Deterministic, typed feature functions. Pure: data in, numbers out. The LLM never computes anything."""
from __future__ import annotations

import statistics
from dataclasses import dataclass
from datetime import datetime, timedelta, date, time
from typing import Optional
from zoneinfo import ZoneInfo

from .config import Thresholds
from .models import Reading


@dataclass(frozen=True)
class Stats:
    n: int
    mean: float
    minimum: float
    maximum: float
    sd: float
    cv_pct: float


@dataclass(frozen=True)
class Range:
    minutes_in: float
    minutes_below: float
    minutes_above: float
    covered_minutes: float

    @property
    def pct_in(self) -> float: return _pct(self.minutes_in, self.covered_minutes)
    @property
    def pct_below(self) -> float: return _pct(self.minutes_below, self.covered_minutes)
    @property
    def pct_above(self) -> float: return _pct(self.minutes_above, self.covered_minutes)


@dataclass(frozen=True)
class Excursion:
    kind: str                # above | below
    start: datetime
    end: datetime
    minutes: float
    extreme_mgdl: float
    extreme_at: datetime


def _pct(a: float, b: float) -> float:
    return 0.0 if b <= 0 else 100.0 * a / b


def stats(readings: list[Reading]) -> Optional[Stats]:
    vals = [r.mgdl for r in readings]
    if len(vals) < 2:
        return None
    m = statistics.fmean(vals)
    sd = statistics.pstdev(vals)
    return Stats(len(vals), m, min(vals), max(vals), sd, 0.0 if m == 0 else 100.0 * sd / m)


def time_in_range(readings: list[Reading], start: datetime, end: datetime, th: Thresholds) -> Range:
    """Time-weighted: each reading holds for min(gap to next, max_gap) minutes, clipped to the window. Uncovered time is not counted."""
    inn = below = above = 0.0
    rs = [r for r in readings if start <= r.t <= end]
    for i, r in enumerate(rs):
        nxt = rs[i + 1].t if i + 1 < len(rs) else end
        mins = min((nxt - r.t).total_seconds() / 60, th.max_gap_min)
        if mins <= 0:
            continue
        if r.mgdl < th.low_mgdl: below += mins
        elif r.mgdl > th.high_mgdl: above += mins
        else: inn += mins
    return Range(inn, below, above, inn + below + above)


def nearest(readings: list[Reading], t: datetime, tol_min: float) -> Optional[Reading]:
    best, bd = None, None
    for r in readings:
        d = abs((r.t - t).total_seconds()) / 60
        if d <= tol_min and (bd is None or d < bd):
            best, bd = r, d
    return best


def change_between(readings: list[Reading], t0: datetime, t1: datetime, tol_min: float = 10) -> Optional[float]:
    a, b = nearest(readings, t0, tol_min), nearest(readings, t1, tol_min)
    return None if a is None or b is None else b.mgdl - a.mgdl


def excursions(readings: list[Reading], start: datetime, end: datetime, th: Thresholds) -> list[Excursion]:
    """Contiguous stays outside the reporting range lasting at least excursion_min_minutes. Gaps larger than max_gap end a stay."""
    out: list[Excursion] = []
    rs = [r for r in readings if start <= r.t <= end]
    cur: list[Reading] = []
    kind = None

    def close() -> None:
        nonlocal cur, kind
        if cur and kind:
            mins = (cur[-1].t - cur[0].t).total_seconds() / 60
            if mins >= th.excursion_min_minutes:
                ext = max(cur, key=lambda r: r.mgdl) if kind == "above" else min(cur, key=lambda r: r.mgdl)
                out.append(Excursion(kind, cur[0].t, cur[-1].t, mins, ext.mgdl, ext.t))
        cur, kind = [], None

    for i, r in enumerate(rs):
        k = "above" if r.mgdl > th.high_mgdl else "below" if r.mgdl < th.low_mgdl else None
        if i > 0 and (r.t - rs[i - 1].t).total_seconds() / 60 > th.max_gap_min:
            close()
        if k is None:
            close()
        elif k != kind:
            close()
            kind, cur = k, [r]
        else:
            cur.append(r)
    close()
    return out


def hhmm(s: str) -> time:
    h, m = s.split(":")
    return time(int(h), int(m))


def local(dt: datetime, tz: ZoneInfo) -> datetime:
    return dt.astimezone(tz)


def local_dt(d: date, t: time, tz: ZoneInfo) -> datetime:
    """Local wall time -> aware UTC. Ambiguous/nonexistent DST times resolve with zoneinfo's fold=0 rule (documented, deterministic)."""
    return datetime.combine(d, t, tzinfo=tz).astimezone(ZoneInfo("UTC"))


def day_bounds(d: date, tz: ZoneInfo) -> tuple[datetime, datetime]:
    return local_dt(d, time(0, 0), tz), local_dt(d + timedelta(days=1), time(0, 0), tz)


def overnight_window(d: date, th: Thresholds, tz: ZoneInfo) -> tuple[datetime, datetime]:
    """The night ending on local date d: previous day overnight_start -> d wake."""
    return local_dt(d - timedelta(days=1), hhmm(th.overnight_start), tz), local_dt(d, hhmm(th.wake), tz)


def rise_between(readings: list[Reading], trough_start: datetime, trough_end: datetime, peak_start: datetime, peak_end: datetime) -> Optional[tuple[float, Reading, Reading]]:
    """Rise from the lowest reading in the trough window to the highest in the peak window (if the peak is later). None if either window has no data."""
    tr = [r for r in readings if trough_start <= r.t <= trough_end]
    pk = [r for r in readings if peak_start <= r.t <= peak_end]
    if not tr or not pk:
        return None
    lo = min(tr, key=lambda r: r.mgdl)
    hi = max(pk, key=lambda r: r.mgdl)
    if hi.t <= lo.t:
        return None
    return hi.mgdl - lo.mgdl, lo, hi
