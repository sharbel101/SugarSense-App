"""Pattern detectors. Each returns candidate findings (or nothing) with evidence refs, window, coverage, method and boundaries.

Rules: Python computes and renders every number; a detector returns nothing when its evidence requirements are not met;
an association is never worded as a cause; lows are reported retrospectively only (the existing alert system owns real-time lows).
"""
from __future__ import annotations

import math
import statistics
from datetime import date, datetime, timedelta
from typing import Optional
from zoneinfo import ZoneInfo

from . import features as F
from .models import Candidate, Fact, Snapshot, Reading
from .quality import Availability, Flag, coverage, in_window

NOT_ADVICE = "This describes recorded data. It is not a dose, treatment or safety instruction; real-time safety alerts come from the existing alert system."
ASSOC = "A pattern or association in recorded data does not show what caused it."


class _B:
    """Fact builder: assigns refs E1, E2... and returns the ref string for use in claims."""
    def __init__(self) -> None:
        self.facts: list[Fact] = []

    def add(self, name: str, value, unit: str, kind: str = "computed") -> str:
        ref = f"E{len(self.facts) + 1}"
        self.facts.append(Fact(ref, name, value, unit, kind))  # type: ignore[arg-type]
        return ref


def _tz(snap: Snapshot) -> ZoneInfo:
    try:
        return ZoneInfo(snap.settings.timezone)
    except Exception:
        return ZoneInfo("UTC")


def _hm(dt: datetime, tz: ZoneInfo) -> str:
    return dt.astimezone(tz).strftime("%H:%M")


def _r(x: float) -> int:
    return int(round(x))


def _r1(x: float) -> float:
    return round(x, 1)


def local_date(snap: Snapshot) -> date:
    return snap.now.astimezone(_tz(snap)).date()


# --------------------------------------------------------------------------------------------------------------------
def overnight_summary(snap: Snapshot, clean: list[Reading], flags: list[Flag], d: date) -> Optional[Candidate]:
    th, tz = snap.settings.th, _tz(snap)
    start, end = F.overnight_window(d, th, tz)
    end = min(end, snap.now)
    rs = in_window(clean, start, end)
    cov = coverage(clean, start, end, th)
    if len(rs) < th.min_readings_summary or cov < th.min_cov_overnight:
        return None
    s = F.stats(rs)
    rng = F.time_in_range(clean, start, end, th)
    if s is None:
        return None
    b = _B()
    e_n = b.add("readings_used", len(rs), "count", "computed")
    e_cov = b.add("coverage", _r(cov * 100), "%", "computed")
    e_min = b.add("overnight_min", _r(s.minimum), "mg/dL", "measured")
    e_max = b.add("overnight_max", _r(s.maximum), "mg/dL", "measured")
    e_mean = b.add("overnight_mean", _r(s.mean), "mg/dL", "computed")
    e_in = b.add("pct_in_range", _r(rng.pct_in), "%", "computed")
    e_lo = b.add("pct_below_range", _r(rng.pct_below), "%", "computed")
    e_hi = b.add("pct_above_range", _r(rng.pct_above), "%", "computed")
    claims = [
        f"From {_hm(start, tz)} to {_hm(end, tz)}, {len(rs)} readings [{e_n}] covered {_r(cov * 100)}% of the night [{e_cov}]: lowest {_r(s.minimum)} mg/dL [{e_min}], highest {_r(s.maximum)} mg/dL [{e_max}], average {_r(s.mean)} mg/dL [{e_mean}].",
        f"Time in range ({_r(th.low_mgdl)}-{_r(th.high_mgdl)} mg/dL), as a share of covered time: in range {_r(rng.pct_in)}% [{e_in}], below {_r(rng.pct_below)}% [{e_lo}], above {_r(rng.pct_above)}% [{e_hi}].",
    ]
    for ex in F.excursions(clean, start, end, th)[:2]:
        word = "above" if ex.kind == "above" else "below"
        ref = b.add(f"overnight_{word}_range_minutes", _r(ex.minutes), "min", "computed")
        ref2 = b.add(f"overnight_{word}_range_extreme", _r(ex.extreme_mgdl), "mg/dL", "measured")
        claims.append(f"Glucose stayed {word} range for about {_r(ex.minutes)} minutes [{ref}] (from {_hm(ex.start, tz)}), reaching {_r(ex.extreme_mgdl)} mg/dL at {_hm(ex.extreme_at, tz)} [{ref2}].")
    base = _baseline(snap, clean, "overnight", d)
    if base is not None and abs(s.mean - base[0]) / base[0] * 100 >= th.baseline_delta_pct:
        e_b = b.add("usual_overnight_mean", _r(base[0]), "mg/dL", "computed")
        e_n = b.add("usual_nights", base[1], "count", "computed")
        claims.append(f"The usual overnight average over the previous {base[1]} nights was {_r(base[0])} mg/dL [{e_b}, {e_n}], so this night's average differed from your usual.")
    lim = []
    if not snap.sleeps:
        lim.append("There is no sleep record, so nothing is said about sleep quality.")
    lim += _flag_limits(flags, start, end)
    return Candidate(
        key=f"overnight:{d.isoformat()}", category="overnight_summary", trigger="morning", window=(start, end),
        facts=b.facts, claims=claims, boundaries=[NOT_ADVICE, ASSOC, "Describes observed glucose only."],
        limitations=lim, coverage=cov, method="stats + time-weighted time in range over the overnight window",
        quality_flags=sorted({f.code for f in flags}),
        scores={"safety": 1.0 if rng.minutes_below > 0 else 0.3 if rng.minutes_above > 0 else 0.1, "evidence": cov, "recurrence": 0.0, "relevance": 0.9, "actionability": 0.3},
    )


