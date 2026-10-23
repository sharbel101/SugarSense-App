"""Research-informed pattern detectors (the patterns clinicians read in an ambulatory glucose profile / CGM report, computed per person).

Each detector is a pure function of the Snapshot and returns candidates only when its evidence requirements are met; insufficient evidence returns nothing.
Every number shown is computed here; the language model only rewords the Python sentences and the validator checks it against them.
Observations and associations are never worded as causes. Missing records are missing information: no detector concludes that food or insulin was not taken.

Families: time-of-day highs, hypoglycaemia pattern, overnight / dawn patterns, variability change, change from baseline, post-meal response across comparable meals,
glucose after recorded insulin, completeness of the insulin record. (Exercise/sleep/wearable associations live in awareness.py / the activity layer.)
All thresholds are in the CONFIG block below with their reason.
"""
from __future__ import annotations

import bisect
import statistics
from datetime import date, datetime, time, timedelta
from typing import Optional
from zoneinfo import ZoneInfo

from . import evidence as EV
from . import features as F
from . import menus as M
from .models import Candidate, Meal, Reading, Snapshot
from .patterns import ASSOC, NOT_ADVICE, _B, _r, _tz
from .quality import coverage, in_window

# ----------------------------------------------------------------------------- CONFIG (reason beside each value)
LOOKBACK_DAYS = 28            # two equal 14-day periods are needed for the variability comparison
MIN_WINDOW_COV = 0.70         # a 3-hour window or a night only counts as eligible if readings vouch for 70% of it
TW_HOURS = 3                  # time-of-day windows are 3 hours long (same as the existing block pattern; long enough for a meal-and-correction cycle)
TW_MIN_ABOVE_MIN = 30         # a day is "affected" if glucose was above range for at least 30 minutes inside the window (one stray reading is not a pattern)
TW_MIN_HITS, TW_MIN_ELIGIBLE, TW_MIN_FRACTION = 3, 5, 0.6
TW_OVER_BASE = 0.20           # the window must exceed the person's own all-day hit rate by 20 points, otherwise "always high" is not a time-of-day pattern
LOW_MIN_EVENTS = 2            # two separate lows in 14 days already deserve a card (lows are rare and clinically heavier than highs)
LOW_GAP_MIN = 30              # readings below range less than 30 minutes apart are one low
LOW_ACT_HOURS, LOW_INS_HOURS = 12, 5   # exercise within 12 h before a low (delayed effect) / rapid insulin within 5 h (action time)
NIGHT = (0, 6)                # overnight = local 00:00-06:00
DAWN_TROUGH = (3, 6)          # the trough is looked for between 03:00 and 06:00 ...
DAWN_PEAK_END = 8             # ... and the peak up to 08:00
DAWN_RISE = 40.0              # mg/dL, about a quarter of the 70-180 range (same as the morning-rise rule elsewhere)
NIGHT_MIN_NIGHTS = 5
VAR_MIN_DAYS = 5              # covered days needed in EACH of the two comparison periods
VAR_CV_POINTS = 5.0           # a change of 5 percentage points in the coefficient of variation (consensus: <= 36% is stable)
VAR_TIR_POINTS = 10.0         # or 10 points of time in range
SHIFT_MGDL = 25.0             # recent 7-day mean of a block vs the preceding 14 days
SHIFT_MIN_RECENT, SHIFT_MIN_PRIOR = 4, 7
MEAL_MIN_CARBS = 15.0         # smaller snacks are not "comparable meals"
MEAL_WINDOW_MIN, MEAL_RISE_WITHIN_MIN = 180, 90
MEAL_MIN_N = 5
DOSE_MIN_OCCASIONS = 3
DOSE_FALL_MGDL = 40.0
GAP_MIN_MEALS = 3

TW_NOTE = "The window was picked as the most consistent of several 3-hour windows, so it is an observation about this person's own recent days, not a tested hypothesis."
MISSING = "A missing record is missing information; it does not show that nothing was eaten or no insulin was taken."


# ----------------------------------------------------------------------------- helpers

class _Ix:
    """Readings sorted by time with a bisect window lookup, so each 3-hour / day / meal window costs O(log n + window) instead of a scan of the whole history."""

    def __init__(self, rs: list[Reading]) -> None:
        self.rs, self.t = rs, [r.t for r in rs]

    def win(self, s: datetime, e: datetime, pad: timedelta = timedelta(minutes=30)) -> list[Reading]:
        return self.rs[bisect.bisect_left(self.t, s - pad): bisect.bisect_right(self.t, e + pad)]


_CACHE: dict = {"key": None, "ix": None}


def _ix(clean: list[Reading]) -> _Ix:
    k = (id(clean), len(clean))
    if _CACHE["key"] != k:
        _CACHE.update(key=k, ix=_Ix(clean))
    return _CACHE["ix"]


def _cov(clean, s, e, th):
    return coverage(_ix(clean).win(s, e), s, e, th)


def _inw(clean, s, e):
    return in_window(_ix(clean).win(s, e), s, e)


def _tir(clean, s, e, th):
    return F.time_in_range(_ix(clean).win(s, e), s, e, th)


def _near(clean, t, tol):
    return F.nearest(_ix(clean).win(t, t, timedelta(minutes=tol + 1)), t, tol)

def _fmt_win(sh: int, hours: int = TW_HOURS) -> str:
    return f"{sh:02d}:00-{(sh + hours) % 24:02d}:00"


def _quart(xs: list[float]) -> tuple[float, float]:
    if len(xs) < 4:
        return min(xs), max(xs)
    q = statistics.quantiles(xs, n=4)
    return q[0], q[2]


def _window_stat(snap: Snapshot, clean: list[Reading], dd: date, sh: int, eh: int, tz: ZoneInfo):
    th = snap.settings.th
    s, e = F.local_dt(dd, time(sh), tz), F.local_dt(dd, time(eh % 24), tz)
    if eh >= 24:
        e = F.local_dt(dd + timedelta(days=1), time(0), tz)
    if e > snap.now or _cov(clean, s, e, th) < MIN_WINDOW_COV:
        return None
    return s, e, _inw(clean, s, e)


