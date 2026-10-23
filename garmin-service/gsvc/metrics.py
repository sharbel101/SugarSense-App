"""The metrics this service stores and serves. Every name here is backed by a field that Garmin's official Personal API really returns (see UNSUPPORTED for what is not)."""
from __future__ import annotations

from dataclasses import dataclass

KINDS = ("instant", "interval", "cumulative", "daily_summary", "event")
TS_SEMANTICS = ("instant", "interval_start", "period_start", "period_end")
ORIGINS = ("raw_sensor", "garmin_derived")


@dataclass(frozen=True)
class MetricInfo:
    unit: str | None
    kind: str
    origin: str  # raw_sensor = a count/sample the watch measured; garmin_derived = a score/summary Garmin calculated
    group: str  # fast | stress | sleep | hrv | spo2_resp
    stale_after_s: int  # older than this (by measured_at) is reported as stale
    description: str


H = 3600
D = 24 * H

METRICS: dict[str, MetricInfo] = {
    # ---- fast group: dailyHeartRate, dailysummaries, activities
    "heart_rate": MetricInfo("bpm", "instant", "raw_sensor", "fast", 3 * H, "Heart-rate sample from the watch (about every 2 minutes); arrives in batches after the watch syncs"),
    "resting_heart_rate": MetricInfo("bpm", "daily_summary", "garmin_derived", "fast", 2 * D, "Garmin's resting heart rate for the local day"),
    "resting_heart_rate_7d_avg": MetricInfo("bpm", "daily_summary", "garmin_derived", "fast", 2 * D, "Average resting heart rate over the last 7 days"),
    "heart_rate_day_max": MetricInfo("bpm", "daily_summary", "garmin_derived", "fast", 6 * H, "Highest heart rate so far on the local day"),
    "heart_rate_day_min": MetricInfo("bpm", "daily_summary", "garmin_derived", "fast", 6 * H, "Lowest heart rate so far on the local day"),
    "steps_day_cumulative": MetricInfo("steps", "cumulative", "raw_sensor", "fast", 3 * H, "Steps so far on the local day. Cumulative: never add successive values"),
    "distance_day_cumulative": MetricInfo("m", "cumulative", "raw_sensor", "fast", 3 * H, "Distance so far on the local day (cumulative)"),
    "intensity_minutes_moderate_day": MetricInfo("min", "cumulative", "garmin_derived", "fast", 3 * H, "Moderate intensity minutes so far on the local day (cumulative)"),
    "intensity_minutes_vigorous_day": MetricInfo("min", "cumulative", "garmin_derived", "fast", 3 * H, "Vigorous intensity minutes so far on the local day (cumulative)"),
    "active_kcal_day": MetricInfo("kcal", "cumulative", "garmin_derived", "fast", 3 * H, "Active calories so far on the local day (cumulative)"),
    "exercise_session": MetricInfo("s", "event", "garmin_derived", "fast", 2 * D, "A recorded exercise session: value is the duration, details in value_json"),
    # ---- stress group (body battery points are sparse; stress is a daily figure only)
    "body_battery": MetricInfo("score_0_100", "instant", "garmin_derived", "stress", 12 * H, "Garmin body battery level (calculated by Garmin); only a few points per day"),
    "stress_day_avg": MetricInfo("score_0_100", "daily_summary", "garmin_derived", "stress", 12 * H, "Garmin's average stress score for the local day so far (calculated by Garmin)"),
    # ---- sleep, hrv, blood oxygen and respiration (once the watch has synced)
    "sleep_duration": MetricInfo("s", "daily_summary", "garmin_derived", "sleep", 36 * H, "Total sleep of the last night"),
    "sleep_score": MetricInfo("score_0_100", "daily_summary", "garmin_derived", "sleep", 36 * H, "Garmin sleep score (calculated by Garmin)"),
    "sleep_stages": MetricInfo(None, "daily_summary", "garmin_derived", "sleep", 36 * H, "Seconds in deep, light, REM and awake plus awake count (Garmin's staging)"),
    "sleep_avg_stress": MetricInfo("score_0_100", "daily_summary", "garmin_derived", "sleep", 36 * H, "Average stress score during sleep"),
    "hrv_overnight_avg": MetricInfo("ms", "daily_summary", "garmin_derived", "hrv", 36 * H, "Garmin's overnight average HRV; raw beat-to-beat intervals are not exposed"),
    "hrv_status": MetricInfo(None, "daily_summary", "garmin_derived", "hrv", 36 * H, "HRV weekly average, baseline band and Garmin's status label"),
    "spo2_day_avg": MetricInfo("percent", "daily_summary", "garmin_derived", "spo2_resp", 36 * H, "Average SpO2 for the local day"),
    "spo2_day_lowest": MetricInfo("percent", "daily_summary", "garmin_derived", "spo2_resp", 36 * H, "Lowest SpO2 for the local day"),
    "spo2_sleep_avg": MetricInfo("percent", "daily_summary", "garmin_derived", "spo2_resp", 36 * H, "Average SpO2 during sleep"),
    "respiration_waking_avg": MetricInfo("breaths_per_min", "daily_summary", "garmin_derived", "spo2_resp", 36 * H, "Average waking respiration rate"),
    "respiration_sleep_avg": MetricInfo("breaths_per_min", "daily_summary", "garmin_derived", "spo2_resp", 36 * H, "Average respiration rate during sleep"),
    "respiration_day_lowest": MetricInfo("breaths_per_min", "daily_summary", "garmin_derived", "spo2_resp", 36 * H, "Lowest respiration rate of the day"),
    "respiration_day_highest": MetricInfo("breaths_per_min", "daily_summary", "garmin_derived", "spo2_resp", 36 * H, "Highest respiration rate of the day"),
}

# What cannot be offered, and why. Shown by /status so the frontend never has to guess.
UNSUPPORTED: dict[str, str] = {
    "skin_temperature": "The watch has no built-in skin-temperature sensor and the Personal API has no such field.",
    "rr_intervals": "Raw beat-to-beat intervals are not exposed; only Garmin's overnight HRV summary is.",
    "heart_rate_per_second": "Heart rate arrives on a coarse grid (about 2 minutes), not beat by beat.",
    "steps_intraday": "The Personal API gives daily step totals only, not steps per 15 minutes or per minute.",
    "stress_intraday": "The Personal API gives a daily stress figure, not a stress score every few minutes.",
    "glucose": "Garmin does not measure glucose; nothing here is a glucose reading.",
}

GROUPS = ("fast", "stress", "sleep", "hrv", "spo2_resp")


def metrics_in_group(group: str) -> list[str]:
    return [n for n, m in METRICS.items() if m.group == group]