def _baseline(snap: Snapshot, clean: list[Reading], kind: str, d: date) -> Optional[tuple[float, int]]:
    """Mean of the previous days' same-window mean, only over well-covered days. None if fewer than min_days_baseline."""
    th, tz = snap.settings.th, _tz(snap)
    means = []
    for k in range(1, th.lookback_days + 1):
        dd = d - timedelta(days=k)
        s, e = F.overnight_window(dd, th, tz) if kind == "overnight" else F.day_bounds(dd, tz)
        rs = in_window(clean, s, e)
        if len(rs) >= th.min_readings_summary and coverage(clean, s, e, th) >= (th.min_cov_baseline_day):
            st = F.stats(rs)
            if st:
                means.append(st.mean)
    if len(means) < th.min_days_baseline:
        return None
    return statistics.fmean(means), len(means)


def _flag_limits(flags: list[Flag], start: datetime, end: datetime) -> list[str]:
    inside = [f for f in flags if f.t and start <= f.t <= end]
    out = []
    n_conf = sum(1 for f in inside if f.code == "conflicting_duplicates")
    n_bad = sum(1 for f in inside if f.code in ("implausible_value", "implausible_spike"))
    if n_conf:
        out.append(f"{n_conf} reading time(s) had conflicting values and were excluded.")
    if n_bad:
        out.append(f"{n_bad} implausible reading(s) were excluded.")
    return out


# --------------------------------------------------------------------------------------------------------------------
def morning_rise_recurring(snap: Snapshot, clean: list[Reading], d: date) -> Optional[Candidate]:
    """Recurring morning rise: pre-dawn trough (03:00-06:00 local) to post-wake peak (06:00 to wake+2h). Needs replication."""
    th, tz = snap.settings.th, _tz(snap)
    rises, details = [], []
    last_start = last_end = None
    for k in range(0, th.lookback_days + 1):
        dd = d - timedelta(days=k)
        t0, t1 = F.local_dt(dd, F.hhmm("03:00"), tz), F.local_dt(dd, F.hhmm("06:00"), tz)
        p1 = F.local_dt(dd, F.hhmm(th.wake), tz) + timedelta(hours=2)
        if p1 > snap.now:
            continue
        if coverage(clean, t0, p1, th) < th.min_cov_overnight:
            continue
        res = F.rise_between(clean, t0, t1, t1, p1)
        if res is None:
            continue
        rises.append(res[0])
        last_start, last_end = (last_start or t0), p1
        details.append(dd)
    n = len(rises)
    if n < th.min_days_recurring:
        return None
    k = sum(1 for x in rises if x >= th.morning_rise_mgdl)
    if k / n < th.recurring_fraction:
        return None
    med = statistics.median([x for x in rises if x >= th.morning_rise_mgdl])
    b = _B()
    e_n = b.add("comparable_mornings", n, "count")
    e_k = b.add("mornings_with_rise", k, "count")
    e_t = b.add("rise_threshold", _r(th.morning_rise_mgdl), "mg/dL", "context")
    e_m = b.add("median_rise", _r(med), "mg/dL")
    claims = [f"On {k} of {n} comparable mornings [{e_k}, {e_n}], glucose rose by at least {_r(th.morning_rise_mgdl)} mg/dL [{e_t}] from the pre-dawn low to the post-wake peak; the median rise on those mornings was {_r(med)} mg/dL [{e_m}]."]
    s = min(details)
    return Candidate(
        key=f"morning_rise:{d.isoformat()}", category="morning_rise_pattern", trigger="morning",
        window=(F.local_dt(s, F.hhmm("03:00"), tz), last_end or snap.now), facts=b.facts, claims=claims,
        boundaries=[NOT_ADVICE, ASSOC, "Do not name a cause such as dawn phenomenon, basal insulin or insulin resistance."],
        limitations=[f"Based on {n} mornings; this is a pattern in a short history, not a diagnosis."],
        coverage=1.0, method="pre-dawn trough to post-wake peak, counted across comparable days",
        scores={"safety": 0.2, "evidence": min(1.0, n / 10), "recurrence": k / n, "relevance": 0.9, "actionability": 0.5}, direction="rising",
    )