def _meal_ok(m: Meal) -> bool:
    return m.status in ("confirmed", "manual_entry") and m.carbs_g is not None


def _rapid(snap: Snapshot):
    return [i for i in snap.insulin if i.kind in ("bolus", "correction") and i.units is not None and i.units > 0]


def _span(days: list[date]) -> int:
    return (max(days) - min(days)).days + 1 if days else 0


# ----------------------------------------------------------------------------- A. recurring time-of-day highs
def time_window_high(snap: Snapshot, clean: list[Reading], d: date) -> Optional[Candidate]:
    th, tz = snap.settings.th, _tz(snap)
    per_window: dict[int, list[tuple[date, bool, float, list[Reading]]]] = {}
    for sh in range(0, 24 - TW_HOURS + 1):
        rows = []
        for back in range(0, LOOKBACK_DAYS + 1):
            dd = d - timedelta(days=back)
            w = _window_stat(snap, clean, dd, sh, sh + TW_HOURS, tz)
            if w is None:
                continue
            s, e, rs = w
            mins = _tir(clean, s, e, th).minutes_above
            rows.append((dd, mins >= TW_MIN_ABOVE_MIN, mins, rs))
        rows.sort(key=lambda r: r[0])
        per_window[sh] = rows
    all_hits = [h for rows in per_window.values() for _, h, _, _ in rows]
    if not all_hits:
        return None
    base = sum(all_hits) / len(all_hits)
    best = None
    for sh, rows in per_window.items():
        level, reason = EV.grade_recurrence([h for _, h, _, _ in rows], TW_MIN_HITS, TW_MIN_ELIGIBLE, TW_MIN_FRACTION)
        if level is None:
            continue
        k, n = sum(1 for _, h, _, _ in rows if h), len(rows)
        if k / n - base < TW_OVER_BASE:
            continue
        key = (k, sum(r[2] for r in rows if r[1]), -sh)   # most affected days, then the window holding the most time above range (the window that contains the high, not one that only touches it)
        if best is None or key > best[0]:
            best = (key, sh, rows, level, reason, k, n)
    if best is None:
        return None
    _, sh, rows, level, reason, k, n = best
    aff = [r for r in rows if r[1]]
    vals = [x.mgdl for r in aff for x in r[3]]
    q1, q3 = _quart(vals)
    med_min = statistics.median(r[2] for r in aff)
    peak = statistics.median(max(x.mgdl for x in r[3]) for r in aff)
    b = _B()
    e_k, e_n, e_thr = b.add("days_above_in_window", k, "count"), b.add("eligible_days", n, "count"), b.add("high_threshold", _r(th.high_mgdl), "mg/dL", "context")
    e_w = b.add("window", _fmt_win(sh), "", "context")
    e_lo, e_hi, e_m, e_pk = b.add("typical_low", _r(q1), "mg/dL"), b.add("typical_high", _r(q3), "mg/dL"), b.add("median_minutes_above", _r(med_min), "min"), b.add("median_peak", _r(peak), "mg/dL")
    claims = [
        f"Glucose was above {_r(th.high_mgdl)} mg/dL [{e_thr}] for at least {TW_MIN_ABOVE_MIN} minutes [{b.add('min_minutes_above', TW_MIN_ABOVE_MIN, 'min', 'context')}] between {_fmt_win(sh)} [{e_w}] on {k} [{e_k}] of {n} [{e_n}] days that had enough readings.",
        f"On those days glucose in that window typically ran between {_r(q1)} and {_r(q3)} mg/dL [{e_lo}, {e_hi}], with a median of {_r(med_min)} minutes [{e_m}] above range and a median peak of {_r(peak)} mg/dL [{e_pk}].",
    ]
    return Candidate(
        key=f"time_window_high:{sh:02d}", category="time_window_high", trigger="evening", window=(F.local_dt(rows[0][0], time(sh), tz), snap.now),
        facts=b.facts, claims=claims, boundaries=[NOT_ADVICE, ASSOC, "Possibilities only. Never state a cause as fact, a dose, units, or an exact timing."],
        limitations=[TW_NOTE, "Days without enough readings in the window are not counted either way."], coverage=1.0,
        method=f"days with at least {TW_MIN_ABOVE_MIN} min above range per 3-hour window, over the last {LOOKBACK_DAYS} days; {reason}",
        scores={"safety": 0.4, "evidence": 0.9 if level == EV.VALIDATED else 0.65, "recurrence": k / n, "relevance": 0.9, "actionability": 0.5},
        suggestions=[M.LOG_CONTEXT], evidence_level=level, pattern_id=f"time_window_high:{sh:02d}",
        criteria=f">= {TW_MIN_HITS} affected days of >= {TW_MIN_ELIGIBLE} eligible, >= {int(TW_MIN_FRACTION * 100)}% and {int(TW_OVER_BASE * 100)} points above the person's own all-day rate; validated if both halves of the period show it",
        detail={"days": [{"date": r[0].isoformat(), "affected": r[1], "minutes_above": _r(r[2]), "peak_mgdl": _r(max(x.mgdl for x in r[3]))} for r in rows], "window": _fmt_win(sh), "baseline_hit_rate_pct": _r(base * 100)},
    )


