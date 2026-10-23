"""Pure functions: one Personal API answer -> normalised observations. No I/O, no clock reads (the caller passes `fetched_at`).

Rules:
  * Source timestamps are kept and normalised to UTC. Garmin's "...GMT" strings carry no zone marker and are UTC; epoch values are milliseconds.
  * Missing is missing: a None field, a negative marker or an empty answer produces no observation, never a zero.
  * An answer that is the wrong type, or lacks the keys we rely on, raises SchemaDrift (recorded, nothing stored) instead of being guessed at.
  * Nothing is interpolated: a daily summary stays a daily summary, a sample stays a sample.
Shapes were taken from real answers of the official API (2026-10-22); the tests use synthetic payloads with the same keys.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
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


def gmt_str(s) -> datetime | None:
    """'2026-10-22T20:00:00.0' or '2026-10-21 17:04:30' (UTC, no zone marker) -> aware UTC."""
    if not isinstance(s, str) or not s.strip():
        return None
    try:
        d = datetime.fromisoformat(s.strip().replace("Z", ""))
    except ValueError:
        return None
    return d.replace(tzinfo=timezone.utc)


def _date(s) -> date | None:
    try:
        return date.fromisoformat(str(s)[:10])
    except ValueError:
        return None


def _dict(p, tool: str) -> dict:
    if not isinstance(p, dict):
        raise SchemaDrift(f"{tool}: expected an object, got {type(p).__name__}")
    return p


def _pos(v) -> float | None:
    n = num(v)
    return n if n is not None and n >= 0 else None


# ------------------------------------------------------------------ heart rate
def parse_heart_rate(p, ctx: Ctx) -> list[Obs]:
    """/wellness-service/wellness/dailyHeartRate: a sample about every 2 minutes plus the day's min / max / resting."""
    tool = "dailyHeartRate"
    if p is None:
        return []
    p = _dict(p, tool)
    out: list[Obs] = []
    values = p.get("heartRateValues")
    if values is not None and not isinstance(values, list):
        raise SchemaDrift(f"{tool}: heartRateValues is not a list")
    desc = p.get("heartRateValueDescriptors")
    if values and desc != [{"index": 0, "key": "timestamp"}, {"index": 1, "key": "heartrate"}]:
        raise SchemaDrift(f"{tool}: unexpected value descriptors")  # the [timestamp, bpm] layout is what we parse; anything else is not guessed
    for row in values or []:
        if not isinstance(row, (list, tuple)) or len(row) < 2:
            continue
        t, v = ms_to_dt(row[0]), num(row[1])
        if t is None or v is None or not 20 <= v <= 260:
            continue
        out.append(Obs("heart_rate", t, "instant", value_num=v, source_tool=tool))
    end = min(ms_to_dt(p.get("endTimestampGMT")) or gmt_str(p.get("endTimestampGMT")) or ctx.fetched_at, ctx.fetched_at)
    day = _date(p.get("calendarDate")) or ctx.day
    for metric, key in (("resting_heart_rate", "restingHeartRate"), ("resting_heart_rate_7d_avg", "lastSevenDaysAvgRestingHeartRate"),
                        ("heart_rate_day_max", "maxHeartRate"), ("heart_rate_day_min", "minHeartRate")):
        v = _pos(p.get(key))
        if v is not None and v > 0:
            out.append(Obs(metric, end, "period_end", value_num=v, period="local_day", period_date=day, source_tool=tool))
    return out