# --------------------------------------------------------------------------------------------------------------------
def previous_day_context(snap: Snapshot, d: date) -> Optional[Candidate]:
    """Recorded events from yesterday evening to the end of the night. Only what was recorded; nothing is inferred."""
    th, tz = snap.settings.th, _tz(snap)
    start = F.local_dt(d - timedelta(days=1), F.hhmm("18:00"), tz)
    end = F.local_dt(d, F.hhmm(th.wake), tz)
    meals = [m for m in snap.meals if start <= m.t <= end and m.status in ("confirmed", "manual_entry") and m.carbs_g is not None]
    doses = [i for i in snap.insulin if start <= i.t <= end]
    acts = [a for a in snap.activities if start <= a.start <= end]
    if not (meals or doses or acts):
        return None
    b = _B()
    claims, lim = [], []
    if meals:
        last = max(meals, key=lambda m: m.t)
        e1 = b.add("evening_meals_recorded", len(meals), "count", "context")
        e2 = b.add("latest_meal_estimated_carbs", _r(last.carbs_g or 0), "g", "context")
        claims.append(f"{len(meals)} meal(s) were recorded since 18:00 yesterday [{e1}]; the latest was at {_hm(last.t, tz)} with about {_r(last.carbs_g or 0)} g estimated carbohydrates [{e2}].")
    if doses:
        e3 = b.add("insulin_events_recorded", len(doses), "count", "context")
        claims.append(f"{len(doses)} insulin record(s) exist for that period [{e3}]; the latest was at {_hm(max(doses, key=lambda i: i.t).t, tz)}.")
        if any(i.units is None for i in doses):
            lim.append("Some insulin records have no administered dose, so no dose total is given.")
    if acts:
        e4 = b.add("activities_recorded", len(acts), "count", "context")
        claims.append(f"{len(acts)} activity record(s) exist for that period [{e4}].")
    return Candidate(
        key=f"prev_day_context:{d.isoformat()}", category="previous_day_context", trigger="morning", window=(start, end),
        facts=b.facts, claims=claims, boundaries=[NOT_ADVICE, ASSOC, "Records may be incomplete; do not infer unrecorded meals, insulin or exercise."],
        limitations=lim, coverage=1.0, method="recorded events listed from 18:00 the previous day to wake time",
        scores={"safety": 0.1, "evidence": 0.5, "recurrence": 0.0, "relevance": 0.6, "actionability": 0.2},
    )


# --------------------------------------------------------------------------------------------------------------------
def forecast_outlook(snap: Snapshot, clean: list[Reading]) -> Optional[Candidate]:
    th, tz = snap.settings.th, _tz(snap)
    fc = [f for f in snap.forecast if (snap.now - f.anchor).total_seconds() / 60 <= th.forecast_max_age_min]
    if not fc:
        return None
    anchor = max(f.anchor for f in fc)
    cur = sorted([f for f in fc if f.anchor == anchor], key=lambda f: f.horizon_min)
    picks = []
    for want in (60, 120):
        best = min(cur, key=lambda f: abs(f.horizon_min - want))
        if abs(best.horizon_min - want) <= 15 and best not in picks:
            picks.append(best)
    if not picks:
        picks = [cur[-1]]
    b = _B()
    claims = []
    below = False
    for f in picks:
        lvl = _r(f.interval_level * 100)
        e_p = b.add(f"forecast_{f.horizon_min}min", _r(f.predicted_mgdl), "mg/dL", "forecast")
        e_lo = b.add(f"forecast_{f.horizon_min}min_lower", _r(f.lower_mgdl), "mg/dL", "uncertainty")
        e_hi = b.add(f"forecast_{f.horizon_min}min_upper", _r(f.upper_mgdl), "mg/dL", "uncertainty")
        e_h = b.add(f"forecast_{f.horizon_min}min_horizon", f.horizon_min, "min", "context")
        e_l = b.add(f"forecast_{f.horizon_min}min_interval_level", lvl, "%", "uncertainty")
        claims.append(f"The forecast made at {_hm(anchor, tz)} predicts {_r(f.predicted_mgdl)} mg/dL in {f.horizon_min} minutes [{e_p}, {e_h}], with a {lvl}% interval [{e_l}] of {_r(f.lower_mgdl)} to {_r(f.upper_mgdl)} mg/dL [{e_lo}, {e_hi}].")
        if f.lower_mgdl < th.low_mgdl:
            below = True
            claims.append(f"The lower end of that interval ({_r(f.lower_mgdl)} mg/dL) is below {_r(th.low_mgdl)} mg/dL: a possible bound, not the predicted value [{e_lo}].")
    return Candidate(
        key=f"forecast:{anchor.strftime('%Y%m%dT%H%M')}", category="forecast_outlook", trigger="morning",
        window=(anchor, anchor + timedelta(minutes=max(p.horizon_min for p in picks))), facts=b.facts, claims=claims,
        boundaries=[NOT_ADVICE, "A forecast is uncertain and is not a measurement. A bound is not a prediction."],
        limitations=["Forecasts get less reliable further ahead."], coverage=1.0, method="latest stored forecast run, horizons nearest 60 and 120 minutes",
        interval_level=picks[0].interval_level,
        scores={"safety": 0.6 if below else 0.3, "evidence": 0.6, "recurrence": 0.0, "relevance": 0.8, "actionability": 0.4},
    )


