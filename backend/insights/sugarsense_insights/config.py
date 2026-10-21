"""Thresholds and requirements. Every number has a reason; nothing here is a clinical or treatment threshold.

The glucose range numbers are REPORTING thresholds for time-in-range style statistics. They never trigger an alert or a
treatment instruction. The low value is the app's existing configured one (mobile TARGET_MIN_MGDL / LOW_GLUCOSE_MGDL = 70);
the high default (180) is per the product owner and is overridable per user through users.profile.insights.high_mgdl so it
can follow the user's prescribed targets.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Any, Mapping

ENGINE_VERSION = "insights-0.1.0"
PROMPT_VERSION = "insight-explain-v1"
SCHEMA_VERSION = "insight-explain-v1"


@dataclass(frozen=True)
class Thresholds:
    # --- reporting thresholds (per-user override) ---------------------------------------------------------------
    low_mgdl: float = 70.0        # existing app constant; reporting only
    high_mgdl: float = 180.0      # default, per user decision; reporting only
    # --- data quality --------------------------------------------------------------------------------------------
    stale_minutes: int = 20       # same cut-off as the backend GLUCOSE_STALE_MINUTES / forecast service: a reading older than this is not "current"
    max_gap_min: int = 15         # one reading vouches for at most this much time (CGM ~5 min; 3 missed = a real gap)
    plausible_min_mgdl: float = 20.0    # DB CHECK range for glucose_readings
    plausible_max_mgdl: float = 600.0
    max_rate_mgdl_per_min: float = 10.0  # same as the forecast service's anomalous_jump guard: faster than this is a sensor artefact, not physiology
    future_tolerance_min: int = 5        # clock skew allowed before a timestamp counts as "future"
    # --- window coverage requirements (fraction of the window a reading vouches for) ----------------------------
    min_cov_overnight: float = 0.60      # an overnight window is long; allow short gaps but not a mostly-missing night
    min_cov_day: float = 0.70            # a day summary needs most of the day, else the numbers describe only a fragment
    min_cov_meal: float = 0.80           # a post-meal response needs near-continuous data, a missed peak would mislead
    min_cov_baseline_day: float = 0.70   # a prior day only joins a comparison if it is itself well covered
    # --- minimum evidence -----------------------------------------------------------------------------------------
    min_readings_summary: int = 12       # about one hour of CGM: fewer cannot support min/max/mean claims
    min_days_recurring: int = 5          # "recurring" needs replication across at least 5 comparable days (we have ~5 days of history today)
    recurring_fraction: float = 0.6      # the pattern must be present on at least 60% of comparable days
    min_days_baseline: int = 5           # baseline comparison needs 5 prior well-covered days
    baseline_delta_pct: float = 20.0     # "different from usual" = day mean or TIR moved by at least this much (relative / points)
    # --- pattern definitions --------------------------------------------------------------------------------------
    morning_rise_mgdl: float = 30.0      # rise from the pre-dawn trough to the post-wake peak that counts as a morning rise (about a quarter of the 70-180 range)
    excursion_min_minutes: int = 20      # a stay above/below range shorter than this is not reported (noise / single readings)
    # --- episode-first mode (default): the model is shown only the stays outside the range, plus whatever context records exist ---------------
    insight_mode: str = "episodes"       # "episodes" (default) or "full" (adds whole-window statistics: overnight/day summaries, baseline, morning rise)
    min_cov_episode: float = 0.50        # an episode digest needs readings for at least half the window; covered time outside episodes counts as in range, uncovered time stays unknown
    min_readings_episode: int = 6        # about 30 minutes of CGM: fewer cannot show a stay of 20 minutes at all
    context_before_min: int = 180        # records up to 3 h before an episode starts are listed next to it (same horizon as the meal absorption window)
    min_days_episode_pattern: int = 3    # "seen on k of n days" in the same 3-hour block needs 3 distinct days; weaker than the 5 days used for baselines, and worded as "seen", never "cause"
    meal_window_min: int = 180           # response window after a meal: matches the engine's meal absorption horizon (3 h)
    meal_pre_min: int = 15               # baseline glucose is taken up to 15 min before the meal
    meal_response_min_rise_mgdl: float = 40.0   # a post-meal rise smaller than this is not worth a message
    baseline_tir_points: float = 10.0    # time-in-range must move by 10 percentage points to count as different from usual
    event_excursion_margin_mgdl: float = 40.0  # an event insight for a high needs a peak at least this far above the high threshold
    min_abs_r: float = 0.5               # |Pearson r| needed before an association between two series is reported at all
    activity_window_min: int = 120
    min_pairs_association: int = 7       # sleep/exercise associations need 7 paired observations; below that it is anecdote
    # --- scheduling / lifecycle -------------------------------------------------------------------------------------
    wake: str = "07:00"                  # default morning-briefing time (local); override per user
    recap: str = "21:00"                 # default evening-recap time (local)
    overnight_start: str = "22:00"       # overnight window = previous local day 22:00 -> wake
    lookback_days: int = 14              # history loaded for baselines
    max_insights: int = 5
    event_cooldown_min: int = 120        # at most one event insight per category per 2 h
    material_change_pct: float = 15.0    # re-issue a delivered finding only if its key numbers moved this much
    scheduled_ttl_h: int = 30            # a scheduled insight is stale after about a day
    event_ttl_h: int = 6
    forecast_max_age_min: int = 20       # a forecast older than this is not "the current forecast"


@dataclass(frozen=True)
class LlmConfig:
    url: str = "http://127.0.0.1:8181"
    timeout_s: int = 240          # existing benchmark: ~2 min for 590 tokens; with ~150 tokens expect well under this
    max_tokens_per_insight: int = 170
    max_tokens_cap: int = 900
    temperature: float = 0.0
    batch: bool = True
    seed: int = 1


@dataclass(frozen=True)
class Weights:
    """Deterministic ranking weights. Safety relevance dominates; novelty and actionability break ties."""
    safety: float = 3.0
    evidence: float = 2.0
    recurrence: float = 1.5
    relevance: float = 1.0
    novelty: float = 1.0
    actionability: float = 0.5


def thresholds_for(profile: Mapping[str, Any] | None) -> Thresholds:
    """Per-user overrides from users.profile['insights'] (validated; bad values are ignored, never trusted)."""
    t = Thresholds()
    cfg = (profile or {}).get("insights") if isinstance(profile, Mapping) else None
    if not isinstance(cfg, Mapping):
        return t
    upd: dict[str, Any] = {}
    for key, lo, hi in (("low_mgdl", 40, 120), ("high_mgdl", 120, 400)):
        v = cfg.get(key)
        if isinstance(v, (int, float)) and not isinstance(v, bool) and lo <= v <= hi:
            upd[key] = float(v)
    for key in ("wake", "recap", "overnight_start"):
        v = cfg.get(key)
        if isinstance(v, str) and _valid_hhmm(v):
            upd[key] = v
    if cfg.get("mode") in ("episodes", "full"):
        upd["insight_mode"] = cfg["mode"]
    if upd.get("low_mgdl", t.low_mgdl) >= upd.get("high_mgdl", t.high_mgdl):
        upd.pop("low_mgdl", None)
        upd.pop("high_mgdl", None)
    return replace(t, **upd)


def _valid_hhmm(s: str) -> bool:
    try:
        h, m = s.split(":")
        return len(s) == 5 and 0 <= int(h) <= 23 and 0 <= int(m) <= 59
    except ValueError:
        return False