# ------------------------------------------------------------------ daily summary
def parse_daily_summary(p, ctx: Ctx) -> list[Obs]:
    """/usersummary-service/v2/dailysummaries: day totals so far (steps, distance, intensity minutes, calories, stress average, SpO2, respiration)."""
    tool = "dailysummaries"
    if p is None:
        return []
    items = _dict(p, tool).get("data")
    if not isinstance(items, list):
        raise SchemaDrift(f"{tool}: 'data' is not a list")
    out: list[Obs] = []
    for it in items:
        it = _dict(it, tool)
        day = _date(it.get("calendarDate")) or ctx.day
        wc = it.get("wellnessChronology") or {}
        end = gmt_str(wc.get("endTimestampGmt"))
        if end is None:
            continue
        end = min(end, ctx.fetched_at)  # a window end in the future is not a measurement time

        def put(metric: str, value, period: str = "local_day"):
            v = _pos(value)
            if v is not None:
                out.append(Obs(metric, end, "period_end", value_num=v, period=period, period_date=day, source_tool=tool))

        mv = (it.get("movement") or {}).get("steps") or {}
        put("steps_day_cumulative", mv.get("value"))
        d = _pos(mv.get("distanceInMeters"))
        if d:
            put("distance_day_cumulative", d)
        im = it.get("intensityMinutes") or {}
        put("intensity_minutes_moderate_day", im.get("moderate"))
        put("intensity_minutes_vigorous_day", im.get("vigorous"))
        put("active_kcal_day", (it.get("calories") or {}).get("burnedActive"))
        st = it.get("stress") or {}
        v = _pos(st.get("avgLevel"))  # Garmin marks "not enough data" with a negative number
        if v is not None and v > 0:
            put("stress_day_avg", v)
        po = it.get("pulseOx") or {}
        for metric, key in (("spo2_day_avg", "avgValue"), ("spo2_day_lowest", "minValue")):
            v = _pos(po.get(key))
            if v is not None and v > 0:
                put(metric, v)
        rs = it.get("respiration") or {}
        for metric, key in (("respiration_waking_avg", "avgValue"), ("respiration_day_lowest", "minValue"), ("respiration_day_highest", "maxValue")):
            v = _pos(rs.get(key))
            if v is not None and v > 0:
                put(metric, v)
    return out


# ------------------------------------------------------------------ body battery
def parse_body_battery(p, ctx: Ctx) -> list[Obs]:
    """/wellness-service/wellness/bodyBattery/reports/daily?chunks=1: a few level points per day (not a continuous series)."""
    tool = "bodyBattery"
    if p is None:
        return []
    if not isinstance(p, list):
        raise SchemaDrift(f"{tool}: expected a list, got {type(p).__name__}")
    out: list[Obs] = []
    for day in p:
        day = _dict(day, tool)
        desc = day.get("bodyBatteryValueDescriptorDTOList")
        arr = day.get("bodyBatteryValuesArray")
        if not arr:
            continue
        keys = {d.get("bodyBatteryValueDescriptorKey"): d.get("bodyBatteryValueDescriptorIndex") for d in (desc or []) if isinstance(d, dict)}
        if "timestamp" not in keys or "bodyBatteryLevel" not in keys:
            raise SchemaDrift(f"{tool}: descriptors missing")
        ti, li = int(keys["timestamp"]), int(keys["bodyBatteryLevel"])
        for row in arr:
            if not isinstance(row, (list, tuple)) or len(row) <= max(ti, li):
                continue
            t, v = ms_to_dt(row[ti]), num(row[li])
            if t is not None and v is not None and 0 <= v <= 100:
                out.append(Obs("body_battery", t, "instant", value_num=v, source_tool=tool))
    return out