# ----------------------------------------------------------------------------- D. hypoglycaemia pattern
def hypo_pattern(snap: Snapshot, clean: list[Reading], d: date) -> Optional[Candidate]:
    th, tz = snap.settings.th, _tz(snap)
    start = snap.now - timedelta(days=14)
    first = max(start, clean[0].t) if clean else start        # coverage is judged over the period the data actually spans, not the days before the first reading
    if _cov(clean, first, snap.now, th) < 0.5:
        return None
    lows: list[list[Reading]] = []
    for r in clean:
        if r.t < start or r.mgdl >= th.low_mgdl:
            continue
        if lows and (r.t - lows[-1][-1].t).total_seconds() / 60 <= LOW_GAP_MIN:
            lows[-1].append(r)
        else:
            lows.append([r])
    if len(lows) < LOW_MIN_EVENTS:
        return None
    days = {ev[0].t.astimezone(tz).date() for ev in lows}
    low_vals = [min(x.mgdl for x in ev) for ev in lows]
    durs = [(ev[-1].t - ev[0].t).total_seconds() / 60 for ev in lows]
    hours = [ev[0].t.astimezone(tz).hour for ev in lows]
    best_h, best_k = 0, 0
    for h0 in range(24):
        k = sum(1 for h in hours if (h - h0) % 24 < TW_HOURS)
        if k > best_k:
            best_h, best_k = h0, k
    clustered = best_k >= 2 and best_k / len(lows) >= 0.5
    acts = snap.activities
    ins = _rapid(snap)
    after_act = sum(1 for ev in lows if any(timedelta(0) <= ev[0].t - a.start <= timedelta(hours=LOW_ACT_HOURS) for a in acts)) if acts else None
    after_ins = sum(1 for ev in lows if any(timedelta(0) <= ev[0].t - i.t <= timedelta(hours=LOW_INS_HOURS) for i in ins)) if ins else None
    last7 = sum(1 for ev in lows if ev[0].t >= snap.now - timedelta(days=7))
    b = _B()
    e_n, e_d, e_lo, e_thr = b.add("lows_count", len(lows), "count"), b.add("low_days", len(days), "count"), b.add("lowest", _r(min(low_vals)), "mg/dL"), b.add("low_threshold", _r(th.low_mgdl), "mg/dL", "context")
    e_7 = b.add("lows_last_7_days", last7, "count")
    claims = [f"There were {len(lows)} [{e_n}] separate lows below {_r(th.low_mgdl)} mg/dL [{e_thr}] in the last two weeks on {len(days)} [{e_d}] different days, {last7} [{e_7}] of them in the last week; the lowest reading was {_r(min(low_vals))} mg/dL [{e_lo}]."]
    if max(durs) >= 15:
        claims.append(f"The longest stayed below range for about {_r(max(durs))} minutes [{b.add('longest_low', _r(max(durs)), 'min')}].")
    if clustered:
        claims.append(f"{best_k} [{b.add('lows_in_window', best_k, 'count')}] of them began between {_fmt_win(best_h)} [{b.add('window', _fmt_win(best_h), '', 'context')}].")
    lim = [MISSING]
    if after_act is not None:
        claims.append(f"{after_act} [{b.add('lows_after_exercise_record', after_act, 'count')}] followed a recorded activity within {LOW_ACT_HOURS} hours [{b.add('exercise_hours', LOW_ACT_HOURS, 'h', 'context')}].")
    else:
        lim.append("No activity records exist, so no link to exercise is described.")
    if after_ins is not None:
        claims.append(f"{after_ins} [{b.add('lows_after_insulin_record', after_ins, 'count')}] followed a recorded rapid-acting dose within {LOW_INS_HOURS} hours [{b.add('insulin_hours', LOW_INS_HOURS, 'h', 'context')}].")
    else:
        lim.append("No insulin doses are recorded in this period, so no link to insulin is described.")
    lim.append("The available data cannot establish the cause of a low.")
    level = EV.REPEATED if len(lows) >= 3 and len(days) >= 2 else EV.DESCRIPTIVE
    explanations, suggestions = (M.FREQUENT_LOWS if len(lows) >= 3 else ([], [M.DISCUSS_FREQUENT_LOWS]))
    return Candidate(
        key="hypo_pattern", category="hypo_pattern", trigger="evening", window=(start, snap.now), facts=b.facts, claims=claims,
        boundaries=[NOT_ADVICE, ASSOC, "Lows are reported as past episodes only. This card is not an alert; real-time lows are handled by the alert system."], limitations=lim, coverage=1.0,
        method="separate stays below the low threshold (readings within 30 minutes are one low) over the last 14 days", explanations=list(explanations), suggestions=list(suggestions),
        scores={"safety": 1.0, "evidence": 0.7 if level == EV.REPEATED else 0.5, "recurrence": min(1.0, len(lows) / 5), "relevance": 1.0, "actionability": 0.7},
        evidence_level=level, pattern_id="hypo_pattern", criteria="descriptive for 2 lows; repeated for >= 3 lows on >= 2 days",
        detail={"events": [{"at": ev[0].t.astimezone(tz).strftime("%Y-%m-%d %H:%M"), "lowest_mgdl": _r(min(x.mgdl for x in ev)), "minutes": _r((ev[-1].t - ev[0].t).total_seconds() / 60)} for ev in lows]},
    )


