"""Parsers against payloads that have the SHAPE of the real gateway answers (captured structure on 2026-10-21) but synthetic values.
get_activities_fordate and get_training_readiness had no data that day, so their non-empty shapes are documented-but-unverified (parsers mark schema_verified=false)."""
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

import pytest

from gsvc import parsers as P
from gsvc.metrics import METRICS

TZ = ZoneInfo("Asia/Beirut")
FETCH = datetime(2026, 10, 21, 8, 46, tzinfo=timezone.utc)
CTX = P.Ctx(TZ, date(2026, 10, 21), FETCH)
MS = lambda iso: int(datetime.fromisoformat(iso).replace(tzinfo=timezone.utc).timestamp() * 1000)


def test_every_metric_the_parsers_can_emit_is_in_the_catalogue():
    from gsvc import catalog

    assert catalog.ALL_TOOLS  # sanity
    for m, info in METRICS.items():
        assert info.kind in ("instant", "interval", "cumulative", "daily_summary", "event") and info.origin in ("raw_sensor", "garmin_derived")


HR = {
    "calendarDate": "2026-10-21",
    "endTimestampGMT": "2026-10-21T08:27:00.0",
    "maxHeartRate": 104,
    "minHeartRate": 50,
    "restingHeartRate": 52,
    "lastSevenDaysAvgRestingHeartRate": 51,
    "heartRateValueDescriptors": [{"index": 0, "key": "timestamp"}, {"index": 1, "key": "heartrate"}],
    "heartRateValues": [[MS("2026-10-21T08:24:00"), 71], [MS("2026-10-21T08:26:00"), None], [MS("2026-10-21T08:28:00"), 66]],
}


def test_heart_rate_samples_are_utc_instants_and_none_is_skipped_not_zeroed():
    obs = P.parse_heart_rates(HR, CTX)
    hr = [o for o in obs if o.metric == "heart_rate"]
    assert [(o.measured_at.isoformat(), o.value_num) for o in hr] == [("2026-10-21T08:24:00+00:00", 71.0), ("2026-10-21T08:28:00+00:00", 66.0)]
    assert all(o.ts_semantics == "instant" and o.kind == "instant" and o.unit == "bpm" for o in hr)
    summ = {o.metric: o for o in obs if o.kind == "daily_summary"}
    assert summ["resting_heart_rate"].value_num == 52 and summ["resting_heart_rate"].measured_at == datetime(2026, 10, 21, 8, 27, tzinfo=timezone.utc)
    assert summ["resting_heart_rate"].period_date == date(2026, 10, 21)


def test_heart_rate_without_descriptors_is_schema_drift_not_a_guess():
    bad = {**HR, "heartRateValueDescriptors": None}
    with pytest.raises(P.SchemaDrift):
        P.parse_heart_rates(bad, CTX)
    with pytest.raises(P.SchemaDrift):
        P.parse_heart_rates([1, 2, 3], CTX)


@pytest.mark.parametrize("empty", [None, "", "No heart rate data found for 2026-10-21", "No activities found for 2026-10-21"])
def test_the_gateways_plain_text_no_data_answer_is_empty_not_an_error(empty):
    for fn in (P.parse_heart_rates, P.parse_steps, P.parse_user_summary, P.parse_activities, P.parse_stress, P.parse_sleep, P.parse_hrv, P.parse_spo2, P.parse_respiration, P.parse_readiness):
        assert fn(empty, CTX) == []


STEPS = [
    {"startGMT": "2026-10-21T08:00:00.0", "endGMT": "2026-10-21T08:15:00.0", "steps": 104, "pushes": 0, "primaryActivityLevel": "sedentary", "activityLevelConstant": False},
    {"startGMT": "2026-10-21T08:15:00.0", "endGMT": "2026-10-21T08:30:00.0", "steps": 11, "pushes": 0, "primaryActivityLevel": "sedentary", "activityLevelConstant": True},
]


