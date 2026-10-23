"""Parsers for the official Personal API answers. Payloads are SYNTHETIC but have exactly the keys of the real answers (inspected 2026-10-22)."""
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

import pytest

from gsvc import parsers as P

UTC = timezone.utc
FETCHED = datetime(2026, 10, 22, 21, 0, tzinfo=UTC)
CTX = P.Ctx(ZoneInfo("Asia/Beirut"), date(2026, 10, 22), FETCHED)
T0 = int(datetime(2026, 10, 22, 8, 0, tzinfo=UTC).timestamp() * 1000)
DESC = [{"index": 0, "key": "timestamp"}, {"index": 1, "key": "heartrate"}]


def by(obs, metric):
    return [o for o in obs if o.metric == metric]


# ---------------------------------------------------------------- heart rate
def test_heart_rate_samples_and_daily_figures():
    p = {"calendarDate": "2026-10-22", "endTimestampGMT": "2026-10-22T20:58:00.0", "maxHeartRate": 150, "minHeartRate": 48, "restingHeartRate": 52,
         "lastSevenDaysAvgRestingHeartRate": 53, "heartRateValueDescriptors": DESC,
         "heartRateValues": [[T0, 70], [T0 + 120000, 72], [T0 + 240000, None], [T0 + 360000, 400], [T0 + 480000, 18]]}
    out = P.parse_heart_rate(p, CTX)
    hr = by(out, "heart_rate")
    assert [o.value_num for o in hr] == [70.0, 72.0] and hr[0].ts_semantics == "instant" and hr[0].measured_at == datetime(2026, 10, 22, 8, 0, tzinfo=UTC)
    assert by(out, "resting_heart_rate")[0].value_num == 52 and by(out, "heart_rate_day_max")[0].value_num == 150 and by(out, "resting_heart_rate_7d_avg")[0].value_num == 53
    assert by(out, "resting_heart_rate")[0].ts_semantics == "period_end" and by(out, "resting_heart_rate")[0].period_date == date(2026, 10, 22)


def test_heart_rate_empty_day_and_unknown_layouts():
    assert P.parse_heart_rate(None, CTX) == []
    empty = {"calendarDate": "2026-10-23", "heartRateValues": None, "heartRateValueDescriptors": None, "restingHeartRate": None, "maxHeartRate": None}
    assert P.parse_heart_rate(empty, CTX) == []                                   # the watch was not worn: no rows, no zeros
    with pytest.raises(P.SchemaDrift):
        P.parse_heart_rate({"heartRateValues": [[T0, 70]], "heartRateValueDescriptors": [{"index": 0, "key": "bpm"}]}, CTX)
    with pytest.raises(P.SchemaDrift):
        P.parse_heart_rate([], CTX)


def test_a_period_end_in_the_future_is_capped_at_the_fetch_time():
    p = {"calendarDate": "2026-10-22", "endTimestampGMT": "2026-10-23T20:59:00.0", "restingHeartRate": 52, "heartRateValues": None}
    assert by(P.parse_heart_rate(p, CTX), "resting_heart_rate")[0].measured_at == FETCHED


# ---------------------------------------------------------------- daily summary
def summary(**over):
    d = {"calendarDate": "2026-10-22", "wellnessChronology": {"endTimestampGmt": "2026-10-22T20:00:00.0"}, "movement": {"steps": {"value": 6123, "goal": 8000, "distanceInMeters": 4210.5}},
         "calories": {"burnedActive": 410}, "intensityMinutes": {"moderate": 12, "vigorous": 30}, "stress": {"avgLevel": 31}, "pulseOx": {"avgValue": 95, "minValue": 88},
         "respiration": {"avgValue": 15, "minValue": 10, "maxValue": 21}, "heartRate": {}, "bodyBattery": {}}
    d.update(over)
    return {"data": [d]}


def test_daily_summary_maps_totals_as_cumulative_period_end_values():
    out = P.parse_daily_summary(summary(), CTX)
    v = {o.metric: o.value_num for o in out}
    assert v["steps_day_cumulative"] == 6123 and v["distance_day_cumulative"] == 4210.5 and v["intensity_minutes_vigorous_day"] == 30 and v["active_kcal_day"] == 410
    assert v["stress_day_avg"] == 31 and v["spo2_day_avg"] == 95 and v["spo2_day_lowest"] == 88 and v["respiration_day_highest"] == 21 and v["respiration_waking_avg"] == 15
    assert all(o.ts_semantics == "period_end" and o.period == "local_day" and o.measured_at == datetime(2026, 10, 22, 20, 0, tzinfo=UTC) for o in out)


def test_daily_summary_missing_is_missing_and_markers_are_not_values():
    out = P.parse_daily_summary(summary(stress={"avgLevel": -1}, pulseOx={}, respiration={}), CTX)
    assert not by(out, "stress_day_avg") and not by(out, "spo2_day_avg") and by(out, "steps_day_cumulative")
    assert P.parse_daily_summary(summary(wellnessChronology={}), CTX) == []        # no window end: no measurement time, nothing stored
    assert P.parse_daily_summary(None, CTX) == []
    with pytest.raises(P.SchemaDrift):
        P.parse_daily_summary({"data": "x"}, CTX)