# ------------------------------------------------------------------ sleep, hrv
def parse_sleep(p, ctx: Ctx) -> list[Obs]:
    """/sleep-service/sleep/dailySleep?date=: last night (all fields None until the watch has synced the night)."""
    tool = "dailySleep"
    if p is None:
        return []
    p = _dict(p, tool)
    secs = _pos(p.get("sleepTimeSeconds"))
    end = ms_to_dt(p.get("sleepEndTimestampGMT"))
    if secs is None or secs <= 0 or end is None:
        return []
    day = _date(p.get("calendarDate")) or ctx.day

    def put(metric, value=None, json_value=None):
        out.append(Obs(metric, end, "period_end", value_num=value, value_json=json_value, period="night", period_date=day, source_tool=tool))

    out: list[Obs] = []
    put("sleep_duration", secs)
    score = (((p.get("sleepScores") or {}).get("overall")) or {}).get("value")
    if _pos(score) is not None:
        put("sleep_score", float(score))
    stages = {"deep_sleep_seconds": _pos(p.get("deepSleepSeconds")), "light_sleep_seconds": _pos(p.get("lightSleepSeconds")),
              "rem_sleep_seconds": _pos(p.get("remSleepSeconds")), "awake_seconds": _pos(p.get("awakeSleepSeconds"))}
    if all(v is not None for v in stages.values()):  # stages are all present or not given at all (never guessed)
        a = _pos(p.get("awakeCount"))
        put("sleep_stages", json_value={**stages, **({"awake_count": a} if a is not None else {})})
    for metric, key in (("sleep_avg_stress", "avgSleepStress"), ("spo2_sleep_avg", "averageSpO2Value"), ("respiration_sleep_avg", "averageRespirationValue")):
        v = _pos(p.get(key))
        if v is not None and v > 0:
            put(metric, v)
    return out


def parse_hrv(p, ctx: Ctx) -> list[Obs]:
    """/hrv-service/hrv/{date}: Garmin's overnight HRV summary (no answer = no night recorded yet)."""
    tool = "hrv"
    if p is None:
        return []
    p = _dict(p, tool)
    s = p.get("hrvSummary")
    end = gmt_str(p.get("sleepEndTimestampGMT"))
    if not isinstance(s, dict) or end is None:
        return []
    day = _date(s.get("calendarDate")) or ctx.day
    out: list[Obs] = []
    avg = _pos(s.get("lastNightAvg"))
    if avg is not None and avg > 0:
        out.append(Obs("hrv_overnight_avg", end, "period_end", value_num=avg, period="night", period_date=day, source_tool=tool))
    status = s.get("status")
    if isinstance(status, str) and status:
        base = s.get("baseline") if isinstance(s.get("baseline"), dict) else {}
        out.append(Obs("hrv_status", end, "period_end", value_json={"weekly_avg_ms": _pos(s.get("weeklyAvg")), "last_night_5min_high_ms": _pos(s.get("lastNight5MinHigh")),
                                                                 "baseline_low_upper_ms": _pos(base.get("lowUpper")), "baseline_balanced_low_ms": _pos(base.get("balancedLow")),
                                                                 "baseline_balanced_upper_ms": _pos(base.get("balancedUpper")), "status": status},
                     period="night", period_date=day, source_tool=tool))
    return out


# ------------------------------------------------------------------ activities
def parse_activities(p, ctx: Ctx) -> list[Obs]:
    """/activitylist-service/activities/search/activities: recorded exercise sessions (start, duration, type, heart rate, training effect)."""
    tool = "activities"
    if p is None:
        return []
    if not isinstance(p, list):
        raise SchemaDrift(f"{tool}: expected a list, got {type(p).__name__}")
    out: list[Obs] = []
    for a in p:
        a = _dict(a, tool)
        start, dur, aid = gmt_str(a.get("startTimeGMT")), num(a.get("duration")), a.get("activityId")
        if start is None or dur is None or dur <= 0 or aid is None:
            continue
        t = a.get("activityType")
        detail = {"activity_id": aid if isinstance(aid, (int, str)) else str(aid), "type": t.get("typeKey") if isinstance(t, dict) else None, "duration_s": dur,
                  "distance_m": num(a.get("distance")), "avg_hr": num(a.get("averageHR")), "max_hr": num(a.get("maxHR")), "calories": num(a.get("calories")),
                  "steps": num(a.get("steps")), "aerobic_training_effect": num(a.get("aerobicTrainingEffect")),
                  "anaerobic_training_effect": num(a.get("anaerobicTrainingEffect"))}
        out.append(Obs("exercise_session", start, "instant", value_num=dur, value_json={k: v for k, v in detail.items() if v is not None}, interval_s=int(dur),
                       source_tool=tool, meta={"schema_verified": True}))
    return out