# --------------------------------------------------------------------------------------------------------------------
def day_summary(snap: Snapshot, clean: list[Reading], flags: list[Flag], d: date) -> Optional[Candidate]:
    th, tz = snap.settings.th, _tz(snap)
    start, end = F.day_bounds(d, tz)
    end = min(end, snap.now)
    rs = in_window(clean, start, end)
    cov = coverage(clean, start, end, th)
    s = F.stats(rs)
    if s is None or len(rs) < th.min_readings_summary or cov < th.min_cov_day:
        return None
    rng = F.time_in_range(clean, start, end, th)
    b = _B()
    e_n = b.add("readings_used", len(rs), "count")
    e_cov = b.add("coverage", _r(cov * 100), "%")
    e_mean = b.add("day_mean", _r(s.mean), "mg/dL")
    e_min = b.add("day_min", _r(s.minimum), "mg/dL", "measured")
    e_max = b.add("day_max", _r(s.maximum), "mg/dL", "measured")
    e_cv = b.add("day_cv", _r(s.cv_pct), "%")
    e_in = b.add("pct_in_range", _r(rng.pct_in), "%")
    e_lo = b.add("pct_below_range", _r(rng.pct_below), "%")
    e_hi = b.add("pct_above_range", _r(rng.pct_above), "%")
    claims = [
        f"Today so far ({_hm(start, tz)}-{_hm(end, tz)}): {len(rs)} readings [{e_n}] covered {_r(cov * 100)}% of the time [{e_cov}]; average {_r(s.mean)} mg/dL [{e_mean}], lowest {_r(s.minimum)} [{e_min}], highest {_r(s.maximum)} mg/dL [{e_max}], variability (coefficient of variation) {_r(s.cv_pct)}% [{e_cv}].",
        f"Time in range ({_r(th.low_mgdl)}-{_r(th.high_mgdl)} mg/dL): in range {_r(rng.pct_in)}% [{e_in}], below {_r(rng.pct_below)}% [{e_lo}], above {_r(rng.pct_above)}% [{e_hi}].",
    ]
    exs = F.excursions(clean, start, end, th)
    n_hi = sum(1 for x in exs if x.kind == "above")
    n_lo = sum(1 for x in exs if x.kind == "below")
    if exs:
        e_nh = b.add("excursions_above", n_hi, "count")
        e_nl = b.add("excursions_below", n_lo, "count")
        claims.append(f"Stays outside the range lasting at least {th.excursion_min_minutes} minutes: {n_hi} above [{e_nh}], {n_lo} below [{e_nl}].")
    return Candidate(
        key=f"day:{d.isoformat()}", category="day_summary", trigger="evening", window=(start, end), facts=b.facts, claims=claims,
        boundaries=[NOT_ADVICE, ASSOC, "Do not label the day good or bad from these numbers alone."],
        limitations=_flag_limits(flags, start, end), coverage=cov, method="stats + time-weighted time in range, local day to date",
        quality_flags=sorted({f.code for f in flags}),
        scores={"safety": 1.0 if rng.minutes_below > 0 else 0.3 if rng.minutes_above > 0 else 0.1, "evidence": cov, "recurrence": 0.0, "relevance": 0.9, "actionability": 0.3},
    )


