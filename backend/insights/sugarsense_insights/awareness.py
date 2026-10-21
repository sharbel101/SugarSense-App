"""Looking ahead and looking wider: insulin and carbohydrate still active, a glucose heading low, lows that keep coming back, and wearable context.

`heading_low` is written entirely in Python (fixed wording, never the model): it is time-critical, it concerns the one thing the reader should not be
left guessing about, and the model takes minutes. It is a rough estimate from the logged records, says so, and never gives an amount or a dose.
Real-time low alerts stay in the alert system; this card only adds the context.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Optional

from . import menus as M
from .models import Candidate, Reading, Snapshot
from .patterns import ASSOC, NOT_ADVICE, _B, _flag_limits, _r, _r1, _tz
from .quality import Flag, coverage


def insulin_on_board(snap: Snapshot, at: Optional[datetime] = None) -> Optional[float]:
    """Units of bolus/correction insulin still active by a straight-line 5 hour decay. None when no dose records exist at all (unknown, not zero)."""
    th, at = snap.settings.th, at or snap.now
    doses = [i for i in snap.insulin if i.kind in ("bolus", "correction") and i.units is not None]
    if not doses:
        return None
    span = th.insulin_action_hours * 3600.0
    return round(sum(i.units * max(0.0, 1.0 - (at - i.t).total_seconds() / span) for i in doses if i.t <= at), 2)


def carbs_on_board(snap: Snapshot, at: Optional[datetime] = None) -> Optional[float]:
    """Grams of logged carbohydrate still absorbing by a straight-line 3 hour decay. None when no meal records exist at all."""
    th, at = snap.settings.th, at or snap.now
    meals = [m for m in snap.meals if m.status in ("confirmed", "manual_entry") and m.carbs_g is not None]
    if not meals:
        return None
    span = th.carb_absorb_hours * 3600.0
    return round(sum(m.carbs_g * max(0.0, 1.0 - (at - m.t).total_seconds() / span) for m in meals if m.t <= at), 1)


def heading_low(snap: Snapshot, clean: list[Reading], flags: list[Flag]) -> list[Candidate]:
    """Glucose already near the low end and falling, insulin still active and little carbohydrate left to absorb. Needs fresh readings and insulin records."""
    th = snap.settings.th
    if not clean:
        return []
    last = clean[-1]
    if (snap.now - last.t).total_seconds() > th.stale_minutes * 60 or last.mgdl < th.low_mgdl or last.mgdl > th.heading_low_max_mgdl:
        return []   # no fresh reading, already low (the alert system's job) or not low-ish: nothing to say
    back = [r for r in clean if timedelta(0) <= last.t - r.t <= timedelta(minutes=th.heading_low_minutes + 3)]
    if len(back) < 3:
        return []
    first = min(back, key=lambda r: r.t)
    minutes = (last.t - first.t).total_seconds() / 60.0
    if minutes < 10:
        return []
    slope = (last.mgdl - first.mgdl) / minutes
    iob, cob = insulin_on_board(snap), carbs_on_board(snap)
    if iob is None or iob < th.heading_low_min_iob or (cob is not None and cob > th.heading_low_max_cob_g):
        return []
    fc = [p for p in snap.forecast if 0 < p.horizon_min <= 60]
    fc_fresh = bool(fc) and (snap.now - fc[0].anchor).total_seconds() <= th.forecast_max_age_min * 60
    fc_low = [p for p in fc if p.predicted_mgdl < th.low_mgdl] if fc_fresh else []
    if slope > th.heading_low_slope and not fc_low:
        return []
    b = _B()
    e1 = b.add("latest_glucose", _r(last.mgdl), "mg/dL", "measured")
    e2 = b.add("fall_minutes", _r(minutes), "min")
    e3 = b.add("fall_mgdl", _r(max(0.0, first.mgdl - last.mgdl)), "mg/dL")
    e4 = b.add("insulin_still_active_estimate", _r1(iob), "units", "estimated")
    if cob is not None:
        food = f" and about {_r(cob)} g of carbohydrate may still be absorbing [{b.add('carbs_still_absorbing_estimate', _r(cob), 'g', 'estimated')}]."
    else:
        food = "; no meals are logged, so food still to come is unknown."
    claims = [f"Your latest reading is {_r(last.mgdl)} mg/dL [{e1}], down {_r(max(0.0, first.mgdl - last.mgdl))} mg/dL [{e3}] over the last {_r(minutes)} minutes [{e2}].",
              f"By a rough estimate from your logged records, about {_r1(iob)} units of insulin may still be active [{e4}]{food}"]
    if fc_low:
        p = min(fc_low, key=lambda x: x.predicted_mgdl)
        claims.append(f"The latest forecast has {_r(p.predicted_mgdl)} mg/dL [{b.add('forecast_value', _r(p.predicted_mgdl), 'mg/dL', 'forecast')}] in {p.horizon_min} minutes "
                      f"[{b.add('forecast_horizon', p.horizon_min, 'min', 'forecast')}], below {_r(th.low_mgdl)} mg/dL.")
    claims.append("With insulin still active and little food left to absorb, glucose could keep falling. A small snack of fast-acting carbohydrate is what people usually "
                  "reach for in this situation; follow the low-glucose plan your care team has given you.")
    lim = ["The insulin and carbohydrate still active are rough estimates from straight-line curves over your logged records; food or insulin that was not logged is not counted.",
           "This is not an alert and does not replace the alert system or your own symptoms."]
    return [Candidate(
        key=f"heading_low:{int(snap.now.timestamp() // 3600)}", category="heading_low", trigger="event", window=(first.t, last.t),
        facts=b.facts, claims=claims, boundaries=[NOT_ADVICE], limitations=lim + _flag_limits(flags, first.t, last.t), coverage=coverage(clean, first.t, last.t, th),
        method="a falling glucose near the low end of the range with insulin still active by a rough estimate", direction="falling", python_only=True, ttl_min=th.heading_low_ttl_min,
        scores={"safety": 1.0, "evidence": 0.6, "recurrence": 0.0, "relevance": 1.0, "actionability": 1.0})]


def _low_episodes(clean: list[Reading], start: datetime, end: datetime, th) -> list[tuple[datetime, datetime, float]]:
    """Separate stays below the low threshold (at least two readings; readings more than low_gap_min apart start a new one): (start, end, lowest)."""
    out: list[list] = []
    for r in (x for x in clean if start <= x.t <= end and x.mgdl < th.low_mgdl):
        if out and (r.t - out[-1][1]) <= timedelta(minutes=th.low_gap_min):
            out[-1][1] = r.t
            out[-1][2] = min(out[-1][2], r.mgdl)
            out[-1][3] += 1
        else:
            out.append([r.t, r.t, r.mgdl, 1])
    return [(a, b, lo) for a, b, lo, n in out if n >= 2]


def frequent_lows(snap: Snapshot, clean: list[Reading], flags: list[Flag], d) -> list[Candidate]:
    th, tz = snap.settings.th, _tz(snap)
    end = snap.now
    start = end - timedelta(days=th.frequent_lows_days)
    if coverage(clean, start, end, th) < 0.5:
        return []
    lows = _low_episodes(clean, start, end, th)
    days = {a.astimezone(tz).date() for a, _, _ in lows}
    if len(lows) < th.frequent_lows_min or len(days) < th.frequent_lows_min_days:
        return []
    lowest = _r(min(lo for _, _, lo in lows))
    b = _B()
    e1 = b.add("lows_count", len(lows), "count")
    e2 = b.add("lows_days", len(days), "count")
    e3 = b.add("lows_window_days", th.frequent_lows_days, "days", "context")
    e4 = b.add("lowest_value", lowest, "mg/dL", "measured")
    claims = [f"There were {len(lows)} separate stays below {_r(th.low_mgdl)} mg/dL [{e1}] on {len(days)} different days [{e2}] in the last {th.frequent_lows_days} days [{e3}], "
              f"the lowest reaching {lowest} mg/dL [{e4}]."]
    blocks: dict[int, int] = {}
    for a, _, _ in lows:
        h = a.astimezone(tz).hour // 3
        blocks[h] = blocks.get(h, 0) + 1
    top, cnt = max(blocks.items(), key=lambda kv: kv[1])
    if cnt >= 2 and cnt / len(lows) >= 0.5:
        claims.append(f"{cnt} of them began between {top * 3:02d}:00 and {top * 3 + 3:02d}:00 [{b.add('lows_in_block', cnt, 'count')}].")
    doses = [i for i in snap.insulin if i.kind in ("bolus", "correction")]
    if doses:
        k = sum(1 for a, _, _ in lows if any(1.0 <= (a - i.t).total_seconds() / 3600.0 <= th.low_after_dose_hours for i in doses))
        if k >= 2:
            claims.append(f"{k} of them began 1 to {th.low_after_dose_hours} hours after a logged dose [{b.add('lows_after_dose', k, 'count')}].")
    expl, sugg = M.FREQUENT_LOWS
    return [Candidate(
        key=f"frequent_lows:{d.isoformat()}", category="frequent_lows", trigger="morning", window=(start, end),
        facts=b.facts, claims=claims,
        boundaries=[NOT_ADVICE, ASSOC, "Lows are described after the fact. Possibilities only. Never state a dose, units, or a food amount, and never say what will happen next."],
        limitations=_flag_limits(flags, start, end), coverage=coverage(clean, start, end, th), method="separate stays below the low threshold over the last 7 days",
        explanations=list(expl), suggestions=list(sugg), direction="falling",
        scores={"safety": 1.0, "evidence": 0.8, "recurrence": min(1.0, len(lows) / 7.0), "relevance": 1.0, "actionability": 0.9})]


def wearable_context(snap: Snapshot, at: datetime, b: _B) -> list[str]:
    """Claims about what the wearable recorded around a moment, only from samples that exist. Adds the facts to `b`."""
    th = snap.settings.th
    w0 = at - timedelta(hours=th.garmin_context_hours)
    out: list[str] = []
    stress = [w.value for w in snap.wearables if w.name == "stress_level" and w0 <= w.t <= at]
    if len(stress) >= 5:
        avg = _r(sum(stress) / len(stress))
        out.append(f"Garmin's stress score averaged {avg} out of 100 [{b.add('stress_avg_before', avg, 'score', 'wearable')}] in the {th.garmin_context_hours} hours before.")
    sleep = [w for w in snap.wearables if w.name == "sleep_duration" and w.t <= at and (at - w.t) <= timedelta(hours=36)]
    if sleep:
        h = _r1(max(sleep, key=lambda w: w.t).value / 3600.0)
        out.append(f"The night before, Garmin recorded about {h} hours of sleep [{b.add('sleep_hours_last_night', h, 'h', 'wearable')}].")
    score = [w for w in snap.wearables if w.name == "sleep_score" and w.t <= at and (at - w.t) <= timedelta(hours=36)]
    if score:
        sc = _r(max(score, key=lambda w: w.t).value)
        out.append(f"Its sleep score was {sc} out of 100 [{b.add('sleep_score_last_night', sc, 'score', 'wearable')}].")
    return out