# ----------------------------------------------------------------------------- C. overnight / early-morning patterns
def overnight_patterns(snap: Snapshot, clean: list[Reading], d: date) -> list[Candidate]:
    th, tz = snap.settings.th, _tz(snap)
    out: list[Candidate] = []
    nights, dawns = [], []
    for back in range(0, LOOKBACK_DAYS + 1):
        dd = d - timedelta(days=back)
        w = _window_stat(snap, clean, dd, NIGHT[0], NIGHT[1], tz)
        if w is not None:
            s, e, rs = w
            rng = _tir(clean, s, e, th)
            nights.append((dd, min(r.mgdl for r in rs) < th.low_mgdl, rng.minutes_above >= 60, min(r.mgdl for r in rs), max(r.mgdl for r in rs)))
        # dawn: 03:00-08:00 readings, no logged meal at or before the peak
        w2 = _window_stat(snap, clean, dd, DAWN_TROUGH[0], DAWN_PEAK_END, tz)
        if w2 is not None:
            s2, e2, rs2 = w2
            tr = [r for r in rs2 if r.t <= F.local_dt(dd, time(DAWN_TROUGH[1]), tz)]
            if not tr:
                continue
            lo = min(tr, key=lambda r: r.mgdl)
            after = [r for r in rs2 if r.t > lo.t]
            if not after:
                continue
            hi = max(after, key=lambda r: r.mgdl)
            meal_before = any(_meal_ok(m) and F.local_dt(dd, time(DAWN_TROUGH[0]), tz) <= m.t <= hi.t for m in snap.meals)
            dawns.append((dd, hi.mgdl - lo.mgdl, lo, hi, meal_before))
    nights.sort(key=lambda r: r[0])
    dawns.sort(key=lambda r: r[0])

    # overnight lows
    if len(nights) >= NIGHT_MIN_NIGHTS:
        k = sum(1 for n_ in nights if n_[1])
        if k >= 2:
            b = _B()
            lows = [n_[3] for n_ in nights if n_[1]]
            e_k, e_n, e_lo = b.add("nights_with_low", k, "count"), b.add("eligible_nights", len(nights), "count"), b.add("lowest", _r(min(lows)), "mg/dL")
            e_t, e_w = b.add("low_threshold", _r(th.low_mgdl), "mg/dL", "context"), b.add("window", f"{NIGHT[0]:02d}:00-{NIGHT[1]:02d}:00", "", "context")
            level, reason = EV.grade_recurrence([n_[1] for n_ in nights], 2, NIGHT_MIN_NIGHTS, 0.25)
            out.append(Candidate(
                key="overnight_low", category="overnight_pattern", trigger="morning", window=(F.local_dt(nights[0][0], time(0), tz), snap.now), facts=b.facts,
                claims=[f"Glucose went below {_r(th.low_mgdl)} mg/dL [{e_t}] between {NIGHT[0]:02d}:00 and {NIGHT[1]:02d}:00 [{e_w}] on {k} [{e_k}] of {len(nights)} [{e_n}] nights with enough readings; the lowest reading was {_r(min(lows))} mg/dL [{e_lo}]."],
                boundaries=[NOT_ADVICE, ASSOC, "Lows are reported as past episodes only. This card is not an alert."], limitations=[MISSING, "The available data cannot establish the cause of a low."], coverage=1.0,
                method=f"nights (00:00-06:00) with a reading below the low threshold, over the last {LOOKBACK_DAYS} days", explanations=[], suggestions=[M.DISCUSS_FREQUENT_LOWS],
                scores={"safety": 1.0, "evidence": 0.8 if level == EV.VALIDATED else 0.6, "recurrence": k / len(nights), "relevance": 1.0, "actionability": 0.7},
                evidence_level=level or EV.DESCRIPTIVE, pattern_id="overnight_low", criteria=">= 2 nights with a low of >= 5 eligible nights (>= 25%); validated if both halves of the period show it",
                detail={"nights": [{"date": n_[0].isoformat(), "low": n_[1], "min_mgdl": _r(n_[3]), "max_mgdl": _r(n_[4])} for n_ in nights]}))
        kh = sum(1 for n_ in nights if n_[2])
        level, reason = EV.grade_recurrence([n_[2] for n_ in nights], 3, NIGHT_MIN_NIGHTS, 0.5)
        if level:
            b = _B()
            e_k, e_n, e_t = b.add("nights_high", kh, "count"), b.add("eligible_nights", len(nights), "count"), b.add("high_threshold", _r(th.high_mgdl), "mg/dL", "context")
            e_w = b.add("window", f"{NIGHT[0]:02d}:00-{NIGHT[1]:02d}:00", "", "context")
            out.append(Candidate(
                key="overnight_high", category="overnight_pattern", trigger="morning", window=(F.local_dt(nights[0][0], time(0), tz), snap.now), facts=b.facts,
                claims=[f"Glucose stayed above {_r(th.high_mgdl)} mg/dL [{e_t}] for at least an hour between {NIGHT[0]:02d}:00 and {NIGHT[1]:02d}:00 [{e_w}] on {kh} [{e_k}] of {len(nights)} [{e_n}] nights with enough readings."],
                boundaries=[NOT_ADVICE, ASSOC, "Possibilities only. Never state a cause as fact, a dose, units, or an exact timing."], limitations=[MISSING, "Food or insulin that was not logged is not visible here."], coverage=1.0,
                method=f"nights (00:00-06:00) with >= 60 minutes above range, over the last {LOOKBACK_DAYS} days; {reason}", explanations=list(M.MORNING_PATTERN[0]), suggestions=list(M.MORNING_PATTERN[1]),
                scores={"safety": 0.6, "evidence": 0.85 if level == EV.VALIDATED else 0.65, "recurrence": kh / len(nights), "relevance": 0.9, "actionability": 0.6},
                evidence_level=level, pattern_id="overnight_high", criteria=">= 3 nights of >= 5 eligible (>= 50%); validated if both halves of the period show it",
                detail={"nights": [{"date": n_[0].isoformat(), "high": n_[2], "max_mgdl": _r(n_[4])} for n_ in nights]}))
    # dawn rise before any logged meal
    elig = [x for x in dawns if not x[4]]
    excluded = len(dawns) - len(elig)
    hits = [x[1] >= DAWN_RISE for x in elig]
    level, reason = EV.grade_recurrence(hits, 3, NIGHT_MIN_NIGHTS, 0.5)
    if level:
        k = sum(hits)
        rises = [x[1] for x in elig if x[1] >= DAWN_RISE]
        b = _B()
        e_k, e_n, e_r = b.add("mornings_with_rise", k, "count"), b.add("eligible_mornings", len(elig), "count"), b.add("rise_threshold", _r(DAWN_RISE), "mg/dL", "context")
        e_med, e_w = b.add("median_rise", _r(statistics.median(rises)), "mg/dL"), b.add("window", f"{DAWN_TROUGH[0]:02d}:00-{DAWN_PEAK_END:02d}:00", "", "context")
        claims = [f"On {k} [{e_k}] of the last {len(elig)} [{e_n}] mornings with enough readings, glucose rose by at least {_r(DAWN_RISE)} mg/dL [{e_r}] between {DAWN_TROUGH[0]:02d}:00 and {DAWN_PEAK_END:02d}:00 [{e_w}] before any logged meal; the median of those rises was {_r(statistics.median(rises))} mg/dL [{e_med}]."]
        lim = [MISSING]
        if excluded:
            lim.append(f"{excluded} morning(s) with a logged meal before the peak were left out because the meal could explain the rise.")
        out.append(Candidate(
            key="dawn_rise", category="overnight_pattern", trigger="morning", window=(F.local_dt(elig[0][0], time(DAWN_TROUGH[0]), tz), snap.now), facts=b.facts, claims=claims,
            boundaries=[NOT_ADVICE, ASSOC, "Possibilities only. Never state a cause as fact, a dose, units, or an exact timing.", "One morning is never called a dawn pattern; this needs repetition."], limitations=lim, coverage=1.0,
            method=f"rise from the lowest reading 03:00-06:00 to the highest before 08:00, mornings without a logged meal before the peak; {reason}", explanations=list(M.MORNING_PATTERN[0]), suggestions=list(M.MORNING_PATTERN[1]),
            scores={"safety": 0.6, "evidence": 0.85 if level == EV.VALIDATED else 0.65, "recurrence": k / len(elig), "relevance": 0.95, "actionability": 0.6},
            evidence_level=level, pattern_id="dawn_rise", criteria=">= 3 mornings of >= 5 eligible (>= 50%); validated if both halves of the period show it",
            detail={"mornings": [{"date": x[0].isoformat(), "rise_mgdl": _r(x[1]), "from": _r(x[2].mgdl), "to": _r(x[3].mgdl)} for x in elig], "excluded_with_logged_meal": excluded}))
    return out


