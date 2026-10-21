"""Thresholds and requirements. Every number has a reason; nothing here is a clinical or treatment threshold.

The glucose range numbers are REPORTING thresholds for time-in-range style statistics. They never trigger an alert or a
treatment instruction. The low value is the app's existing configured one (mobile TARGET_MIN_MGDL / LOW_GLUCOSE_MGDL = 70);
the high default (180) is per the product owner and is overridable per user through users.profile.insights.high_mgdl so it
can follow the user's prescribed targets.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Any, Mapping

ENGINE_VERSION = "insights-0.3.0"
PROMPT_VERSION = "insight-write-v2"
SCHEMA_VERSION = "insight-write-v2"


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
    # --- reasoning evidence: what the model is allowed to reason about is limited to what these produce ------------------------------------
    big_spike_rise_mgdl: float = 60.0    # a post-meal rise this large (about half the 70-180 range) opens the "big meal spike" reasoning; smaller rises stay a plain report
    fasting_hours: int = 4               # no meal and no insulin record in the 4 h before a high = unexplained by the records (a meal is mostly absorbed within 3-4 h)
    dose_context_min: int = 60           # a bolus within +-60 min of a meal is treated as that meal's dose when looking at timing
    post_activity_hours: int = 12        # a low starting within 12 h after activity ended can be linked to it (the effect on sensitivity lasts hours)
    low_after_dose_hours: int = 5        # a low 1-5 h after a bolus or correction is inside the insulin action window (about 5 h)
    activity_window_min: int = 120
    # --- awareness: insulin and carbohydrate still active, low-heading warning, frequent lows, wearable context ------------------------------
    insulin_action_hours: float = 5.0    # rapid-acting insulin is treated as fully worn off after 5 h, falling in a straight line: a rough estimate, labelled as one
    carb_absorb_hours: float = 3.0       # logged carbohydrate is treated as fully absorbed after 3 h (same horizon as the meal window), falling in a straight line
    heading_low_max_mgdl: float = 140.0  # the warning is only for a glucose that is already low-ish and falling; higher and falling is normal after a meal
    heading_low_minutes: int = 20        # the fall is measured over the last 20 minutes (4 readings)
    heading_low_slope: float = -0.8      # mg/dL per minute: about 16 mg/dL in 20 minutes
    heading_low_min_iob: float = 0.5     # units still active by the estimate before insulin is named as a reason
    heading_low_max_cob_g: float = 20.0  # more than this still absorbing and the fall is probably covered
    heading_low_ttl_min: int = 60        # this card is stale quickly: it is a statement about the next hour
    frequent_lows_days: int = 7
    frequent_lows_min: int = 3           # at least 3 separate stays below range in 7 days ...
    frequent_lows_min_days: int = 2      # ... on at least 2 different days
    low_gap_min: int = 60                # two low readings more than an hour apart are two separate lows
    garmin_context_hours: int = 3        # wearable context is taken from the 3 hours before a stay (same horizon as the records context)
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
    timeout_s: int = 600          # a batch of five cards is about 7 minutes on the 4-CPU VM (about 7 tokens/s); the unit allows 20 minutes in total
    max_tokens_per_insight: int = 560     # front paragraph + the reasoning and safety texts for the back of the card
    max_tokens_cap: int = 2000
    temperature: float = 0.7              # writing, not classifying: sampled so the wording differs from day to day (the facts never do)
    batch: bool = True
    seed: int | None = None               # no fixed seed: variety is wanted; correctness is enforced by the validator, not by determinism


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
