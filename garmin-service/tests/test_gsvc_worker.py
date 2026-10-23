"""The poller with a fake Personal API client and the in-memory store: scheduling, backoff, the pause flags, and the states /status reads."""
from datetime import datetime, timedelta, timezone

import pytest

from gsvc.config import load_settings
from gsvc.personal import ApiError
from gsvc.store import MemStore
from gsvc.worker import AUTH_FAILED_FILE, PAUSED_FILE, SLOW_EVERY_MIN, Worker

UTC = timezone.utc
T = datetime(2026, 10, 22, 9, 0, tzinfo=UTC)  # 12:00 in Beirut
DESC = [{"index": 0, "key": "timestamp"}, {"index": 1, "key": "heartrate"}]
MS = int(datetime(2026, 10, 22, 8, 0, tzinfo=UTC).timestamp() * 1000)


class FakeClient:
    def __init__(self, answers=None):
        self.answers, self.paths = answers or {}, []

    def get(self, path):
        self.paths.append(path)
        for needle, a in self.answers.items():
            if needle in path:
                if isinstance(a, Exception):
                    raise a
                return a
        return None


def good():
    return {
        "dailyHeartRate": {"calendarDate": "2026-10-22", "endTimestampGMT": "2026-10-22T08:58:00.0", "restingHeartRate": 52, "heartRateValueDescriptors": DESC, "heartRateValues": [[MS, 70], [MS + 120000, 72]]},
        "dailysummaries": {"data": [{"calendarDate": "2026-10-22", "wellnessChronology": {"endTimestampGmt": "2026-10-22T08:58:00.0"}, "movement": {"steps": {"value": 4000, "distanceInMeters": 3000.0}}}]},
        "activities/search": [{"activityId": 9, "startTimeGMT": "2026-10-21 17:04:30", "duration": 3000.0, "activityType": {"typeKey": "strength_training"}}],
        "bodyBattery": [],
        "dailySleep": None,
        "hrv-service": None,
    }


def make(env=None, client=None, tmp=None, now=T, store=None):
    s = load_settings({"GARMIN_POLLING_ENABLED": "true", "GARMIN_PERSONAL_API_KEY": "k", "GARMIN_STATE_DIR": str(tmp or "/nonexistent-state"), **(env or {})}, env_file=None)
    st = store or MemStore()
    clock = [now]
    w = Worker(s, st, client or FakeClient(good()), now_fn=lambda: clock[0], sleep_fn=lambda s_: None, rand=lambda: 0.0)
    return w, st, clock


def test_one_cycle_stores_samples_totals_and_sessions_and_marks_every_group():
    w, st, _ = make()
    res = w.run_cycle()
    assert "fast" in res["ran"] and "hrv" in res["ran"] and "sleep" in res["ran"] and "stress" in res["ran"]
    latest = {o.metric: o for o in st.latest_per_metric(None)}
    assert latest["heart_rate"].value_num == 72 and latest["steps_day_cumulative"].value_num == 4000 and latest["exercise_session"].value_num == 3000.0 and latest["resting_heart_rate"].value_num == 52
    states = st.all_states()
    assert states["fast"]["last_outcome"] == "ok" and states["fast"]["last_success_at"] is not None
    for g in ("stress", "sleep", "hrv"):
        assert states[g]["last_outcome"] == "empty" and states[g]["consecutive_failures"] == 0     # an empty answer is an attempt, not a failure
    assert "spo2_resp" in states
    assert w.counters["requests"] == len(w.client.paths) and len(st.runs) >= 6


def test_slow_calls_are_not_repeated_within_30_minutes_but_the_fast_ones_are():
    w, st, clock = make()
    w.run_cycle()
    first = len(w.client.paths)
    clock[0] = T + timedelta(minutes=10)
    w.run_cycle()
    second = w.client.paths[first:]
    assert any("dailyHeartRate" in p for p in second) and any("dailysummaries" in p for p in second)
    assert not any(k in p for p in second for k in ("dailySleep", "hrv-service", "bodyBattery", "activities/search"))
    clock[0] = T + timedelta(minutes=SLOW_EVERY_MIN + 1)
    n = len(w.client.paths)
    w.run_cycle()
    assert any("dailySleep" in p for p in w.client.paths[n:]) and any("hrv-service" in p for p in w.client.paths[n:])


def test_shortly_after_midnight_the_previous_day_is_fetched_too():
    w, _, _ = make(now=datetime(2026, 10, 22, 21, 30, tzinfo=UTC))   # 00:30 on the 23rd in Beirut
    w.run_cycle()
    days = {p.split("date=")[1] for p in w.client.paths if "dailyHeartRate" in p}
    assert days == {"2026-10-22", "2026-10-23"}