# ----------------------------------------------------------------------------- E. variability change / H. change from baseline
def _period(snap: Snapshot, clean: list[Reading], d: date, first_back: int, last_back: int, tz: ZoneInfo):
    """Readings of the local days d-last_back .. d-first_back that are themselves well covered; returns (readings, days)."""
    th = snap.settings.th
    rs: list[Reading] = []
    days: list[date] = []
    for back in range(first_back, last_back + 1):
        dd = d - timedelta(days=back)
        s, e = F.day_bounds(dd, tz)
        if e > snap.now or _cov(clean, s, e, th) < MIN_WINDOW_COV:
            continue
        days.append(dd)
        rs.extend(_inw(clean, s, e))
    return rs, days


def variability_change(snap: Snapshot, clean: list[Reading], d: date) -> Optional[Candidate]:
    th, tz = snap.settings.th, _tz(snap)
    recent, rd = _period(snap, clean, d, 1, 14, tz)
    prior, pd_ = _period(snap, clean, d, 15, 28, tz)
    if len(rd) < VAR_MIN_DAYS or len(pd_) < VAR_MIN_DAYS:
        return None
    a, p = F.stats(recent), F.stats(prior)
    if a is None or p is None:
        return None

    def tir(days: list[date]):
        tot = F.Range(0, 0, 0, 0)
        i = b_ = ab = 0.0
        for dd in days:
            s, e = F.day_bounds(dd, tz)
            r = _tir(clean, s, e, th)
            i += r.minutes_in; b_ += r.minutes_below; ab += r.minutes_above
        return F.Range(i, b_, ab, i + b_ + ab)

    ta, tp = tir(rd), tir(pd_)
    d_cv, d_tir = a.cv_pct - p.cv_pct, ta.pct_in - tp.pct_in
    if abs(d_cv) < VAR_CV_POINTS and abs(d_tir) < VAR_TIR_POINTS:
        return None
    b = _B()
    e_cv1, e_cv0 = b.add("cv_recent", _r(a.cv_pct), "%"), b.add("cv_previous", _r(p.cv_pct), "%")
    e_m1, e_m0 = b.add("mean_recent", _r(a.mean), "mg/dL"), b.add("mean_previous", _r(p.mean), "mg/dL")
    e_t1, e_t0 = b.add("time_in_range_recent", _r(ta.pct_in), "%"), b.add("time_in_range_previous", _r(tp.pct_in), "%")
    e_d1, e_d0 = b.add("days_recent", len(rd), "count"), b.add("days_previous", len(pd_), "count")
    more = "less" if d_cv > 0 else "more"
    claims = [
        f"Over the last two weeks your glucose variability (coefficient of variation) was {_r(a.cv_pct)}% [{e_cv1}] compared with {_r(p.cv_pct)}% [{e_cv0}] in the two weeks before, so your readings were {more} consistent.",
        f"Average glucose was {_r(a.mean)} mg/dL [{e_m1}] versus {_r(p.mean)} mg/dL [{e_m0}], and time in range was {_r(ta.pct_in)}% [{e_t1}] versus {_r(tp.pct_in)}% [{e_t0}].",
        f"This compares {len(rd)} [{e_d1}] and {len(pd_)} [{e_d0}] days that each had enough readings.",
    ]
    worse = d_cv > 0 or d_tir < 0
    return Candidate(
        key="variability_change", category="variability_change", trigger="evening", window=(F.day_bounds(min(pd_), tz)[0], snap.now), facts=b.facts, claims=claims,
        boundaries=[NOT_ADVICE, ASSOC, "Standard coverage rules for CGM metrics apply to continuous data; this card is only shown when both periods had enough readings."],
        limitations=["Both periods are compared on days with enough readings only.", "A change in variability does not show why it changed."], coverage=1.0,
        method="coefficient of variation, mean and time in range for the last 14 days against the 14 days before, on well-covered days",
        scores={"safety": 0.6 if worse else 0.3, "evidence": 0.7, "recurrence": 0.5, "relevance": 0.85, "actionability": 0.4}, suggestions=[M.LOG_CONTEXT],
        evidence_level=EV.REPEATED, pattern_id="variability_change", criteria=f">= {VAR_MIN_DAYS} covered days in each 14-day period and a change of >= {_r(VAR_CV_POINTS)} CV points or >= {_r(VAR_TIR_POINTS)} time-in-range points",
        detail={"recent_days": [x.isoformat() for x in rd], "previous_days": [x.isoformat() for x in pd_], "cv_change_points": round(d_cv, 1), "tir_change_points": round(d_tir, 1)},
    )


