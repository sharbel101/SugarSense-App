"""Detectors that give the model something worth reasoning about: unexplained highs, lows after doses, lows after activity.

Each returns candidates whose facts are computed here and whose menus (menus.py) say which hedged explanations and gentle suggestions the model
may use. A detector returns nothing when the sources it needs do not exist: "no meal record" is only ever said when meals ARE being logged at all.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Optional

from . import features as F
from . import menus as M
from .episodes import LOW_NOTE
from .models import Candidate, Reading, Snapshot
from .patterns import ASSOC, NOT_ADVICE, _B, _flag_limits, _hm, _r, _r1, _tz
from .quality import Flag, coverage


def _hours(a: datetime, b: datetime) -> float:
    return (b - a).total_seconds() / 3600.0


def _local_minutes(dt: datetime, tz) -> int:
    d = dt.astimezone(tz)
    return d.hour * 60 + d.minute


def unexplained_high(snap: Snapshot, clean: list[Reading], flags: list[Flag], start: datetime, end: datetime, trigger: str) -> list[Candidate]:
    """A stay above range that started with no meal and no insulin record in the preceding hours. Only when meals are being logged at all."""
    th, tz = snap.settings.th, _tz(snap)
    meals = [m for m in snap.meals if m.status in ("confirmed", "manual_entry") and m.carbs_g is not None]
    if not meals:
        return []   # without meal records, "nothing was eaten" is unknowable
    doses = [i for i in snap.insulin if i.kind in ("bolus", "correction", "basal", "other")]
    end = min(end, snap.now)
    stays = F.excursions(clean, start, end, th)
    cut = th.high_mgdl + 0.5 * th.event_excursion_margin_mgdl
    cands = [x for x in stays if x.kind == "above" and x.extreme_mgdl >= cut]
    out = []
    unexplained = []
    for ex in sorted(cands, key=lambda x: -x.extreme_mgdl):       # filter FIRST, then keep the highest of the unexplained stays
        w0 = ex.start - timedelta(hours=th.fasting_hours)
        if any(w0 <= m.t <= ex.start for m in meals):
            continue
        if doses and any(w0 <= i.t <= ex.start for i in doses if i.kind != "basal"):
            continue
        unexplained.append(ex)
    for ex in unexplained[:1]:
        b = _B()
        e1 = b.add("episode_peak", _r(ex.extreme_mgdl), "mg/dL", "measured")
        e2 = b.add("episode_minutes", _r(ex.minutes), "min")
        e3 = b.add("hours_without_records", th.fasting_hours, "h", "context")
        recs = "no meal record and no insulin record" if doses else "no meal record"
        claims = [f"The stay above range that began at {_hm(ex.start, tz)} and reached {_r(ex.extreme_mgdl)} mg/dL [{e1}], lasting about {_r(ex.minutes)} minutes [{e2}], had {recs} in the {th.fasting_hours} hours before it [{e3}]."]
        before = [m for m in meals if m.t < ex.start]
        if before:
            lm = max(before, key=lambda x: x.t)
            claims.append(f"The last logged meal was about {_r(_hours(lm.t, ex.start))} hours earlier [{b.add('hours_since_last_meal', _r(_hours(lm.t, ex.start)), 'h', 'context')}].")
        # similar stays at the same time of day on other days (within 90 minutes of this start)
        tm = _local_minutes(ex.start, tz)
        k = n = 0
        d0 = ex.start.astimezone(tz).date()
        for back in range(1, th.lookback_days + 1):
            dd = d0 - timedelta(days=back)
            s = F.local_dt(dd, F.hhmm(f"{(tm // 60):02d}:{(tm % 60):02d}"), tz)
            ws, we = s - timedelta(minutes=90), s + timedelta(minutes=90)
            if we > snap.now or coverage(clean, ws, we, th) < 0.6:
                continue
            n += 1
            if any(x.kind == "above" and ws <= x.start <= we for x in F.excursions(clean, ws - timedelta(hours=3), we, th)):
                k += 1
        if n >= 3 and k >= 2:
            claims.append(f"A stay above range began within 90 minutes [{b.add('similar_window_minutes', 90, 'min', 'context')}] of this time on {k} of {n} other days with readings [{b.add('similar_days', k, 'count')}, {b.add('similar_days_covered', n, 'count')}].")
        morning = 3 <= ex.start.astimezone(tz).hour < 11
        setting = bool(snap.therapy.get("morning_resistance")) and morning
        if setting:
            b.add("morning_resistance_setting", "on", "", "context")
            claims.append("Your own settings have the morning insulin-resistance option switched on.")
        expl, sugg = M.MORNING_PATTERN_WITH_SETTING if setting else M.UNEXPLAINED_HIGH
        if setting:
            expl = list(expl) + [M.INSULIN_EFFECTIVENESS, M.STRESS_ILLNESS_SLEEP]
            sugg = list(sugg) + [M.CHECK_INSULIN_STORAGE]
        lim = []
        if not doses:
            lim.append("No insulin records exist, so nothing is said about insulin around this stay.")
        out.append(Candidate(
            key=f"unexplained_high:{ex.start.strftime('%Y%m%dT%H%M')}", category="unexplained_high", trigger=trigger, window=(ex.start, ex.end),  # type: ignore[arg-type]
            facts=b.facts, claims=claims, boundaries=[NOT_ADVICE, ASSOC, "These are possibilities to look into, not findings. Do not state a cause as fact, a dose, or an exact timing."],
            limitations=lim + _flag_limits(flags, ex.start, ex.end), coverage=coverage(clean, ex.start, ex.end, th),
            method="a stay above range with no logged meal and no logged insulin in the hours before it",
            explanations=list(expl), suggestions=list(sugg), direction="rising",
            scores={"safety": 0.6, "evidence": 0.7, "recurrence": (k / n) if n else 0.0, "relevance": 1.0, "actionability": 0.9}))
    return out


def low_after_dose(snap: Snapshot, clean: list[Reading], flags: list[Flag], start: datetime, end: datetime, trigger: str) -> list[Candidate]:
    """A stay below range that started 1 to 5 hours after a bolus/correction record. Described after the fact; never an alert."""
    th, tz = snap.settings.th, _tz(snap)
    doses = [i for i in snap.insulin if i.kind in ("bolus", "correction")]
    if not doses:
        return []
    end = min(end, snap.now)
    lows = [x for x in F.excursions(clean, start, end, th) if x.kind == "below"]
    out = []
    for ex in sorted(lows, key=lambda x: x.extreme_mgdl)[:1]:
        dd = [i for i in doses if 1.0 <= _hours(i.t, ex.start) <= th.low_after_dose_hours]
        if not dd:
            continue
        d = max(dd, key=lambda i: i.t)
        meals_near = [m for m in snap.meals if m.carbs_g is not None and m.status in ("confirmed", "manual_entry") and abs((m.t - d.t).total_seconds()) <= th.dose_context_min * 60]
        b = _B()
        e1 = b.add("low_value", _r(ex.extreme_mgdl), "mg/dL", "measured")
        e2 = b.add("hours_after_dose", _r1(_hours(d.t, ex.start)), "h")
        e3 = b.add("low_minutes", _r(ex.minutes), "min")
        claims = [f"A stay below {_r(th.low_mgdl)} mg/dL began at {_hm(ex.start, tz)}, {_r1(_hours(d.t, ex.start))} hours after an insulin dose was logged [{e2}], reached {_r(ex.extreme_mgdl)} mg/dL [{e1}] and lasted about {_r(ex.minutes)} minutes [{e3}]."]
        if meals_near:
            m = min(meals_near, key=lambda x: abs((x.t - d.t).total_seconds()))
            claims.append(f"A meal with about {_r(m.carbs_g or 0)} g estimated carbohydrates was logged near that dose [{b.add('meal_carbs_near_dose', _r(m.carbs_g or 0), 'g', 'context')}].")
        # how often does a dose in this record set precede a low within the window?
        n = k = 0
        for x in doses:
            if x.t + timedelta(hours=th.low_after_dose_hours) > snap.now:
                continue
            n += 1
            s2, e2_ = x.t + timedelta(hours=1), x.t + timedelta(hours=th.low_after_dose_hours)
            if any(l.kind == "below" and s2 <= l.start <= e2_ for l in F.excursions(clean, s2 - timedelta(hours=1), e2_ + timedelta(hours=1), th)):
                k += 1
        if n >= 4 and k >= 2:
            claims.append(f"{k} of {n} logged doses were followed by a stay below range within {th.low_after_dose_hours} hours [{b.add('doses_followed_by_low', k, 'count')}, {b.add('doses_checked', n, 'count')}].")
        expl, sugg = M.LOW_AFTER_DOSE
        out.append(Candidate(
            key=f"low_after_dose:{ex.start.strftime('%Y%m%dT%H%M')}", category="low_after_dose", trigger=trigger, window=(d.t, ex.end),  # type: ignore[arg-type]
            facts=b.facts, claims=claims, boundaries=[NOT_ADVICE, ASSOC, LOW_NOTE, "Possibilities only. Never state a dose, units, or tell the reader to change a dose."],
            limitations=_flag_limits(flags, ex.start, ex.end), coverage=coverage(clean, ex.start, ex.end, th), method="a stay below range starting 1 to 5 hours after a logged dose",
            explanations=list(expl), suggestions=list(sugg), direction="falling",
            scores={"safety": 1.0, "evidence": 0.7, "recurrence": (k / n) if n else 0.0, "relevance": 1.0, "actionability": 0.8}))
    return out


def post_activity_low(snap: Snapshot, clean: list[Reading], flags: list[Flag], start: datetime, end: datetime, trigger: str) -> list[Candidate]:
    """A stay below range that started within hours after an activity record ended. Needs activity records with a duration."""
    th, tz = snap.settings.th, _tz(snap)
    acts = [a for a in snap.activities if a.duration_min is not None]
    if not acts:
        return []
    end = min(end, snap.now)
    lows = [x for x in F.excursions(clean, start, end, th) if x.kind == "below"]
    out = []
    for ex in sorted(lows, key=lambda x: x.extreme_mgdl)[:1]:
        cand = [a for a in acts if 0 <= _hours(a.start + timedelta(minutes=a.duration_min or 0), ex.start) <= th.post_activity_hours]
        if not cand:
            continue
        a = max(cand, key=lambda x: x.start)
        gap = _hours(a.start + timedelta(minutes=a.duration_min or 0), ex.start)
        b = _B()
        e1 = b.add("low_value", _r(ex.extreme_mgdl), "mg/dL", "measured")
        e2 = b.add("hours_after_activity", _r1(gap), "h")
        e3 = b.add("low_minutes", _r(ex.minutes), "min")
        claims = [f"A stay below {_r(th.low_mgdl)} mg/dL began at {_hm(ex.start, tz)}, {_r1(gap)} hours after an activity record ended [{e2}], reached {_r(ex.extreme_mgdl)} mg/dL [{e1}] and lasted about {_r(ex.minutes)} minutes [{e3}]."]
        n = k = 0
        for x in acts:
            xe = x.start + timedelta(minutes=x.duration_min or 0)
            if xe + timedelta(hours=th.post_activity_hours) > snap.now:
                continue
            n += 1
            if any(l.kind == "below" and xe <= l.start <= xe + timedelta(hours=th.post_activity_hours) for l in F.excursions(clean, xe - timedelta(hours=1), xe + timedelta(hours=th.post_activity_hours + 1), th)):
                k += 1
        if n >= 3 and k >= 2:
            claims.append(f"{k} of {n} recorded activities were followed by a stay below range within {th.post_activity_hours} hours [{b.add('activities_followed_by_low', k, 'count')}, {b.add('activities_checked', n, 'count')}].")
        expl, sugg = M.POST_ACTIVITY_LOW
        out.append(Candidate(
            key=f"post_activity_low:{ex.start.strftime('%Y%m%dT%H%M')}", category="post_activity_low", trigger=trigger, window=(a.start, ex.end),  # type: ignore[arg-type]
            facts=b.facts, claims=claims, boundaries=[NOT_ADVICE, ASSOC, LOW_NOTE, "Possibilities only; do not name the activity type, give a dose, or tell the reader what to eat or do."],
            limitations=_flag_limits(flags, ex.start, ex.end), coverage=coverage(clean, ex.start, ex.end, th), method="a stay below range starting within hours after a recorded activity",
            explanations=list(expl), suggestions=list(sugg), direction="falling",
            scores={"safety": 1.0, "evidence": 0.7, "recurrence": (k / n) if n else 0.0, "relevance": 1.0, "actionability": 0.8}))
    return out
