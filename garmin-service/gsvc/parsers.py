"""Pure functions: one gateway tool payload -> normalised observations. No I/O, no clock reads (the caller passes `fetched_at`).

Rules:
  * Source timestamps are kept; everything is normalised to UTC. Strings ending in ...GMT/Gmt are UTC; strings marked "Local" (or HRV's sleep_start/end) are converted with the configured time zone.
  * Missing is missing: None, negative stress markers and empty answers produce no observation, never a zero.
  * A payload that is the wrong type or lacks the keys we rely on raises SchemaDrift (recorded, nothing stored) instead of being guessed at.
  * Nothing is interpolated: a daily summary stays a daily summary, an interval stays an interval.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from .metrics import METRICS


class SchemaDrift(Exception):
    """The payload does not look like what this parser was written against."""


@dataclass(frozen=True)
class Ctx:
    tz: ZoneInfo
    day: date  # the local calendar day that was requested
    fetched_at: datetime  # aware, UTC


@dataclass(frozen=True)
class Obs:
    metric: str
    measured_at: datetime  # aware, UTC
    ts_semantics: str
    value_num: float | None = None
    value_json: dict | None = None
    interval_s: int | None = None
    period: str | None = None
    period_date: date | None = None
    source_tool: str = ""
    meta: dict = field(default_factory=dict)

    @property
    def kind(self) -> str:
        return METRICS[self.metric].kind

    @property
    def unit(self) -> str | None:
        return METRICS[self.metric].unit

    @property
    def origin(self) -> str:
        return METRICS[self.metric].origin


# ------------------------------------------------------------------ helpers
def num(v) -> float | None:
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, (int, float)) and not (isinstance(v, float) and (math.isnan(v) or math.isinf(v))):
        return float(v)
    return None


def ms_to_dt(ms) -> datetime | None:
    n = num(ms)
    if n is None or n <= 0:
        return None
    return datetime.fromtimestamp(n / 1000.0, tz=timezone.utc)


def _parse_naive(s) -> datetime | None:
    if not isinstance(s, str) or not s:
        return None
    try:
        return datetime.fromisoformat(s.strip().replace("Z", ""))
    except ValueError:
        return None


def gmt_str(s) -> datetime | None:
    d = _parse_naive(s)
    return d.replace(tzinfo=timezone.utc) if d else None


def local_str(s, tz: ZoneInfo) -> datetime | None:
    d = _parse_naive(s)
    return d.replace(tzinfo=tz).astimezone(timezone.utc) if d else None


def local_midnight(d: date, tz: ZoneInfo) -> datetime:
    return datetime.combine(d, time.min, tzinfo=tz).astimezone(timezone.utc)


def _date(s) -> date | None:
    try:
        return date.fromisoformat(str(s)[:10])
    except ValueError:
        return None


def _is_empty_answer(p) -> bool:
    """The gateway answers 'No ... found for <date>' as plain text when there is nothing."""
    return p is None or (isinstance(p, str) and (not p.strip() or p.strip().lower().startswith("no ")))


def _need_dict(p, tool: str) -> dict:
    if not isinstance(p, dict):
        raise SchemaDrift(f"{tool}: expected an object, got {type(p).__name__}")
    return p


def _index(descriptors, key: str, tool: str) -> int:
    if not isinstance(descriptors, list):
        raise SchemaDrift(f"{tool}: value descriptors missing")
    for d in descriptors:
        if isinstance(d, dict):
            if d.get("key") == key:
                return int(d["index"])
            if d.get("bodyBatteryValueDescriptorKey") == key:
                return int(d["bodyBatteryValueDescriptorIndex"])
    raise SchemaDrift(f"{tool}: descriptor '{key}' not found")


def _series(rows, t_idx: int, v_idx: int):
    if not isinstance(rows, list):
        raise SchemaDrift("series is not a list")
    for r in rows:
        if isinstance(r, (list, tuple)) and len(r) > max(t_idx, v_idx):
            yield ms_to_dt(r[t_idx]), num(r[v_idx])


# ------------------------------------------------------------------ fast group
def parse_heart_rates(p, ctx: Ctx) -> list[Obs]:
    tool = "get_heart_rates"
    if _is_empty_answer(p):
        return []
    p = _need_dict(p, tool)
    t_i = _index(p.get("heartRateValueDescriptors"), "timestamp", tool)
    v_i = _index(p.get("heartRateValueDescriptors"), "heartrate", tool)
    out: list[Obs] = []
    for ts, v in _series(p.get("heartRateValues") or [], t_i, v_i):
        if ts is not None and v is not None and v > 0:
            out.append(Obs("heart_rate", ts, "instant", value_num=v, source_tool=tool))
    end = gmt_str(p.get("endTimestampGMT"))
    day = _date(p.get("calendarDate")) or ctx.day
    if end is not None:
        for metric, key in (("resting_heart_rate", "restingHeartRate"), ("resting_heart_rate_7d_avg", "lastSevenDaysAvgRestingHeartRate"), ("heart_rate_day_max", "maxHeartRate"), ("heart_rate_day_min", "minHeartRate")):
            v = num(p.get(key))
            if v is not None and v > 0:
                out.append(Obs(metric, end, "period_end", value_num=v, period="local_day_to_date", period_date=day, source_tool=tool))
    return out


def parse_steps(p, ctx: Ctx) -> list[Obs]:
    tool = "get_steps_data"
    if _is_empty_answer(p):
        return []
    if not isinstance(p, list):
        raise SchemaDrift(f"{tool}: expected a list, got {type(p).__name__}")
    out: list[Obs] = []
    for r in p:
        if not isinstance(r, dict):
            raise SchemaDrift(f"{tool}: interval is not an object")
        start, end = gmt_str(r.get("startGMT")), gmt_str(r.get("endGMT"))
        steps = num(r.get("steps"))
        if start is None or end is None or steps is None:
            continue
        secs = int((end - start).total_seconds())
        partial = end > ctx.fetched_at
        meta = {"partial_interval": True} if partial else {}
        out.append(Obs("steps_interval", start, "interval_start", value_num=steps, interval_s=secs, source_tool=tool, meta=meta))
        level = r.get("primaryActivityLevel")
        if isinstance(level, str) and level:
            out.append(Obs("activity_level", start, "interval_start", value_json={"level": level, "constant": bool(r.get("activityLevelConstant"))}, interval_s=secs, source_tool=tool, meta=meta))
    return out


def parse_user_summary(p, ctx: Ctx) -> list[Obs]:
    tool = "get_user_summary"
    if _is_empty_answer(p):
        return []
    p = _need_dict(p, tool)
    end = gmt_str(p.get("wellnessEndTimeGmt"))
    if end is None:
        raise SchemaDrift(f"{tool}: wellnessEndTimeGmt missing")
    day = _date(p.get("calendarDate")) or ctx.day
    mapping = [
        ("steps_day_cumulative", "totalSteps", 1),
        ("distance_day_cumulative", "totalDistanceMeters", 1),
        ("active_seconds_day", "activeSeconds", 1),
        ("highly_active_seconds_day", "highlyActiveSeconds", 1),
        ("sedentary_seconds_day", "sedentarySeconds", 1),
        ("intensity_minutes_moderate_day", "moderateIntensityMinutes", 1),
        ("intensity_minutes_vigorous_day", "vigorousIntensityMinutes", 1),
        ("active_kcal_day", "activeKilocalories", 1),
    ]
    out = []
    for metric, key, k in mapping:
        v = num(p.get(key))
        if v is not None:
            out.append(Obs(metric, end, "period_end", value_num=v * k, period="local_day", period_date=day, source_tool=tool))
    return out


def parse_activities(p, ctx: Ctx) -> list[Obs]:
    """NOT yet verified against a real session (the account had none today). Reads the documented Garmin Connect activity keys defensively."""
    tool = "get_activities_fordate"
    if _is_empty_answer(p):
        return []
    items = p.get("activities") if isinstance(p, dict) else p
    if not isinstance(items, list):
        raise SchemaDrift(f"{tool}: expected a list of activities")
    out = []
    for a in items:
        if not isinstance(a, dict):
            raise SchemaDrift(f"{tool}: activity is not an object")
        start = gmt_str(a.get("startTimeGMT")) or ms_to_dt(a.get("beginTimestamp"))
        dur = num(a.get("duration"))
        aid = a.get("activityId")
        if start is None or dur is None or aid is None:
            continue
        atype = a.get("activityType")
        detail = {
            "activity_id": aid if isinstance(aid, (int, str)) else str(aid),
            "type": atype.get("typeKey") if isinstance(atype, dict) else None,
            "duration_s": dur,
            "distance_m": num(a.get("distance")),
            "avg_hr": num(a.get("averageHR")),
            "max_hr": num(a.get("maxHR")),
            "calories": num(a.get("calories")),
            "aerobic_training_effect": num(a.get("aerobicTrainingEffect")),
        }
        out.append(Obs("exercise_session", start, "instant", value_num=dur, value_json={k: v for k, v in detail.items() if v is not None}, interval_s=int(dur), source_tool=tool, meta={"schema_verified": False}))
    return out


# ------------------------------------------------------------------ stress group
def parse_stress(p, ctx: Ctx) -> list[Obs]:
    tool = "get_stress_data"
    if _is_empty_answer(p):
        return []
    p = _need_dict(p, tool)
    out: list[Obs] = []
    t_i = _index(p.get("stressValueDescriptorsDTOList"), "timestamp", tool)
    s_i = _index(p.get("stressValueDescriptorsDTOList"), "stressLevel", tool)
    for ts, v in _series(p.get("stressValuesArray") or [], t_i, s_i):
        if ts is not None and v is not None and 0 <= v <= 100:  # negative values are Garmin's "no measurement" markers
            out.append(Obs("stress_level", ts, "instant", value_num=v, source_tool=tool))
    bb = p.get("bodyBatteryValuesArray")
    if bb:
        bt = _index(p.get("bodyBatteryValueDescriptorsDTOList"), "timestamp", tool)
        bl = _index(p.get("bodyBatteryValueDescriptorsDTOList"), "bodyBatteryLevel", tool)
        for ts, v in _series(bb, bt, bl):
            if ts is not None and v is not None and 0 <= v <= 100:
                out.append(Obs("body_battery", ts, "instant", value_num=v, source_tool=tool))
    return out


# ------------------------------------------------------------------ once or twice a day
def parse_sleep(p, ctx: Ctx) -> list[Obs]:
    tool = "get_sleep_summary"
    if _is_empty_answer(p):
        return []
    p = _need_dict(p, tool)
    end, start = ms_to_dt(p.get("sleep_end")), ms_to_dt(p.get("sleep_start"))
    dur = num(p.get("sleep_seconds"))
    if end is None or dur is None or dur <= 0:
        return []
    day = end.astimezone(ctx.tz).date()
    meta = {"sleep_start": start.isoformat() if start else None, "sleep_end": end.isoformat()}
    out = [Obs("sleep_duration", end, "period_end", value_num=dur, period="night", period_date=day, source_tool=tool, meta=meta)]
    score = num(p.get("sleep_score"))
    if score is not None:
        out.append(Obs("sleep_score", end, "period_end", value_num=score, value_json={"qualifier": p.get("sleep_score_qualifier")} if p.get("sleep_score_qualifier") else None, period="night", period_date=day, source_tool=tool, meta=meta))
    stages = {k: num(p.get(k)) for k in ("deep_sleep_seconds", "light_sleep_seconds", "rem_sleep_seconds", "awake_seconds", "awake_count")}
    stages = {k: v for k, v in stages.items() if v is not None}
    if stages:
        out.append(Obs("sleep_stages", end, "period_end", value_json=stages, period="night", period_date=day, source_tool=tool, meta=meta))
    st = num(p.get("avg_sleep_stress"))
    if st is not None:
        out.append(Obs("sleep_avg_stress", end, "period_end", value_num=st, period="night", period_date=day, source_tool=tool, meta=meta))
    return out


def parse_hrv(p, ctx: Ctx) -> list[Obs]:
    tool = "get_hrv_data"
    if _is_empty_answer(p):
        return []
    p = _need_dict(p, tool)
    avg = num(p.get("last_night_avg_hrv_ms"))
    end = local_str(p.get("sleep_end"), ctx.tz)  # HRV reports sleep times as local wall-clock strings
    if avg is None or end is None:
        return []
    day = _date(p.get("date")) or ctx.day
    out = [Obs("hrv_overnight_avg", end, "period_end", value_num=avg, period="night", period_date=day, source_tool=tool)]
    detail = {k: p.get(k) for k in ("last_night_5min_high_hrv_ms", "weekly_avg_hrv_ms", "baseline_balanced_low_ms", "baseline_balanced_upper_ms", "baseline_low_upper_ms", "status", "feedback") if p.get(k) is not None}
    if detail:
        out.append(Obs("hrv_status", end, "period_end", value_json=detail, period="night", period_date=day, source_tool=tool))
    return out


def parse_spo2(p, ctx: Ctx) -> list[Obs]:
    tool = "get_spo2_data"
    if _is_empty_answer(p):
        return []
    p = _need_dict(p, tool)
    day = _date(p.get("date")) or ctx.day
    start = local_midnight(day, ctx.tz)
    out: list[Obs] = []
    for r in p.get("hourly_averages") or []:
        if isinstance(r, (list, tuple)) and len(r) >= 2:
            ts, v = ms_to_dt(r[0]), num(r[1])
            if ts is not None and v is not None and 0 < v <= 100:
                out.append(Obs("spo2_hourly", ts, "interval_start", value_num=v, interval_s=3600, source_tool=tool))
    # latest_reading_time has no zone marker in this payload, so it is kept as text in meta, never used as a timestamp.
    meta = {"latest_reading_time_unzoned": p.get("latest_reading_time")} if p.get("latest_reading_time") else {}
    for metric, key in (("spo2_day_avg", "avg_spo2_percent"), ("spo2_day_lowest", "lowest_spo2_percent"), ("spo2_sleep_avg", "avg_sleep_spo2_percent")):
        v = num(p.get(key))
        if v is not None and 0 < v <= 100:
            out.append(Obs(metric, start, "period_start", value_num=v, period="local_day_to_date", period_date=day, source_tool=tool, meta=meta))
    return out


def parse_respiration(p, ctx: Ctx) -> list[Obs]:
    tool = "get_respiration_summary"
    if _is_empty_answer(p):
        return []
    p = _need_dict(p, tool)
    day = _date(p.get("date")) or ctx.day
    start = local_midnight(day, ctx.tz)
    out = []
    for metric, key in (("respiration_waking_avg", "avg_waking_breaths_per_min"), ("respiration_sleep_avg", "avg_sleep_breaths_per_min"), ("respiration_day_lowest", "lowest_breaths_per_min"), ("respiration_day_highest", "highest_breaths_per_min")):
        v = num(p.get(key))
        if v is not None and v > 0:
            out.append(Obs(metric, start, "period_start", value_num=v, period="local_day_to_date", period_date=day, source_tool=tool))
    return out


def parse_readiness(p, ctx: Ctx) -> list[Obs]:
    tool = "get_training_readiness"
    if _is_empty_answer(p):
        return []
    if isinstance(p, list):
        p = {"entries": p}
    p = _need_dict(p, tool)
    if not p:
        return []
    return [Obs("training_readiness", local_midnight(ctx.day, ctx.tz), "period_start", value_json=p, period="local_day", period_date=ctx.day, source_tool=tool, meta={"schema_verified": False})]
