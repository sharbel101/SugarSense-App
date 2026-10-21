"""The metrics this service stores and serves. Every name here is backed by a tool the gateway really offers (see UNSUPPORTED for what is not)."""
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
    group: str  # fast | stress | sleep | hrv | spo2_resp | readiness
    stale_after_s: int  # older than this (by measured_at) is reported as stale
    description: str


H = 3600
D = 24 * H

METRICS: dict[str, MetricInfo] = {
    # ---- fast group (get_heart_rates, get_steps_data, get_user_summary, get_activities_fordate)
    "heart_rate": MetricInfo("bpm", "instant", "raw_sensor", "fast", 1 * H, "Heart-rate sample from the watch (about every 2 minutes in the real data)"),
    "resting_heart_rate": MetricInfo("bpm", "daily_summary", "garmin_derived", "fast", 2 * D, "Garmin's resting heart rate for the local day"),
    "resting_heart_rate_7d_avg": MetricInfo("bpm", "daily_summary", "garmin_derived", "fast", 2 * D, "Average resting heart rate over the last 7 days"),
    "heart_rate_day_max": MetricInfo("bpm", "daily_summary", "garmin_derived", "fast", 2 * H, "Highest heart rate so far on the local day"),
    "heart_rate_day_min": MetricInfo("bpm", "daily_summary", "garmin_derived", "fast", 2 * H, "Lowest heart rate so far on the local day"),
    "steps_interval": MetricInfo("steps", "interval", "raw_sensor", "fast", 1 * H, "Steps in one 15-minute interval (the newest interval may still be filling)"),
    "activity_level": MetricInfo(None, "interval", "garmin_derived", "fast", 1 * H, "Garmin's movement class for a 15-minute interval (sedentary, active, highlyActive ...)"),
    "steps_day_cumulative": MetricInfo("steps", "cumulative", "raw_sensor", "fast", 1 * H, "Steps so far on the local day. Cumulative: never add successive values"),
    "distance_day_cumulative": MetricInfo("m", "cumulative", "raw_sensor", "fast", 1 * H, "Distance so far on the local day (cumulative)"),
    "active_seconds_day": MetricInfo("s", "cumulative", "garmin_derived", "fast", 1 * H, "Seconds classed as active so far on the local day (cumulative)"),
    "highly_active_seconds_day": MetricInfo("s", "cumulative", "garmin_derived", "fast", 1 * H, "Seconds classed as highly active so far on the local day (cumulative)"),
    "sedentary_seconds_day": MetricInfo("s", "cumulative", "garmin_derived", "fast", 1 * H, "Seconds classed as sedentary so far on the local day (cumulative)"),
    "intensity_minutes_moderate_day": MetricInfo("min", "cumulative", "garmin_derived", "fast", 1 * H, "Moderate intensity minutes so far on the local day (cumulative)"),
    "intensity_minutes_vigorous_day": MetricInfo("min", "cumulative", "garmin_derived", "fast", 1 * H, "Vigorous intensity minutes so far on the local day (cumulative)"),
    "active_kcal_day": MetricInfo("kcal", "cumulative", "garmin_derived", "fast", 1 * H, "Active calories so far on the local day (cumulative)"),
    "exercise_session": MetricInfo("s", "event", "garmin_derived", "fast", 2 * D, "A recorded exercise session: value is the duration, details in value_json"),
    # ---- stress group (get_stress_data carries both series)
    "stress_level": MetricInfo("score_0_100", "instant", "garmin_derived", "stress", 2 * H, "Garmin stress score (HRV based, calculated by Garmin) about every 3 minutes; not a glucose signal"),
    "body_battery": MetricInfo("score_0_100", "instant", "garmin_derived", "stress", 2 * H, "Garmin body battery level (calculated by Garmin)"),
    # ---- once or twice a day
    "sleep_duration": MetricInfo("s", "daily_summary", "garmin_derived", "sleep", 36 * H, "Total sleep of the last night"),
    "sleep_score": MetricInfo("score_0_100", "daily_summary", "garmin_derived", "sleep", 36 * H, "Garmin sleep score (calculated by Garmin)"),
    "sleep_stages": MetricInfo(None, "daily_summary", "garmin_derived", "sleep", 36 * H, "Seconds in deep, light, REM and awake plus awake count (Garmin's staging)"),
    "sleep_avg_stress": MetricInfo("score_0_100", "daily_summary", "garmin_derived", "sleep", 36 * H, "Average stress score during sleep"),
    "hrv_overnight_avg": MetricInfo("ms", "daily_summary", "garmin_derived", "hrv", 36 * H, "Garmin's overnight average HRV; raw RR intervals are not exposed"),
    "hrv_status": MetricInfo(None, "daily_summary", "garmin_derived", "hrv", 36 * H, "HRV weekly average, baseline band and Garmin's status label"),
    "spo2_hourly": MetricInfo("percent", "interval", "garmin_derived", "spo2_resp", 36 * H, "Hourly average blood-oxygen saturation"),
    "spo2_day_avg": MetricInfo("percent", "daily_summary", "garmin_derived", "spo2_resp", 36 * H, "Average SpO2 for the local day"),
    "spo2_day_lowest": MetricInfo("percent", "daily_summary", "garmin_derived", "spo2_resp", 36 * H, "Lowest SpO2 for the local day"),
    "spo2_sleep_avg": MetricInfo("percent", "daily_summary", "garmin_derived", "spo2_resp", 36 * H, "Average SpO2 during sleep"),
    "respiration_waking_avg": MetricInfo("breaths_per_min", "daily_summary", "garmin_derived", "spo2_resp", 36 * H, "Average waking respiration rate"),
    "respiration_sleep_avg": MetricInfo("breaths_per_min", "daily_summary", "garmin_derived", "spo2_resp", 36 * H, "Average respiration rate during sleep"),
    "respiration_day_lowest": MetricInfo("breaths_per_min", "daily_summary", "garmin_derived", "spo2_resp", 36 * H, "Lowest respiration rate of the day"),
    "respiration_day_highest": MetricInfo("breaths_per_min", "daily_summary", "garmin_derived", "spo2_resp", 36 * H, "Highest respiration rate of the day"),
    "training_readiness": MetricInfo(None, "daily_summary", "garmin_derived", "readiness", 36 * H, "Garmin training readiness, stored as returned (shape not yet verified against real data)"),
}

# What cannot be offered, and why. Shown by /status so the frontend never has to guess.
UNSUPPORTED: dict[str, str] = {
    "skin_temperature": "The gateway offers no temperature tool (checked all 154 tool names).",
    "rr_intervals": "Raw beat-to-beat intervals are not exposed; only Garmin's overnight HRV summary is.",
    "heart_rate_per_second": "Heart rate arrives on a coarse grid (about 2 minutes), not beat by beat.",
    "steps_per_minute": "Steps are only available as 15-minute intervals and a running day total.",
    "glucose": "Garmin does not measure glucose; nothing here is a glucose reading.",
}

GROUPS = ("fast", "stress", "sleep", "hrv", "spo2_resp", "readiness")


def metrics_in_group(group: str) -> list[str]:
    return [n for n, m in METRICS.items() if m.group == group]