def test_a_rejected_key_pauses_polling_until_someone_resumes(tmp_path):
    c = FakeClient({**good(), "dailyHeartRate": ApiError("auth", 401)})
    w, st, _ = make(client=c, tmp=tmp_path)
    w.run_cycle()
    assert (tmp_path / AUTH_FAILED_FILE).exists() and "rejected the Personal API key" in w.paused_reason()
    n = len(c.paths)
    assert len(c.paths) == n and st.all_states()["fast"]["last_outcome"] == "auth_failed" and st.all_states()["fast"]["consecutive_failures"] == 1
    (tmp_path / AUTH_FAILED_FILE).unlink()
    assert w.paused_reason() is None


def test_rate_limit_backs_off_exponentially_and_honours_retry_after():
    c = FakeClient({**good(), "dailyHeartRate": ApiError("rate_limited", 429, retry_after=1800)})
    w, _, clock = make(client=c)
    w.run_cycle()
    assert w.backoff_until == T + timedelta(seconds=1800) and w.counters["rate_limits"] == 1
    n = len(c.paths)
    clock[0] = T + timedelta(minutes=10)
    assert "backing off" in w.run_cycle()["note"] and len(c.paths) == n    # no request while backing off
    clock[0] = T + timedelta(minutes=31)
    c.answers["dailyHeartRate"] = good()["dailyHeartRate"]
    w.run_cycle()
    assert w.backoff_until is None and w.fail_streak == 0


def test_transient_errors_back_off_and_a_success_resets_the_streak():
    c = FakeClient({**good(), "dailyHeartRate": ApiError("transient", 503)})
    w, _, clock = make(client=c)
    w.run_cycle()
    assert w.fail_streak == 1 and w.backoff_until == T + timedelta(minutes=10)
    clock[0] = T + timedelta(minutes=11)
    w.run_cycle()
    assert w.fail_streak == 2 and w.backoff_until == clock[0] + timedelta(minutes=20)
    c.answers["dailyHeartRate"] = good()["dailyHeartRate"]
    clock[0] += timedelta(minutes=21)
    w.run_cycle()
    assert w.fail_streak == 0


def test_a_changed_payload_is_a_schema_drift_run_and_the_other_calls_still_store():
    c = FakeClient({**good(), "dailyHeartRate": {"heartRateValues": [[MS, 70]], "heartRateValueDescriptors": [{"index": 0, "key": "bpm"}]}})
    w, st, _ = make(client=c)
    w.run_cycle()
    assert any(r.outcome == "schema_drift" for r in st.runs)
    assert {o.metric for o in st.latest_per_metric(None)} >= {"steps_day_cumulative", "exercise_session"}
    assert "heart_rate" not in {o.metric for o in st.latest_per_metric(None)}


def test_a_404_on_one_path_does_not_stop_the_others():
    c = FakeClient({**good(), "dailysummaries": ApiError("client", 404)})
    w, st, _ = make(client=c)
    w.run_cycle()
    assert "heart_rate" in {o.metric for o in st.latest_per_metric(None)} and w.backoff_until is None


def test_unchanged_answers_are_not_new_rows():
    w, st, clock = make()
    w.run_cycle()
    clock[0] = T + timedelta(minutes=10)
    w.run_cycle()
    assert st.all_states()["fast"]["last_outcome"] == "unchanged"
    assert sum(1 for o in st.history(["heart_rate"], T - timedelta(days=1), T + timedelta(days=1), 100)) == 2


@pytest.mark.parametrize("env,reason", [({"GARMIN_POLLING_ENABLED": "false"}, "disabled"), ({"GARMIN_PERSONAL_API_KEY": ""}, "no Personal API key")])
def test_polling_needs_the_switch_and_a_key(env, reason):
    w, _, _ = make(env=env)
    assert reason in w.paused_reason()


def test_operator_pause_file_stops_the_worker(tmp_path):
    w, _, _ = make(tmp=tmp_path)
    (tmp_path / PAUSED_FILE).write_text("x")
    assert "paused by an operator" in w.paused_reason()


def test_poll_interval_is_never_below_five_minutes():
    with pytest.raises(Exception):
        load_settings({"GARMIN_POLL_MIN": "1"}, env_file=None)


def test_heartbeat_carries_the_fields_the_status_route_reads():
    w, st, _ = make()
    w.run_cycle()
    w.heartbeat(None, "ok")
    extra = st.all_states()["_worker"]["extra"]
    assert extra["gate"]["backoff_until"] is None and extra["intervals"]["fast_min"] == 10 and extra["counters"]["requests"] > 0
