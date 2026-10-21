"""Quality and availability assessment. Missing stays missing; unreliable readings are excluded from dependent analyses, flagged, never repaired."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Iterable

from .config import Thresholds
from .models import Reading, Snapshot


@dataclass(frozen=True)
class Flag:
    code: str        # conflicting_duplicates | implausible_value | implausible_spike | future_timestamp | rapid_change
    detail: str
    t: datetime | None = None


@dataclass(frozen=True)
class Availability:
    ok: bool
    reasons: tuple[str, ...] = ()
    coverage: float | None = None


def clean_readings(readings: Iterable[Reading], now: datetime, th: Thresholds) -> tuple[list[Reading], list[Flag]]:
    """Sort, de-duplicate and drop what cannot be trusted. Returns (usable readings, flags)."""
    flags: list[Flag] = []
    by_t: dict[datetime, list[Reading]] = {}
    for r in readings:
        by_t.setdefault(r.t, []).append(r)
    kept: list[Reading] = []
    for t in sorted(by_t):
        group = by_t[t]
        values = {round(g.mgdl, 1) for g in group}
        if t > now + timedelta(minutes=th.future_tolerance_min):
            flags.append(Flag("future_timestamp", "reading dated in the future was excluded", t))
            continue
        if len(values) > 1:  # two different values at the same instant: we cannot know which is real, so neither is used
            flags.append(Flag("conflicting_duplicates", f"{len(values)} different values at the same timestamp were excluded", t))
            continue
        r = group[0]
        if not (th.plausible_min_mgdl <= r.mgdl <= th.plausible_max_mgdl):
            flags.append(Flag("implausible_value", "value outside the plausible range was excluded", t))
            continue
        kept.append(r)
    # isolated spike that reverts: a sensor artefact (faster than physiology in BOTH directions)
    out: list[Reading] = []
    for i, r in enumerate(kept):
        if 0 < i < len(kept) - 1:
            a, b = kept[i - 1], kept[i + 1]
            d1 = (r.t - a.t).total_seconds() / 60
            d2 = (b.t - r.t).total_seconds() / 60
            if 0 < d1 <= th.max_gap_min and 0 < d2 <= th.max_gap_min:
                up = (r.mgdl - a.mgdl) / d1
                down = (b.mgdl - r.mgdl) / d2
                if abs(up) > th.max_rate_mgdl_per_min and abs(down) > th.max_rate_mgdl_per_min and up * down < 0:
                    flags.append(Flag("implausible_spike", "isolated spike that reverts immediately was excluded", r.t))
                    continue
        out.append(r)
    for a, b in zip(out, out[1:]):
        d = (b.t - a.t).total_seconds() / 60
        if 0 < d <= th.max_gap_min and abs(b.mgdl - a.mgdl) / d > th.max_rate_mgdl_per_min:
            flags.append(Flag("rapid_change", "sustained change faster than the plausible rate was kept but flagged", b.t))
    return out, flags


def coverage(readings: list[Reading], start: datetime, end: datetime, th: Thresholds) -> float:
    """Fraction of [start, end] vouched for by a reading (each reading covers +-max_gap/2). 0 if the window is empty."""
    total = (end - start).total_seconds()
    if total <= 0:
        return 0.0
    half = timedelta(minutes=th.max_gap_min / 2)
    covered = 0.0
    cur_s: datetime | None = None
    cur_e: datetime | None = None
    for r in readings:
        s, e = max(r.t - half, start), min(r.t + half, end)
        if e <= s:
            continue
        if cur_e is None or s > cur_e:
            if cur_s is not None and cur_e is not None:
                covered += (cur_e - cur_s).total_seconds()
            cur_s, cur_e = s, e
        else:
            cur_e = max(cur_e, e)
    if cur_s is not None and cur_e is not None:
        covered += (cur_e - cur_s).total_seconds()
    return min(1.0, covered / total)


def freshness(readings: list[Reading], now: datetime, th: Thresholds) -> tuple[str, float | None]:
    """('current'|'stale'|'none', age_minutes). A stale reading is the latest RECORDED value, not a current measurement."""
    if not readings:
        return "none", None
    age = (now - readings[-1].t).total_seconds() / 60
    return ("current" if age <= th.stale_minutes else "stale"), age


def in_window(readings: list[Reading], start: datetime, end: datetime) -> list[Reading]:
    return [r for r in readings if start <= r.t <= end]


def assess(snap: Snapshot, clean: list[Reading], flags: list[Flag]) -> dict[str, Availability]:
    """Availability per insight category. One missing source never suppresses an unrelated category."""
    th = snap.settings.th
    av: dict[str, Availability] = {}
    fresh, age = freshness(clean, snap.now, th)
    av["glucose"] = Availability(bool(clean), () if clean else ("no usable glucose readings",))
    av["glucose_current"] = Availability(fresh == "current", () if fresh == "current" else (
        "no glucose readings" if fresh == "none" else f"latest reading is {age:.0f} min old (stale)",))
    n_days = len({r.t.astimezone(_tz(snap)).date() for r in clean})
    av["history"] = Availability(n_days >= th.min_days_recurring, () if n_days >= th.min_days_recurring else (
        f"only {n_days} day(s) of glucose history; at least {th.min_days_recurring} needed for recurring-pattern claims",))
    meals = [m for m in snap.meals if m.status in ("confirmed", "manual_entry") and m.carbs_g is not None]
    av["meals"] = Availability(bool(meals), () if meals else ("no confirmed meal records with carbs",))
    ins = [i for i in snap.insulin if i.units is not None]
    av["insulin"] = Availability(bool(ins), () if ins else ("no insulin records with an administered dose",))
    av["activity"] = Availability(bool(snap.activities), () if snap.activities else ("no activity records",))
    av["sleep"] = Availability(bool(snap.sleeps), () if snap.sleeps else ("no sleep records",))
    names = sorted({w.name for w in snap.wearables})
    av["wearable"] = Availability(bool(snap.wearables), () if snap.wearables else ("no wearable metrics",))
    fc = [f for f in snap.forecast if (snap.now - f.anchor).total_seconds() / 60 <= th.forecast_max_age_min]
    av["forecast"] = Availability(bool(fc), () if fc else ("no current forecast",))
    av["data_quality_flags"] = Availability(not flags, tuple(sorted({f.code for f in flags})))
    return av


def _tz(snap: Snapshot):
    from zoneinfo import ZoneInfo
    try:
        return ZoneInfo(snap.settings.timezone)
    except Exception:  # unknown tz name: fall back to UTC rather than guess a local time
        return ZoneInfo("UTC")