def test_steps_are_intervals_with_their_own_length_and_the_open_interval_is_flagged_partial():
    obs = P.parse_steps(STEPS, CTX)
    st = [o for o in obs if o.metric == "steps_interval"]
    assert [(o.measured_at.hour, o.measured_at.minute, o.value_num, o.interval_s) for o in st] == [(8, 0, 104.0, 900), (8, 15, 11.0, 900)]
    assert st[0].meta == {} and st[1].meta == {}  # both intervals ended before the 08:46 fetch
    lvl = [o for o in obs if o.metric == "activity_level"]
    assert lvl[0].value_json == {"level": "sedentary", "constant": False} and lvl[0].value_num is None


def test_partial_flag_uses_the_fetch_time():
    early = P.Ctx(TZ, date(2026, 10, 21), datetime(2026, 10, 21, 8, 20, tzinfo=timezone.utc))
    st = [o for o in P.parse_steps(STEPS, early) if o.metric == "steps_interval"]
    assert st[0].meta == {} and st[1].meta == {"partial_interval": True}


SUMMARY = {"calendarDate": "2026-10-21", "wellnessEndTimeGmt": "2026-10-21T08:27:00.0", "totalSteps": 1849, "totalDistanceMeters": 1531, "activeSeconds": 1140, "highlyActiveSeconds": 1380, "sedentarySeconds": 9120, "moderateIntensityMinutes": 0, "vigorousIntensityMinutes": 0, "activeKilocalories": 58.0, "floorsAscended": None}


def test_cumulative_totals_keep_their_source_timestamp_and_zero_is_a_real_zero_but_none_is_absent():
    obs = {o.metric: o for o in P.parse_user_summary(SUMMARY, CTX)}
    assert obs["steps_day_cumulative"].kind == "cumulative" and obs["steps_day_cumulative"].value_num == 1849
    assert obs["steps_day_cumulative"].measured_at == datetime(2026, 10, 21, 8, 27, tzinfo=timezone.utc)
    assert obs["steps_day_cumulative"].period == "local_day"
    assert obs["intensity_minutes_moderate_day"].value_num == 0  # Garmin reported 0 minutes: a measurement
    assert "floors" not in " ".join(obs)
    nodata = dict(SUMMARY, totalSteps=None)
    assert "steps_day_cumulative" not in {o.metric for o in P.parse_user_summary(nodata, CTX)}
    with pytest.raises(P.SchemaDrift):
        P.parse_user_summary({"totalSteps": 5}, CTX)


STRESS = {
    "stressValueDescriptorsDTOList": [{"index": 0, "key": "timestamp"}, {"index": 1, "key": "stressLevel"}],
    "stressValuesArray": [[MS("2026-10-21T08:21:00"), 22], [MS("2026-10-21T08:24:00"), -1], [MS("2026-10-21T08:27:00"), -2], [MS("2026-10-21T08:30:00"), 0]],
    "bodyBatteryValueDescriptorsDTOList": [
        {"bodyBatteryValueDescriptorIndex": 0, "bodyBatteryValueDescriptorKey": "timestamp"},
        {"bodyBatteryValueDescriptorIndex": 1, "bodyBatteryValueDescriptorKey": "bodyBatteryStatus"},
        {"bodyBatteryValueDescriptorIndex": 2, "bodyBatteryValueDescriptorKey": "bodyBatteryLevel"},
        {"bodyBatteryValueDescriptorIndex": 3, "bodyBatteryValueDescriptorKey": "bodyBatteryVersion"},
    ],
    "bodyBatteryValuesArray": [[MS("2026-10-21T08:21:00"), "MEASURED", 3, 3.0], [MS("2026-10-21T08:24:00"), "MEASURED", None, 3.0]],
}


def test_stress_negative_markers_are_dropped_and_body_battery_uses_the_descriptor_index_not_the_last_element():
    obs = P.parse_stress(STRESS, CTX)
    assert [(o.measured_at.minute, o.value_num) for o in obs if o.metric == "stress_level"] == [(21, 22.0), (30, 0.0)]
    assert [(o.measured_at.minute, o.value_num) for o in obs if o.metric == "body_battery"] == [(21, 3.0)]  # the 3.0 'version' column was not mistaken for the level
    assert all(o.origin == "garmin_derived" for o in obs)


