"""Forecast performance: what SugarSense has learned about its OWN forecasts by comparing them with the glucose that was recorded afterwards.

Only forecasts matched to a reading near their target time are used (prediction_outcomes). Only ONE model version is judged at a time: the one most
recently issued and not marked shadow (the one the person sees). A model change therefore resets the evidence instead of mixing two models.
Neighbouring forecasts (every 5 minutes) are strongly autocorrelated, so they are NOT counted as independent: forecasts are collapsed to one value per
(local day, 3-hour block) = the median error, and the sign test runs on those blocks. The evidence level comes from evidence.grade_directional.

Never claimed: that the model "learned" something new (nothing here retrains anything), that an error has a cause, or that a single forecast was wrong
for a reason. A forecast error is a statement about the forecast, not about the person's glucose control.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import timedelta
from typing import Optional
from zoneinfo import ZoneInfo

from . import evidence as EV
from . import menus as M
from .models import Candidate, Fact, ScoredForecast, Snapshot
from .patterns import ASSOC, _B, _r, _tz

HORIZONS = (30, 60, 120, 180)       # shorter horizons carry little information; the engine's longest are 180
MIN_FORECASTS = 30                  # matched forecasts at a horizon before it is judged at all
MIN_PER_BLOCK = 3                   # forecasts inside one (day, 3 h) block for that block to count
BLOCK_HOURS = 3
LOOKBACK_DAYS = 14


def material_mgdl(horizon_min: int) -> float:
    """A median difference smaller than this is not worth a card: the forecast interval itself is wider than this at these horizons."""
    return 10.0 + horizon_min / 10.0


def current_version(snap: Snapshot) -> Optional[str]:
    live = [s for s in snap.scored if "shadow" not in s.model_version]
    if not live:
        return None
    return max(live, key=lambda s: s.anchor).model_version


def _blocks(rows: list[ScoredForecast], tz: ZoneInfo) -> list[tuple[float, float]]:
    by: dict[tuple, list[float]] = defaultdict(list)
    for s in rows:
        loc = s.anchor.astimezone(tz)
        by[(loc.date(), loc.hour // BLOCK_HOURS)].append(s.error)
    out = []
    for (d, b), errs in by.items():
        if len(errs) >= MIN_PER_BLOCK:
            out.append((float(d.toordinal() * 8 + b), EV.median(errs)))
    return out


def evaluate(snap: Snapshot) -> tuple[list[Candidate], list[str]]:
    """-> (candidates at REPEATED or above, log notes for everything that stayed EXPLORATORY or lacked data). Notes contain no health values."""
    notes: list[str] = []
    ver = current_version(snap)
    if ver is None:
        return [], ["no scored forecasts for a live model version"]
    tz = _tz(snap)
    since = snap.now - timedelta(days=LOOKBACK_DAYS)
    mine = [s for s in snap.scored if s.model_version == ver and s.anchor >= since and s.match_quality in ("exact", "nearest_within_tolerance")
            and s.anchor + timedelta(minutes=s.horizon_min) <= snap.now]   # never grade a forecast whose target time has not happened yet
    eligible: dict[int, list[ScoredForecast]] = {}
    for h in HORIZONS:
        rows = [s for s in mine if s.horizon_min == h]
        days = {s.anchor.astimezone(tz).date() for s in rows}
        if len(rows) >= MIN_FORECASTS and len(days) >= EV.MIN_DAYS:
            eligible[h] = rows
        else:
            notes.append(f"horizon {h}: {len(rows)} forecasts on {len(days)} days is below the minimum")
    if not eligible:
        return [], notes
    tests = len(eligible)           # Bonferroni family: every horizon judged in this run
    best: Optional[tuple[float, Candidate]] = None
    for h, rows in sorted(eligible.items()):
        blocks = _blocks(rows, tz)
        g = EV.grade_directional(blocks, material_mgdl(h), tests)
        if g.level == EV.EXPLORATORY:
            notes.append(f"horizon {h}: exploratory only ({g.reason})")
            continue
        cand = _candidate(snap, ver, h, rows, blocks, g, tz)
        mag = abs(EV.median([e for _, e in blocks]))
        if best is None or mag > best[0]:
            best = (mag, cand)
    return ([best[1]] if best else []), notes


def forecast_performance(snap: Snapshot) -> Optional[Candidate]:
    c, _ = evaluate(snap)
    return c[0] if c else None


def _candidate(snap: Snapshot, ver: str, h: int, rows: list[ScoredForecast], blocks: list[tuple[float, float]], g: EV.Graded, tz: ZoneInfo) -> Candidate:
    effects = [e for _, e in blocks]
    med = EV.median(effects)
    higher_than_recorded = med > 0              # observed above predicted: the FORECAST was lower
    k = sum(1 for e in effects if (e > 0) == higher_than_recorded and e != 0)
    days = len({s.anchor.astimezone(tz).date() for s in rows})
    level_pct = _r(100 * EV.median([s.interval_level for s in rows]))
    cov = _r(100 * sum(1 for s in rows if s.inside) / len(rows))
    b = _B()
    r_h, r_n, r_m, r_k, r_d, r_lvl, r_cov = (b.add("horizon", h, "min"), b.add("forecasts_matched", len(rows), "count"), b.add("comparison_periods", len(blocks), "count"),
                                              b.add("periods_same_direction", k, "count"), b.add("median_difference", _r(abs(med)), "mg/dL"), b.add("interval_level", level_pct, "%"),
                                              b.add("interval_coverage", cov, "%"))
    r_days = b.add("days", days, "count")
    word = "lower" if higher_than_recorded else "higher"
    claims = [
        f"Over the last {days} days [{r_days}], {len(blocks)} [{r_m}] comparison periods of your {h}-minute [{r_h}] forecasts could be checked against the glucose recorded afterwards, using {len(rows)} [{r_n}] matched forecasts.",
        f"In {k} [{r_k}] of those periods the forecast was {word} than what was recorded, by a median of {_r(abs(med))} mg/dL [{r_d}].",
        f"The forecast's own {level_pct}% [{r_lvl}] range contained the recorded value for {cov}% [{r_cov}] of the individual forecasts.",
    ]
    limits = [
        f"Neighbouring forecasts are not independent, so they were grouped into {BLOCK_HOURS}-hour periods per day before counting.",
        "Only forecasts that could be matched to a reading recorded close to their target time are included, and only the model version you currently see.",
    ]
    if g.level == EV.REPEATED:
        limits.append("The pattern is consistent over the whole period but has not been confirmed in both halves of it.")
    risky = not higher_than_recorded            # forecasts ran higher than recorded glucose: lows may be missed
    return Candidate(
        key=f"forecast_performance:{ver}:{h}:{word}", category="forecast_performance", trigger="evening", window=(min(s.anchor for s in rows), max(s.anchor for s in rows) + timedelta(minutes=h)),
        facts=b.facts, claims=claims,
        boundaries=[ASSOC, "This is about how accurate the forecast has been, not about your glucose control. The forecast is not an alert and is never used to calculate a dose."],
        limitations=limits, coverage=1.0, method=f"sign test over {BLOCK_HOURS}-hour comparison periods of forecast error (recorded minus forecast), corrected for the number of horizons judged, {g.reason}",
        scores={"safety": 0.5 if risky else 0.35, "evidence": 0.9 if g.level == EV.VALIDATED else 0.6, "recurrence": 0.8, "relevance": 0.7, "actionability": 0.3},
        suggestions=[M.LOG_CONTEXT], python_only=True, evidence_level=g.level, pattern_id=f"forecast_bias:{ver}:{h}:{word}",
    )