# ---------------------------------------------------------------- body battery
def test_body_battery_points_use_the_descriptors():
    day = {"date": "2026-10-22", "bodyBatteryValuesArray": [[T0, 70], [T0 + 3600000, 55]],
           "bodyBatteryValueDescriptorDTOList": [{"bodyBatteryValueDescriptorIndex": 0, "bodyBatteryValueDescriptorKey": "timestamp"}, {"bodyBatteryValueDescriptorIndex": 1, "bodyBatteryValueDescriptorKey": "bodyBatteryLevel"}]}
    out = P.parse_body_battery([day], CTX)
    assert [o.value_num for o in out] == [70.0, 55.0] and out[0].ts_semantics == "instant"
    assert P.parse_body_battery([{"date": "2026-10-23", "bodyBatteryValuesArray": [[T0, 70]], "bodyBatteryValueDescriptorDTOList": None}][:0], CTX) == []
    with pytest.raises(P.SchemaDrift):
        P.parse_body_battery([{"bodyBatteryValuesArray": [[T0, 70]], "bodyBatteryValueDescriptorDTOList": None}], CTX)


# ---------------------------------------------------------------- sleep and hrv
def sleep(**over):
    d = {"calendarDate": "2026-10-22", "sleepTimeSeconds": 27000, "sleepEndTimestampGMT": T0, "deepSleepSeconds": 4000, "lightSleepSeconds": 15000, "remSleepSeconds": 6000, "awakeSleepSeconds": 2000,
         "awakeCount": 3, "avgSleepStress": 18.5, "averageSpO2Value": 94.2, "averageRespirationValue": 13.5, "sleepScores": {"overall": {"value": 82, "qualifierKey": "GOOD"}}}
    d.update(over)
    return d


def test_sleep_maps_duration_score_stages_and_night_averages():
    out = P.parse_sleep(sleep(), CTX)
    v = {o.metric: o for o in out}
    assert v["sleep_duration"].value_num == 27000 and v["sleep_score"].value_num == 82 and v["sleep_avg_stress"].value_num == 18.5
    assert v["sleep_stages"].value_json == {"deep_sleep_seconds": 4000.0, "light_sleep_seconds": 15000.0, "rem_sleep_seconds": 6000.0, "awake_seconds": 2000.0, "awake_count": 3.0}
    assert v["spo2_sleep_avg"].value_num == 94.2 and v["respiration_sleep_avg"].value_num == 13.5 and v["sleep_duration"].period == "night"


def test_sleep_not_yet_synced_or_incomplete_stages_store_nothing_guessed():
    assert P.parse_sleep(sleep(sleepTimeSeconds=None, sleepEndTimestampGMT=None), CTX) == []
    assert P.parse_sleep(None, CTX) == []
    out = P.parse_sleep(sleep(remSleepSeconds=None), CTX)
    assert not by(out, "sleep_stages") and by(out, "sleep_duration")


def test_hrv_summary_and_no_night():
    p = {"hrvSummary": {"calendarDate": "2026-10-22", "weeklyAvg": 52, "lastNightAvg": 48, "lastNight5MinHigh": 80, "status": "BALANCED",
                        "baseline": {"lowUpper": 40, "balancedLow": 45, "balancedUpper": 60, "markerValue": 0.5}}, "sleepEndTimestampGMT": "2026-10-22T04:37:28.0"}
    out = P.parse_hrv(p, CTX)
    assert by(out, "hrv_overnight_avg")[0].value_num == 48 and by(out, "hrv_status")[0].value_json["status"] == "BALANCED" and by(out, "hrv_status")[0].value_json["baseline_balanced_low_ms"] == 45
    assert P.parse_hrv(None, CTX) == [] and P.parse_hrv({"hrvSummary": None}, CTX) == []


# ---------------------------------------------------------------- activities
def test_activities_become_exercise_sessions_with_the_stated_type():
    a = {"activityId": 123, "startTimeGMT": "2026-10-21 17:04:30", "duration": 4253.5, "activityType": {"typeKey": "strength_training"}, "averageHR": 118, "maxHR": 160, "calories": 300,
         "aerobicTrainingEffect": 2.1, "distance": 0.0}
    out = P.parse_activities([a, {"activityId": 1, "startTimeGMT": "2026-10-20 09:00:00", "duration": 0}, {"startTimeGMT": "x"}], CTX)
    assert len(out) == 1
    o = out[0]
    assert o.metric == "exercise_session" and o.value_num == 4253.5 and o.measured_at == datetime(2026, 10, 21, 17, 4, 30, tzinfo=UTC) and o.interval_s == 4253
    assert o.value_json["type"] == "strength_training" and o.value_json["avg_hr"] == 118 and o.meta == {"schema_verified": True}
    assert P.parse_activities([], CTX) == [] and P.parse_activities(None, CTX) == []
    with pytest.raises(P.SchemaDrift):
        P.parse_activities({"x": 1}, CTX)