def test_sleep_hrv_use_the_right_time_zone_handling():
    sleep = {"sleep_seconds": 28560, "sleep_start": MS("2026-10-20T22:06:44"), "sleep_end": MS("2026-10-21T06:19:44"), "sleep_score": 88, "sleep_score_qualifier": "GOOD", "deep_sleep_seconds": 6120, "light_sleep_seconds": 15780, "rem_sleep_seconds": 6660, "awake_seconds": 1020, "awake_count": 1, "avg_sleep_stress": 18.0}
    o = {x.metric: x for x in P.parse_sleep(sleep, CTX)}
    assert o["sleep_duration"].measured_at == datetime(2026, 10, 21, 6, 19, 44, tzinfo=timezone.utc) and o["sleep_duration"].period_date == date(2026, 10, 21)
    assert o["sleep_stages"].value_json["rem_sleep_seconds"] == 6660 and o["sleep_score"].value_num == 88
    hrv = {"date": "2026-10-21", "last_night_avg_hrv_ms": 71, "weekly_avg_hrv_ms": 68, "status": "BALANCED", "sleep_end": "2026-10-21T09:19:44.0"}
    h = {x.metric: x for x in P.parse_hrv(hrv, CTX)}
    assert h["hrv_overnight_avg"].measured_at == datetime(2026, 10, 21, 6, 19, 44, tzinfo=timezone.utc)  # 09:19 local (UTC+3 in October) -> 06:19 UTC
    assert h["hrv_status"].value_json["status"] == "BALANCED"
    assert P.parse_sleep({"sleep_seconds": 0, "sleep_end": MS("2026-10-21T06:00:00")}, CTX) == []


def test_spo2_and_respiration_daily_summaries_do_not_invent_a_measurement_time():
    sp = {"date": "2026-10-21", "avg_spo2_percent": 97.0, "lowest_spo2_percent": 88, "latest_reading_time": "2026-10-21T08:00:00.0", "avg_sleep_spo2_percent": 98.0, "hourly_averages": [[MS("2026-10-20T21:00:00"), 96], [MS("2026-10-20T22:00:00"), None]]}
    obs = P.parse_spo2(sp, CTX)
    d = {o.metric: o for o in obs if o.kind == "daily_summary"}
    assert d["spo2_day_avg"].ts_semantics == "period_start" and d["spo2_day_avg"].measured_at == datetime(2026, 10, 20, 21, 0, tzinfo=timezone.utc)
    assert d["spo2_day_avg"].meta["latest_reading_time_unzoned"] == "2026-10-21T08:00:00.0"
    assert [o.value_num for o in obs if o.metric == "spo2_hourly"] == [96.0]
    rs = P.parse_respiration({"date": "2026-10-21", "lowest_breaths_per_min": 9.0, "highest_breaths_per_min": 21.0, "avg_waking_breaths_per_min": 12.0, "avg_sleep_breaths_per_min": None}, CTX)
    assert {o.metric for o in rs} == {"respiration_day_lowest", "respiration_day_highest", "respiration_waking_avg"}


def test_activities_and_readiness_are_marked_unverified():
    acts = [{"activityId": 99, "startTimeGMT": "2026-10-21 05:00:00", "duration": 1800.5, "activityType": {"typeKey": "walking"}, "distance": 2100.0, "averageHR": 101, "maxHR": 120, "calories": 150}]
    a = P.parse_activities(acts, CTX)
    assert len(a) == 1 and a[0].metric == "exercise_session" and a[0].value_num == 1800.5 and a[0].value_json["type"] == "walking" and a[0].meta == {"schema_verified": False}
    assert a[0].measured_at == datetime(2026, 10, 21, 5, 0, tzinfo=timezone.utc)
    with pytest.raises(P.SchemaDrift):
        P.parse_activities({"activities": "x"}, CTX)
    r = P.parse_readiness({"score": 61, "level": "MODERATE"}, CTX)
    assert r[0].value_json == {"score": 61, "level": "MODERATE"} and r[0].meta == {"schema_verified": False}


def test_nan_and_booleans_are_not_numbers():
    assert P.num(float("nan")) is None and P.num(True) is None and P.num("5") is None and P.num(0) == 0.0