def baseline_shift(snap: Snapshot, clean: list[Reading], d: date) -> Optional[Candidate]:
    th, tz = snap.settings.th, _tz(snap)
    best = None
    for sh in range(0, 24, TW_HOURS):
        rec, pri = [], []
        rd, pd_ = [], []
        for back in range(1, 22):
            dd = d - timedelta(days=back)
            w = _window_stat(snap, clean, dd, sh, sh + TW_HOURS, tz)
            if w is None or not w[2]:
                continue
            m = statistics.fmean(x.mgdl for x in w[2])
            if back <= 7:
                rec.append(m); rd.append(dd)
            else:
                pri.append(m); pd_.append(dd)
        if len(rec) < SHIFT_MIN_RECENT or len(pri) < SHIFT_MIN_PRIOR:
            continue
        diff = statistics.fmean(rec) - statistics.fmean(pri)
        if abs(diff) >= SHIFT_MGDL and (best is None or abs(diff) > abs(best[0])):
            best = (diff, sh, statistics.fmean(rec), statistics.fmean(pri), len(rec), len(pri), rd, pd_)
    if best is None:
        return None
    diff, sh, mr, mp, nr, npr, rd, pd_ = best
    b = _B()
    e_d, e_r, e_p = b.add("difference", _r(abs(diff)), "mg/dL"), b.add("mean_recent", _r(mr), "mg/dL"), b.add("mean_previous", _r(mp), "mg/dL")
    e_w, e_n1, e_n0 = b.add("window", _fmt_win(sh), "", "context"), b.add("days_recent", nr, "count"), b.add("days_previous", npr, "count")
    word = "higher" if diff > 0 else "lower"
    claims = [f"Average glucose between {_fmt_win(sh)} [{e_w}] was {_r(abs(diff))} mg/dL [{e_d}] {word} over the last week ({_r(mr)} mg/dL [{e_r}]) than over the two weeks before ({_r(mp)} mg/dL [{e_p}]), on {nr} [{e_n1}] and {npr} [{e_n0}] days with enough readings."]
    return Candidate(
        key=f"baseline_shift:{sh:02d}", category="baseline_shift", trigger="evening", window=(F.local_dt(min(pd_), time(sh), tz), snap.now), facts=b.facts, claims=claims,
        boundaries=[NOT_ADVICE, ASSOC], limitations=["The window with the largest difference was picked from eight 3-hour windows.", "A change from the usual does not show why it changed."], coverage=1.0,
        method="mean glucose per 3-hour window, last 7 days against the 14 days before, on days with enough readings",
        scores={"safety": 0.5 if diff > 0 else 0.4, "evidence": 0.6, "recurrence": 0.4, "relevance": 0.85, "actionability": 0.4}, suggestions=[M.LOG_CONTEXT],
        evidence_level=EV.REPEATED, pattern_id=f"baseline_shift:{sh:02d}", criteria=f">= {_r(SHIFT_MGDL)} mg/dL difference of window means with >= {SHIFT_MIN_RECENT} recent and >= {SHIFT_MIN_PRIOR} prior covered days",
        detail={"recent_days": [x.isoformat() for x in rd], "previous_days": [x.isoformat() for x in pd_], "window": _fmt_win(sh)},
    )


# ----------------------------------------------------------------------------- B. post-meal response across comparable meals
def post_meal_pattern(snap: Snapshot, clean: list[Reading], d: date) -> Optional[Candidate]:
    th, tz = snap.settings.th, _tz(snap)
    since = snap.now - timedelta(days=14)
    meals = sorted([m for m in snap.meals if _meal_ok(m) and (m.carbs_g or 0) >= MEAL_MIN_CARBS and m.t >= since and m.t + timedelta(minutes=MEAL_WINDOW_MIN) <= snap.now], key=lambda m: m.t)
    rows = []
    skipped_overlap = skipped_data = 0
    for m in meals:
        others = [o for o in snap.meals if o.id != m.id and _meal_ok(o)]
        if any(timedelta(minutes=-90) <= o.t - m.t < timedelta(minutes=0) or timedelta(0) < o.t - m.t <= timedelta(minutes=MEAL_RISE_WITHIN_MIN) for o in others):
            skipped_overlap += 1
            continue
        pre = _near(clean, m.t, th.meal_pre_min)
        s, e = m.t, m.t + timedelta(minutes=MEAL_WINDOW_MIN)
        if pre is None or _cov(clean, s, e, th) < th.min_cov_meal:
            skipped_data += 1
            continue
        rs90 = _inw(clean, s, m.t + timedelta(minutes=MEAL_RISE_WITHIN_MIN))
        rs = _inw(clean, s, e)
        if not rs90:
            skipped_data += 1
            continue
        peak90 = max(rs90, key=lambda r: r.mgdl)
        peak = max(rs, key=lambda r: r.mgdl)
        ins = any(timedelta(minutes=-15) <= i.t - m.t <= timedelta(minutes=30) for i in _rapid(snap))
        rows.append({"m": m, "pre": pre.mgdl, "rise90": peak90.mgdl - pre.mgdl, "tpeak": (peak.t - m.t).total_seconds() / 60, "insulin": ins})
    if len(rows) < MEAL_MIN_N:
        return None
    # comparable = the carbohydrate band with the most meals
    bands = {"under": (None, 30.0), "mid": (30.0, 60.0), "over": (60.0, None)}
    def inband(lo, hi, c):
        return c < hi if lo is None else (c > lo if hi is None else lo <= c <= hi)

    name, pick = max(((n_, [r for r in rows if inband(lo, hi, r["m"].carbs_g)]) for n_, (lo, hi) in bands.items()), key=lambda x: len(x[1]))
    if len(pick) < MEAL_MIN_N:
        return None
    lo, hi = bands[name]
    rises = [r["rise90"] for r in pick]
    k = sum(1 for x in rises if x >= th.meal_response_min_rise_mgdl)
    level, reason = EV.grade_recurrence([x >= th.meal_response_min_rise_mgdl for x in rises], 4, MEAL_MIN_N, 0.6)
    med = statistics.median(rises)
    if level is None or med < th.meal_response_min_rise_mgdl:
        return None
    n_ins = sum(1 for r in pick if r["insulin"])
    b = _B()
    e_n, e_k, e_med = b.add("comparable_meals", len(pick), "count"), b.add("meals_with_rise", k, "count"), b.add("median_rise_90min", _r(med), "mg/dL")
    e_thr, e_t = b.add("rise_threshold", _r(th.meal_response_min_rise_mgdl), "mg/dL", "context"), b.add("median_minutes_to_peak", _r(statistics.median(r["tpeak"] for r in pick)), "min")
    e_pre, e_i = b.add("median_start_glucose", _r(statistics.median(r["pre"] for r in pick)), "mg/dL"), b.add("meals_with_insulin_record", n_ins, "count")
    if lo is None:
        band_txt = f"under {_r(hi)} g [{b.add('carb_band_high', _r(hi), 'g', 'context')}]"
    elif hi is None:
        band_txt = f"over {_r(lo)} g [{b.add('carb_band_low', _r(lo), 'g', 'context')}]"
    else:
        band_txt = f"{_r(lo)} to {_r(hi)} g [{b.add('carb_band_low', _r(lo), 'g', 'context')}, {b.add('carb_band_high', _r(hi), 'g', 'context')}]"
    claims = [
        f"Across {len(pick)} [{e_n}] comparable meals of {band_txt} carbohydrate, glucose rose by a median of {_r(med)} mg/dL [{e_med}] within {MEAL_RISE_WITHIN_MIN} minutes [{b.add('rise_window', MEAL_RISE_WITHIN_MIN, 'min', 'context')}], starting from a median of {_r(statistics.median(r['pre'] for r in pick))} mg/dL [{e_pre}].",
        f"The rise was at least {_r(th.meal_response_min_rise_mgdl)} mg/dL [{e_thr}] after {k} [{e_k}] of those meals, and glucose peaked a median of {_r(statistics.median(r['tpeak'] for r in pick))} minutes [{e_t}] after eating.",
        f"{n_ins} [{e_i}] of the {len(pick)} meals had a rapid-acting dose recorded around mealtime.",
    ]
    fat = [r["m"].fat_g for r in pick if r["m"].fat_g is not None]
    lim = ["Carbohydrate amounts are estimates, and the card does not say that carbohydrates, timing or insulin caused the rise.", MISSING]
    if skipped_overlap or skipped_data:
        lim.append(f"{skipped_overlap + skipped_data} other meal(s) were left out (another meal close by, or too few readings).")
    return Candidate(
        key=f"post_meal_pattern:{name}", category="post_meal_pattern", trigger="evening", window=(min(r["m"].t for r in pick), snap.now), facts=b.facts, claims=claims,
        boundaries=[NOT_ADVICE, ASSOC, "Possibilities only. Never state a cause as fact, a dose, units, or an exact timing."], limitations=lim, coverage=1.0,
        method=f"rise from the pre-meal reading to the highest reading within {MEAL_RISE_WITHIN_MIN} minutes for comparable meals (same carbohydrate band, no other meal close by), last 14 days; {reason}",
        explanations=list(M.BIG_MEAL_SPIKE[0]), suggestions=list(M.BIG_MEAL_SPIKE[1]),
        scores={"safety": 0.4, "evidence": 0.85 if level == EV.VALIDATED else 0.65, "recurrence": k / len(pick), "relevance": 0.9, "actionability": 0.6},
        evidence_level=level, pattern_id=f"post_meal_pattern:{name}", criteria=f">= {MEAL_MIN_N} comparable meals, a median rise above the threshold and >= 60% of meals above it; validated if both halves of the period show it",
        detail={"carb_band": band_txt.split(" [")[0], "meals": [{"at": r["m"].t.astimezone(tz).strftime("%Y-%m-%d %H:%M"), "carbs_g": _r(r["m"].carbs_g), "fat_g": None if r["m"].fat_g is None else _r(r["m"].fat_g), "start_mgdl": _r(r["pre"]), "rise_90min_mgdl": _r(r["rise90"]), "insulin_recorded": r["insulin"]} for r in pick], "median_fat_g": _r(statistics.median(fat)) if fat else None},
    )