def baseline_change(snap: Snapshot, clean: list[Reading], d: date) -> Optional[Candidate]:
    th, tz = snap.settings.th, _tz(snap)
    start, end = F.day_bounds(d, tz)
    end = min(end, snap.now)
    rs = in_window(clean, start, end)
    cov = coverage(clean, start, end, th)
    s = F.stats(rs)
    if s is None or len(rs) < th.min_readings_summary or cov < th.min_cov_day:
        return None
    prior_in, prior_mean = [], []
    for k in range(1, th.lookback_days + 1):
        ds, de = F.day_bounds(d - timedelta(days=k), tz)
        prs = in_window(clean, ds, de)
        if len(prs) >= th.min_readings_summary and coverage(clean, ds, de, th) >= th.min_cov_baseline_day:
            prior_in.append(F.time_in_range(clean, ds, de, th).pct_in)
            prior_mean.append(statistics.fmean(r.mgdl for r in prs))
    if len(prior_in) < th.min_days_baseline:
        return None
    today_in = F.time_in_range(clean, start, end, th).pct_in
    d_tir = today_in - statistics.fmean(prior_in)
    d_mean_pct = (s.mean - statistics.fmean(prior_mean)) / statistics.fmean(prior_mean) * 100
    if abs(d_tir) < th.baseline_tir_points and abs(d_mean_pct) < th.baseline_delta_pct:
        return None
    b = _B()
    e_t = b.add("today_pct_in_range", _r(today_in), "%")
    e_u = b.add("usual_pct_in_range", _r(statistics.fmean(prior_in)), "%")
    e_n = b.add("usual_days", len(prior_in), "count")
    e_m = b.add("today_mean", _r(s.mean), "mg/dL")
    e_um = b.add("usual_mean", _r(statistics.fmean(prior_mean)), "mg/dL")
    word = "higher" if d_tir > 0 else "lower"
    claims = [f"Time in range today was {_r(today_in)}% [{e_t}], {word} than your usual {_r(statistics.fmean(prior_in))}% over the previous {len(prior_in)} days [{e_u}, {e_n}]; average glucose was {_r(s.mean)} mg/dL [{e_m}] against a usual {_r(statistics.fmean(prior_mean))} mg/dL [{e_um}]."]
    return Candidate(
        key=f"baseline:{d.isoformat()}", category="baseline_change", trigger="evening", window=(start, end), facts=b.facts, claims=claims,
        boundaries=[NOT_ADVICE, ASSOC, "Do not call the day good or bad."], limitations=[f"The usual values come from {len(prior_in)} previous days."],
        coverage=cov, method="today versus the mean of previous well-covered days",
        scores={"safety": 0.2, "evidence": min(1.0, len(prior_in) / 10), "recurrence": 0.3, "relevance": 0.9, "actionability": 0.4},
        direction="rising" if d_tir > 0 else "falling",
    )


def excursion_candidates(snap: Snapshot, clean: list[Reading], flags: list[Flag], start: datetime, end: datetime, trigger: str) -> list[Candidate]:
    """Significant stays above range. Lows are NOT turned into insights here: the existing safety system owns them."""
    th, tz = snap.settings.th, _tz(snap)
    out = []
    for ex in F.excursions(clean, start, end, th):
        if ex.kind != "above" or ex.extreme_mgdl < th.high_mgdl + th.event_excursion_margin_mgdl:
            continue
        b = _B()
        e1 = b.add("excursion_minutes", _r(ex.minutes), "min")
        e2 = b.add("excursion_peak", _r(ex.extreme_mgdl), "mg/dL", "measured")
        claims = [f"Glucose stayed above {_r(th.high_mgdl)} mg/dL for about {_r(ex.minutes)} minutes [{e1}] starting {_hm(ex.start, tz)}, peaking at {_r(ex.extreme_mgdl)} mg/dL at {_hm(ex.extreme_at, tz)} [{e2}]."]
        meals = [m for m in snap.meals if m.status in ("confirmed", "manual_entry") and m.carbs_g is not None and timedelta(0) <= ex.start - m.t <= timedelta(minutes=th.meal_window_min)]
        if meals:
            m = max(meals, key=lambda x: x.t)
            e3 = b.add("meal_before_estimated_carbs", _r(m.carbs_g or 0), "g", "context")
            claims.append(f"A meal with about {_r(m.carbs_g or 0)} g estimated carbohydrates was logged at {_hm(m.t, tz)}, before this stay began [{e3}]; this is an association, not a cause.")
        out.append(Candidate(
            key=f"excursion:{ex.start.strftime('%Y%m%dT%H%M')}", category="glucose_excursion", trigger=trigger, window=(ex.start, ex.end),  # type: ignore[arg-type]
            facts=b.facts, claims=claims, boundaries=[NOT_ADVICE, ASSOC], limitations=_flag_limits(flags, ex.start, ex.end),
            coverage=coverage(clean, ex.start, ex.end, th), method="contiguous readings above the high reporting threshold",
            scores={"safety": 0.5, "evidence": 0.8, "recurrence": 0.0, "relevance": 0.9, "actionability": 0.4}, direction="rising",
        ))
    return out


