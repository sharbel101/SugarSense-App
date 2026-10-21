"""Episode-first detectors: only stays outside the reporting range matter; covered time outside them counts as in range.

Time WITHOUT readings is unknown, not "in range", and the text says so. Each extra source (meals, insulin, activity) adds context only when records
exist; with glucose alone the digest and time-of-day pattern still produce insights. Lows are described after the fact, never as an alert.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Optional

from . import features as F
from .models import Candidate, Reading, Snapshot
from .patterns import ASSOC, NOT_ADVICE, _B, _flag_limits, _hm, _r, _tz
from .quality import Flag, coverage, in_window

LOW_NOTE = "Lows are described after the fact. This is not a safety alert; real-time low alerts come from the existing alert system."


def _severity(ex: F.Excursion, th) -> float:
    return (1000 + (th.low_mgdl - ex.extreme_mgdl)) if ex.kind == "below" else (ex.extreme_mgdl - th.high_mgdl)


def episode_digest(snap: Snapshot, clean: list[Reading], flags: list[Flag], start: datetime, end: datetime, label: str, key: str, trigger: str) -> Optional[Candidate]:
    """Counts, durations and worst values of the stays above/below range in a window. Needs only glucose."""
    th, tz = snap.settings.th, _tz(snap)
    end = min(end, snap.now)
    rs = in_window(clean, start, end)
    cov = coverage(clean, start, end, th)
    if len(rs) < th.min_readings_episode or cov < th.min_cov_episode:
        return None
    exs = F.excursions(clean, start, end, th)
    hi = [x for x in exs if x.kind == "above"]
    lo = [x for x in exs if x.kind == "below"]
    b = _B()
    e_cov = b.add("coverage", _r(cov * 100), "%")
    n_note = f"Stays shorter than {th.excursion_min_minutes} minutes are not counted; time without readings is unknown, not assumed in range."
    if not exs:
        e0 = b.add("episodes", 0, "count")
        claims = [f"{label}: no stay outside {_r(th.low_mgdl)}-{_r(th.high_mgdl)} mg/dL lasting at least {th.excursion_min_minutes} minutes [{e0}] was found in a period where readings covered {_r(cov * 100)}% of the time [{e_cov}]."]
        score_safety = 0.05
    else:
        e_nh = b.add("episodes_above", len(hi), "count")
        e_mh = b.add("minutes_above", _r(sum(x.minutes for x in hi)), "min")
        e_nl = b.add("episodes_below", len(lo), "count")
        e_ml = b.add("minutes_below", _r(sum(x.minutes for x in lo)), "min")
        claims = [f"{label}: {len(hi)} stay(s) above {_r(th.high_mgdl)} mg/dL [{e_nh}] totalling about {_r(sum(x.minutes for x in hi))} minutes [{e_mh}], and {len(lo)} below {_r(th.low_mgdl)} mg/dL [{e_nl}] totalling about {_r(sum(x.minutes for x in lo))} minutes [{e_ml}], in a period where readings covered {_r(cov * 100)}% of the time [{e_cov}]. Covered time outside these stays was in range."]
        if hi:
            w = max(hi, key=lambda x: x.extreme_mgdl)
            r1 = b.add("highest_peak", _r(w.extreme_mgdl), "mg/dL", "measured")
            r2 = b.add("highest_peak_stay_minutes", _r(w.minutes), "min")
            claims.append(f"The highest stay peaked at {_r(w.extreme_mgdl)} mg/dL at {_hm(w.extreme_at, tz)} [{r1}] and lasted about {_r(w.minutes)} minutes [{r2}].")
        if lo:
            w = min(lo, key=lambda x: x.extreme_mgdl)
            r1 = b.add("lowest_value", _r(w.extreme_mgdl), "mg/dL", "measured")
            r2 = b.add("lowest_stay_minutes", _r(w.minutes), "min")
            claims.append(f"The lowest stay reached {_r(w.extreme_mgdl)} mg/dL at {_hm(w.extreme_at, tz)} [{r1}] and lasted about {_r(w.minutes)} minutes [{r2}].")
        score_safety = 1.0 if lo else 0.5
    return Candidate(
        key=key, category="episode_digest", trigger=trigger, window=(start, end), facts=b.facts, claims=claims,  # type: ignore[arg-type]
        boundaries=[NOT_ADVICE, ASSOC, LOW_NOTE] if lo else [NOT_ADVICE, ASSOC], limitations=[n_note] + _flag_limits(flags, start, end), coverage=cov,
        method="stays outside the reporting range lasting at least the minimum duration; covered time outside them counted as in range",
        quality_flags=sorted({f.code for f in flags}),
        scores={"safety": score_safety, "evidence": cov, "recurrence": 0.0, "relevance": 0.9, "actionability": 0.4},
    )


def episode_context(snap: Snapshot, clean: list[Reading], flags: list[Flag], start: datetime, end: datetime, trigger: str) -> list[Candidate]:
    """For the most significant stays, list the meal / insulin / activity records in the hours before them. Only sources that exist are mentioned."""
    th, tz = snap.settings.th, _tz(snap)
    end = min(end, snap.now)
    exs = sorted(F.excursions(clean, start, end, th), key=lambda x: -_severity(x, th))[:2]
    meals = [m for m in snap.meals if m.status in ("confirmed", "manual_entry") and m.carbs_g is not None]
    doses, acts = list(snap.insulin), list(snap.activities)
    has = {"meals": bool(meals), "insulin": bool(doses), "activity": bool(acts)}
    if not any(has.values()):
        return []   # glucose only: nothing to add beside the digest; no link is invented
    hours = _r(th.context_before_min / 60)
    out = []
    for ex in exs:
        w0 = ex.start - timedelta(minutes=th.context_before_min)
        b = _B()
        word = "above" if ex.kind == "above" else "below"
        ext = b.add("episode_extreme", _r(ex.extreme_mgdl), "mg/dL", "measured")
        e_h = b.add("context_window_hours", hours, "h", "context")
        parts, lim = [], []
        if has["meals"]:
            mm = [m for m in meals if w0 <= m.t <= ex.start]
            if mm:
                m = max(mm, key=lambda x: x.t)
                mins = _r((ex.start - m.t).total_seconds() / 60)
                e1 = b.add("meal_minutes_before_start", mins, "min", "context")
                e2 = b.add("meal_estimated_carbs", _r(m.carbs_g or 0), "g", "context")
                parts.append(f"a meal logged {mins} minutes before it [{e1}] with about {_r(m.carbs_g or 0)} g estimated carbohydrates [{e2}]")
            else:
                parts.append("no meal record")
        else:
            lim.append("No meal records exist, so no link to meals is described.")
        if has["insulin"]:
            dd = [i for i in doses if w0 <= i.t <= ex.start]
            if dd:
                parts.append(f"{len(dd)} insulin record(s) [{b.add('insulin_records_before', len(dd), 'count', 'context')}]")
            else:
                parts.append("no insulin record")
        else:
            lim.append("No insulin records exist, so no link to insulin is described.")
        if has["activity"]:
            aa = [a for a in acts if w0 <= a.start <= ex.start]
            if aa:
                parts.append(f"{len(aa)} activity record(s) [{b.add('activity_records_before', len(aa), 'count', 'context')}]")
            else:
                parts.append("no activity record")
        else:
            lim.append("No activity records exist, so no link to activity is described.")
        claim = (f"The stay {word} range that began at {_hm(ex.start, tz)} and reached {_r(ex.extreme_mgdl)} mg/dL [{ext}] had, in the {hours} hours before it [{e_h}]: "
                 + "; ".join(parts) + ". This is a list of records, not a cause.")
        out.append(Candidate(
            key=f"episode_ctx:{ex.kind}:{ex.start.strftime('%Y%m%dT%H%M')}", category="episode_context", trigger=trigger, window=(ex.start, ex.end),  # type: ignore[arg-type]
            facts=b.facts, claims=[claim], boundaries=[NOT_ADVICE, ASSOC, "Only recorded events are listed; do not infer unrecorded meals, insulin or activity."] + ([LOW_NOTE] if ex.kind == "below" else []),
            limitations=lim + _flag_limits(flags, ex.start, ex.end), coverage=coverage(clean, ex.start, ex.end, th), method="records in the hours before a stay outside the range",
            scores={"safety": 1.0 if ex.kind == "below" else 0.5, "evidence": 0.7, "recurrence": 0.0, "relevance": 0.9, "actionability": 0.5},
            direction="rising" if ex.kind == "above" else "falling"))
    return out


def episode_time_pattern(snap: Snapshot, clean: list[Reading], d: date, trigger: str) -> Optional[Candidate]:
    """Stays that start in the same 3-hour block of the day on several distinct days. Worded 'seen on k of n days', never a cause."""
    th, tz = snap.settings.th, _tz(snap)
    best: dict[str, tuple[int, int, int]] = {}   # kind -> (k, n, block_start_hour)
    first = d
    lookback_start = F.local_dt(d - timedelta(days=th.lookback_days), F.hhmm("00:00"), tz) - timedelta(hours=3)
    all_stays = F.excursions(clean, lookback_start, snap.now, th)          # computed once, then bucketed
    starts = {k: [x.start for x in all_stays if x.kind == k] for k in ("above", "below")}
    blocks = []                                                            # (blk, day, s, e) for blocks that are over and well covered
    for blk in range(0, 24, 3):
        for back in range(0, th.lookback_days + 1):
            dd = d - timedelta(days=back)
            s = F.local_dt(dd, F.hhmm(f"{blk:02d}:00"), tz)
            e = s + timedelta(hours=3)
            if e <= snap.now and coverage(clean, s, e, th) >= 0.6:
                blocks.append((blk, dd, s, e))
    for blk in range(0, 24, 3):
        mine = [(dd, s, e) for b_, dd, s, e in blocks if b_ == blk]
        for kind in ("above", "below"):
            hit_days = [dd for dd, s, e in mine if any(s <= t < e for t in starts[kind])]
            k, n = len(hit_days), len(mine)
            if k >= th.min_days_episode_pattern and k / max(n, 1) >= th.recurring_fraction and (kind not in best or k > best[kind][0]):
                best[kind] = (k, n, blk)
                first = min([first] + hit_days)
    if not best:
        return None
    b = _B()
    claims = []
    for kind, (k, n, blk) in sorted(best.items()):
        word = "above" if kind == "above" else "below"
        e_k = b.add(f"days_with_stay_{word}", k, "count")
        e_n = b.add(f"covered_days_{word}", n, "count")
        e_h = b.add(f"block_start_{word}", f"{blk:02d}:00", "", "context")
        claims.append(f"A stay {word} range began between {blk:02d}:00 and {(blk + 3) % 24:02d}:00 on {k} of {n} days with readings in that period [{e_k}, {e_n}, {e_h}].")
    lows = "below" in best
    return Candidate(
        key=f"episode_time:{d.isoformat()}", category="episode_time_pattern", trigger=trigger, window=(F.local_dt(first, F.hhmm("00:00"), tz), snap.now),  # type: ignore[arg-type]
        facts=b.facts, claims=claims, boundaries=[NOT_ADVICE, ASSOC, "Do not name a cause or advise on timing, insulin or food."] + ([LOW_NOTE] if lows else []),
        limitations=["Seen on a small number of days; this is an observation, not an established pattern."], coverage=1.0,
        method="stays outside the range counted per 3-hour block of the local day across days with enough readings",
        scores={"safety": 0.8 if lows else 0.4, "evidence": min(1.0, max(v[0] for v in best.values()) / 7), "recurrence": max(v[0] / v[1] for v in best.values()), "relevance": 0.9, "actionability": 0.5})