# ----------------------------------------------------------------------------- F. glucose after recorded insulin
def insulin_fall_pattern(snap: Snapshot, clean: list[Reading], d: date) -> Optional[Candidate]:
    th, tz = snap.settings.th, _tz(snap)
    since = snap.now - timedelta(days=14)
    doses = sorted([i for i in _rapid(snap) if i.t >= since and i.t + timedelta(hours=5) <= snap.now], key=lambda i: i.t)
    rows = []
    with_meal = 0
    for i in doses:
        if any(timedelta(minutes=-30) <= m.t - i.t <= timedelta(minutes=120) for m in snap.meals if _meal_ok(m)):
            with_meal += 1
            continue
        pre = _near(clean, i.t, th.meal_pre_min)
        s, e = i.t, i.t + timedelta(hours=4)
        if pre is None or _cov(clean, s, e, th) < 0.7:
            continue
        rs = _inw(clean, i.t + timedelta(minutes=30), e)
        if not rs:
            continue
        lo = min(rs, key=lambda r: r.mgdl)
        overlap = any(timedelta(0) < i.t - o.t <= timedelta(hours=3) for o in doses if o.id != i.id)
        rows.append({"i": i, "pre": pre.mgdl, "fall": pre.mgdl - lo.mgdl, "low": lo.mgdl < th.low_mgdl, "overlap": overlap, "lo": lo.mgdl})
    fell = [r for r in rows if r["fall"] >= DOSE_FALL_MGDL]
    lows = [r for r in rows if r["low"]]
    days = {r["i"].t.astimezone(tz).date() for r in fell}
    if len(fell) < DOSE_MIN_OCCASIONS or len(days) < 2:
        return None
    b = _B()
    e_k, e_n, e_f = b.add("doses_followed_by_fall", len(fell), "count"), b.add("doses_assessed", len(rows), "count"), b.add("fall_threshold", _r(DOSE_FALL_MGDL), "mg/dL", "context")
    e_med = b.add("median_fall", _r(statistics.median(r["fall"] for r in fell)), "mg/dL")
    e_low, e_ov = b.add("falls_ending_below_range", len(lows), "count"), b.add("with_dose_in_previous_3h", sum(1 for r in fell if r["overlap"]), "count")
    claims = [
        f"After {len(fell)} [{e_k}] of {len(rows)} [{e_n}] recorded rapid-acting doses with no meal logged nearby, glucose fell by at least {_r(DOSE_FALL_MGDL)} mg/dL [{e_f}] within four hours, by a median of {_r(statistics.median(r['fall'] for r in fell))} mg/dL [{e_med}].",
        f"{len(lows)} [{e_low}] of those falls ended below {_r(th.low_mgdl)} mg/dL, and {sum(1 for r in fell if r['overlap'])} [{e_ov}] came when another dose had been recorded in the previous three hours.",
        "Active insulin may have contributed, but the records alone cannot establish that.",
    ]
    lim = [MISSING, "A logged dose is not proof of how much insulin acted; suggested doses are never counted as taken."]
    if with_meal:
        lim.append(f"{with_meal} dose(s) with a meal logged nearby were left out.")
    return Candidate(
        key="insulin_fall_pattern", category="insulin_fall_pattern", trigger="evening", window=(min(r["i"].t for r in fell), snap.now), facts=b.facts, claims=claims,
        boundaries=[NOT_ADVICE, ASSOC, "Never state that a dose was too large or recommend a change; anything about doses is for the care team."], limitations=lim, coverage=1.0,
        method="glucose change after recorded rapid-acting doses with no logged meal within -30 to +120 minutes, over 4 hours, last 14 days", explanations=list(M.LOW_AFTER_DOSE[0]), suggestions=list(M.LOW_AFTER_DOSE[1]),
        scores={"safety": 0.9 if lows else 0.6, "evidence": 0.6, "recurrence": min(1.0, len(fell) / 5), "relevance": 0.85, "actionability": 0.6},
        evidence_level=EV.REPEATED, pattern_id="insulin_fall_pattern", criteria=f">= {DOSE_MIN_OCCASIONS} doses on >= 2 days followed by a fall of >= {_r(DOSE_FALL_MGDL)} mg/dL",
        detail={"doses": [{"at": r["i"].t.astimezone(tz).strftime("%Y-%m-%d %H:%M"), "units": r["i"].units, "start_mgdl": _r(r["pre"]), "fall_mgdl": _r(r["fall"]), "lowest_mgdl": _r(r["lo"]), "another_dose_within_3h": r["overlap"]} for r in fell]},
    )