def meal_responses(snap: Snapshot, clean: list[Reading], start: datetime, end: datetime, trigger: str) -> list[Candidate]:
    th, tz = snap.settings.th, _tz(snap)
    out = []
    for m in snap.meals:
        if m.status not in ("confirmed", "manual_entry") or m.carbs_g is None or not (start <= m.t <= end):
            continue
        w0, w1 = m.t - timedelta(minutes=th.meal_pre_min), min(m.t + timedelta(minutes=th.meal_window_min), snap.now)
        if (w1 - m.t).total_seconds() / 60 < th.meal_window_min * 0.66:
            continue  # window not mostly over: the peak may not have happened yet
        if coverage(clean, w0, w1, th) < th.min_cov_meal:
            continue
        base = F.nearest([r for r in clean if r.t <= m.t], m.t, th.meal_pre_min)
        after = [r for r in clean if m.t < r.t <= w1]
        if base is None or not after:
            continue
        peak = max(after, key=lambda r: r.mgdl)
        rise = peak.mgdl - base.mgdl
        if rise < th.meal_response_min_rise_mgdl:
            continue
        near_ins = [i for i in snap.insulin if abs((i.t - m.t).total_seconds()) <= 1800 and i.units is not None]
        b = _B()
        e1 = b.add("meal_estimated_carbs", _r(m.carbs_g), "g", "context")
        e2 = b.add("glucose_at_meal", _r(base.mgdl), "mg/dL", "measured")
        e3 = b.add("post_meal_peak", _r(peak.mgdl), "mg/dL", "measured")
        e4 = b.add("post_meal_rise", _r(rise), "mg/dL")
        e5 = b.add("minutes_to_peak", _r((peak.t - m.t).total_seconds() / 60), "min")
        claims = [f"After the meal logged at {_hm(m.t, tz)} (about {_r(m.carbs_g)} g estimated carbohydrates [{e1}]), glucose rose from {_r(base.mgdl)} mg/dL [{e2}] to a peak of {_r(peak.mgdl)} mg/dL [{e3}], {_r(rise)} mg/dL higher [{e4}], {_r((peak.t - m.t).total_seconds() / 60)} minutes later [{e5}]."]
        lim = []
        if near_ins:
            e6 = b.add("insulin_records_near_meal", len(near_ins), "count", "context")
            claims.append(f"{len(near_ins)} insulin record(s) exist within 30 minutes of the meal [{e6}]; they affect this response, so no conclusion is drawn about dosing.")
        else:
            lim.append("No insulin record with a dose exists near this meal, so insulin is not part of this explanation.")
        out.append(Candidate(
            key=f"meal:{m.id}", category="meal_response", trigger=trigger, window=(m.t, w1), facts=b.facts, claims=claims,  # type: ignore[arg-type]
            boundaries=[NOT_ADVICE, ASSOC, "Carbohydrates are an estimate."], limitations=lim, coverage=coverage(clean, w0, w1, th),
            method="glucose at the meal vs the highest reading in the following 3 hours", direction="rising",
            untrusted=[m.note] if m.note else [],
            scores={"safety": 0.4, "evidence": 0.8, "recurrence": 0.0, "relevance": 0.9, "actionability": 0.5},
        ))
    out.sort(key=lambda c: -c.facts[3].value)
    return out[:2]


def meal_response_recurring(snap: Snapshot, clean: list[Reading], d: date) -> Optional[Candidate]:
    """Same meal slot (by local hour block) rising by at least the threshold on most comparable days. Needs replication."""
    th, tz = snap.settings.th, _tz(snap)
    slots = {"breakfast": (5, 11), "lunch": (11, 16), "dinner": (16, 23)}
    best = None
    for name, (h0, h1) in slots.items():
        rises, n = [], 0
        for k in range(0, th.lookback_days + 1):
            dd = d - timedelta(days=k)
            day_meals = [m for m in snap.meals if m.status in ("confirmed", "manual_entry") and m.carbs_g is not None and h0 <= m.t.astimezone(tz).hour < h1 and m.t.astimezone(tz).date() == dd]
            if len(day_meals) != 1:
                continue
            m = day_meals[0]
            w0, w1 = m.t - timedelta(minutes=th.meal_pre_min), m.t + timedelta(minutes=th.meal_window_min)
            if w1 > snap.now or coverage(clean, w0, w1, th) < th.min_cov_meal:
                continue
            base = F.nearest([r for r in clean if r.t <= m.t], m.t, th.meal_pre_min)
            after = [r for r in clean if m.t < r.t <= w1]
            if base is None or not after:
                continue
            n += 1
            rises.append(max(r.mgdl for r in after) - base.mgdl)
        if n >= th.min_days_recurring:
            k = sum(1 for x in rises if x >= th.meal_response_min_rise_mgdl)
            if k / n >= th.recurring_fraction and (best is None or k / n > best[2]):
                best = (name, n, k / n, k, statistics.median(rises))
    if best is None:
        return None
    name, n, frac, k, med = best
    b = _B()
    e1 = b.add("comparable_days", n, "count")
    e2 = b.add("days_with_rise", k, "count")
    e3 = b.add("median_rise", _r(med), "mg/dL")
    e4 = b.add("rise_threshold", _r(th.meal_response_min_rise_mgdl), "mg/dL", "context")
    claims = [f"After {name}, glucose rose by at least {_r(th.meal_response_min_rise_mgdl)} mg/dL [{e4}] within 3 hours on {k} of {n} comparable days [{e2}, {e1}]; the median rise was {_r(med)} mg/dL [{e3}]."]
    return Candidate(
        key=f"meal_recurring:{name}:{d.isoformat()}", category="recurring_meal_response", trigger="evening", window=(snap.now - timedelta(days=th.lookback_days), snap.now),
        facts=b.facts, claims=claims, boundaries=[NOT_ADVICE, ASSOC, "Do not advise on insulin timing or dose."], limitations=[f"Based on {n} days."],
        coverage=1.0, method="post-meal rise counted across comparable days for the same meal slot",
        scores={"safety": 0.3, "evidence": min(1.0, n / 10), "recurrence": frac, "relevance": 0.9, "actionability": 0.6}, direction="rising",
    )


def data_quality(snap: Snapshot, clean: list[Reading], flags: list[Flag], trigger: str) -> Optional[Candidate]:
    th = snap.settings.th
    since = snap.now - timedelta(hours=24)
    recent = [f for f in flags if f.t and f.t >= since]
    stale_min = None
    if clean:
        age = (snap.now - clean[-1].t).total_seconds() / 60
        stale_min = age if age > 60 else None
    elif not clean:
        stale_min = None
    n_conf = sum(1 for f in recent if f.code == "conflicting_duplicates")
    n_bad = sum(1 for f in recent if f.code in ("implausible_value", "implausible_spike"))
    if not (n_conf or n_bad or stale_min):
        return None
    b = _B()
    claims = []
    if n_conf:
        claims.append(f"In the last 24 hours, {n_conf} reading time(s) carried conflicting values and were excluded [{b.add('conflicting_times', n_conf, 'count')}].")
    if n_bad:
        claims.append(f"{n_bad} implausible reading(s) were excluded [{b.add('implausible_readings', n_bad, 'count')}].")
    if stale_min:
        claims.append(f"The latest recorded reading is about {_r(stale_min)} minutes old [{b.add('latest_reading_age', _r(stale_min), 'min')}]; it is the last recorded value, not a current measurement.")
    return Candidate(
        key=f"quality:{snap.now.strftime('%Y%m%d')}:{n_conf}:{n_bad}:{int(bool(stale_min))}", category="data_quality", trigger=trigger,  # type: ignore[arg-type]
        window=(since, snap.now), facts=b.facts, claims=claims, boundaries=[NOT_ADVICE, "Excluded readings are not used in any other insight."], limitations=[],
        coverage=1.0, method="count of excluded readings and age of the latest reading", quality_flags=sorted({f.code for f in recent}),
        scores={"safety": 0.4, "evidence": 1.0, "recurrence": 0.0, "relevance": 0.7, "actionability": 0.5},
    )


# ---- gated associations (only with enough paired observations) -------------------------------------------------------
def _pearson(xs: list[float], ys: list[float]) -> Optional[float]:
    if len(xs) < 3 or statistics.pstdev(xs) == 0 or statistics.pstdev(ys) == 0:
        return None
    mx, my = statistics.fmean(xs), statistics.fmean(ys)
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / math.sqrt(sum((x - mx) ** 2 for x in xs) * sum((y - my) ** 2 for y in ys))


def exercise_association(snap: Snapshot, clean: list[Reading]) -> Optional[Candidate]:
    th = snap.settings.th
    changes = []
    for a in snap.activities:
        if a.duration_min is None:
            continue
        end = a.start + timedelta(minutes=a.duration_min)
        w1 = end + timedelta(minutes=th.activity_window_min)
        if w1 > snap.now or coverage(clean, a.start, w1, th) < th.min_cov_meal:
            continue
        c = F.change_between(clean, a.start, w1)
        if c is not None:
            changes.append(c)
    if len(changes) < th.min_pairs_association:
        return None
    b = _B()
    e1 = b.add("activities_analyzed", len(changes), "count")
    e2 = b.add("median_change_to_2h_after", _r(statistics.median(changes)), "mg/dL")
    claims = [f"Across {len(changes)} recorded activities [{e1}], glucose changed by a median of {_r(statistics.median(changes))} mg/dL from the start to 2 hours after the activity ended [{e2}]."]
    return Candidate(key=f"exercise:{snap.now.strftime('%Y%m%d')}", category="exercise_association", trigger="evening", window=(snap.now - timedelta(days=th.lookback_days), snap.now),
                     facts=b.facts, claims=claims, boundaries=[NOT_ADVICE, ASSOC], limitations=["Activity type and intensity vary and are not separated here."], coverage=1.0,
                     method="median glucose change from activity start to 2 h after it ended", scores={"safety": 0.2, "evidence": min(1.0, len(changes) / 15), "recurrence": 0.5, "relevance": 0.7, "actionability": 0.4})