# ----------------------------------------------------------------------------- I. completeness of the insulin record
def insulin_record_gap(snap: Snapshot, clean: list[Reading], d: date) -> Optional[Candidate]:
    since = snap.now - timedelta(hours=24)
    meals = [m for m in snap.meals if _meal_ok(m) and m.t >= since and (m.carbs_g or 0) >= MEAL_MIN_CARBS]
    if len(meals) < GAP_MIN_MEALS:
        return None
    ins = _rapid(snap)
    missing = [m for m in meals if not any(abs((i.t - m.t).total_seconds()) <= 3600 for i in ins)]
    if len(missing) < GAP_MIN_MEALS or len(missing) / len(meals) < 0.5:
        return None
    b = _B()
    e_m, e_n = b.add("meals_without_insulin_record", len(missing), "count"), b.add("meals_logged", len(meals), "count")
    claims = [f"{len(missing)} [{e_m}] of the {len(meals)} [{e_n}] meals logged in the last 24 hours have no rapid-acting insulin record within an hour, so insulin-related findings and forecasts are less reliable until the records are complete."]
    return Candidate(
        key="insulin_record_gap", category="data_completeness", trigger="evening", window=(since, snap.now), facts=b.facts, claims=claims,
        boundaries=[NOT_ADVICE, "This is about the completeness of the records, not about what was taken."], limitations=[MISSING], coverage=1.0,
        method="meals with carbohydrates logged in the last 24 hours compared with rapid-acting insulin records within one hour", suggestions=[M.LOG_CONTEXT],
        scores={"safety": 0.5, "evidence": 0.9, "recurrence": 0.3, "relevance": 0.7, "actionability": 0.8}, evidence_level=EV.DESCRIPTIVE, pattern_id="insulin_record_gap",
        criteria=f">= {GAP_MIN_MEALS} logged meals in 24 hours and at least half without an insulin record within an hour",
        detail={"meals": [m.t.astimezone(_tz(snap)).strftime("%Y-%m-%d %H:%M") for m in missing]},
    )


# ----------------------------------------------------------------------------- entry point
def reconcile(cands: list[Candidate]) -> list[Candidate]:
    """One card per finding: a richer research card replaces the older card that reported the same thing."""
    cats = {c.category for c in cands}
    out = []
    for c in cands:
        if c.category == "episode_time_pattern" and "time_window_high" in cats and not any(f.name.endswith("_below") for f in c.facts):
            continue
        if c.category == "frequent_lows" and "hypo_pattern" in cats:
            continue
        if c.category == "recurring_meal_response" and "post_meal_pattern" in cats:
            continue
        out.append(c)
    return out


TITLES = {
    "time_window_high": lambda c: f"Glucose is often high between {c.detail.get('window', '')}".replace("-", " and "),
    "hypo_pattern": lambda c: "Lows over the last two weeks",
    "overnight_low": lambda c: "Overnight lows",
    "overnight_high": lambda c: "Overnight highs",
    "dawn_rise": lambda c: "A recurring early-morning rise",
    "variability_change": lambda c: "Your glucose variability changed",
    "baseline_shift": lambda c: f"Glucose changed between {c.detail.get('window', '')}".replace("-", " and "),
    "post_meal_pattern": lambda c: "Your usual response after meals",
    "insulin_fall_pattern": lambda c: "Glucose after recorded insulin",
    "insulin_record_gap": lambda c: "Insulin records look incomplete",
}


def _titled(c: Candidate) -> Candidate:
    f = TITLES.get(c.key.split(":")[0])
    if f:
        c.detail["title"] = f(c)
    return c


def candidates(snap: Snapshot, clean: list[Reading], d: date, kind: str) -> list[Candidate]:
    out: list[Candidate] = []

    def add(x) -> None:
        if x is None:
            return
        out.extend(x if isinstance(x, list) else [x])

    if kind == "morning":
        add(overnight_patterns(snap, clean, d))
    elif kind == "evening":
        add(hypo_pattern(snap, clean, d))
        add(time_window_high(snap, clean, d))
        add(post_meal_pattern(snap, clean, d))
        add(variability_change(snap, clean, d))
        add(baseline_shift(snap, clean, d))
        add(insulin_fall_pattern(snap, clean, d))
        add(insulin_record_gap(snap, clean, d))
    return [_titled(c) for c in out]