def sleep_association(snap: Snapshot, clean: list[Reading]) -> Optional[Candidate]:
    th, tz = snap.settings.th, _tz(snap)
    xs, ys = [], []
    for s in snap.sleeps:
        if s.duration_min is None:
            continue
        w1 = s.end + timedelta(hours=2)
        if w1 > snap.now or coverage(clean, s.end, w1, th) < th.min_cov_overnight:
            continue
        rs = in_window(clean, s.end, w1)
        st = F.stats(rs)
        if st:
            xs.append(s.duration_min / 60.0)
            ys.append(st.mean)
    if len(xs) < th.min_pairs_association:
        return None
    r = _pearson(xs, ys)
    if r is None or abs(r) < th.min_abs_r:
        return None
    b = _B()
    e1 = b.add("nights_analyzed", len(xs), "count")
    e2 = b.add("correlation_sleep_duration_vs_morning_glucose", _r1(r), "")
    claims = [f"Across {len(xs)} nights with a sleep record [{e1}], sleep duration and the average glucose in the 2 hours after waking had a correlation of {_r1(r)} [{e2}]."]
    return Candidate(key=f"sleep:{snap.now.strftime('%Y%m%d')}", category="sleep_association", trigger="morning", window=(snap.now - timedelta(days=th.lookback_days), snap.now),
                     facts=b.facts, claims=claims, boundaries=[NOT_ADVICE, ASSOC, "Do not infer insulin resistance or any diagnosis."], limitations=[f"Only {len(xs)} nights; a correlation says nothing about cause."],
                     coverage=1.0, method="Pearson correlation of sleep duration with mean glucose in the 2 hours after waking",
                     scores={"safety": 0.1, "evidence": min(1.0, len(xs) / 15), "recurrence": abs(r), "relevance": 0.6, "actionability": 0.3})


def insulin_timing_association(snap: Snapshot, clean: list[Reading]) -> Optional[Candidate]:
    th = snap.settings.th
    offs, rises = [], []
    for m in snap.meals:
        if m.status not in ("confirmed", "manual_entry") or m.carbs_g is None:
            continue
        w1 = m.t + timedelta(minutes=th.meal_window_min)
        if w1 > snap.now or coverage(clean, m.t - timedelta(minutes=th.meal_pre_min), w1, th) < th.min_cov_meal:
            continue
        doses = [i for i in snap.insulin if i.units is not None and i.confirmed and i.kind in ("bolus", "correction") and abs((i.t - m.t).total_seconds()) <= 1800]
        base = F.nearest([r for r in clean if r.t <= m.t], m.t, th.meal_pre_min)
        after = [r for r in clean if m.t < r.t <= w1]
        if len(doses) != 1 or base is None or not after:
            continue
        offs.append((doses[0].t - m.t).total_seconds() / 60.0)
        rises.append(max(r.mgdl for r in after) - base.mgdl)
    if len(offs) < th.min_pairs_association:
        return None
    r = _pearson(offs, rises)
    if r is None or abs(r) < th.min_abs_r:
        return None
    b = _B()
    e1 = b.add("meals_with_one_confirmed_dose", len(offs), "count")
    e2 = b.add("correlation_dose_offset_vs_rise", _r1(r), "")
    claims = [f"Across {len(offs)} meals with one confirmed insulin dose within 30 minutes [{e1}], the dose time relative to the meal and the post-meal rise had a correlation of {_r1(r)} [{e2}]."]
    return Candidate(key=f"insulin_timing:{snap.now.strftime('%Y%m%d')}", category="insulin_timing_association", trigger="evening", window=(snap.now - timedelta(days=th.lookback_days), snap.now),
                     facts=b.facts, claims=claims, boundaries=[NOT_ADVICE, ASSOC, "Do not give advice about dose size or timing."], limitations=[f"Only {len(offs)} meals; meal size, type and dose size vary and are not separated."],
                     coverage=1.0, method="Pearson correlation of dose offset with post-meal rise", scores={"safety": 0.2, "evidence": min(1.0, len(offs) / 15), "recurrence": abs(r), "relevance": 0.7, "actionability": 0.3})
