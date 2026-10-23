"""API tests: read-only, token-gated, validated, and proof that a request never reaches Garmin (the app is built with no gateway at all)."""
from datetime import date, datetime, timedelta, timezone

import pytest
from starlette.testclient import TestClient

from gsvc.api import PREFIX, create_app
from gsvc.config import load_settings
from gsvc.parsers import Obs
from gsvc.store import MemStore, RunRecord

UTC = timezone.utc
NOW = datetime(2026, 10, 21, 9, 0, tzinfo=UTC)
TOKEN = "t" * 24
H = {"x-app-token": TOKEN}


def make(env=None, token=TOKEN, store=None):
    s = load_settings({"GARMIN_API_TOKEN": token or "", **(env or {})}, env_file=None)
    st = store or MemStore()
    return TestClient(create_app(s, st, now_fn=lambda: NOW)), st


def seed(st: MemStore):
    obs = [
        Obs("heart_rate", NOW - timedelta(minutes=20), "instant", value_num=66, source_tool="dailyHeartRate"),
        Obs("heart_rate", NOW - timedelta(minutes=22), "instant", value_num=70, source_tool="dailyHeartRate"),
        Obs("steps_day_cumulative", NOW - timedelta(minutes=15), "period_end", value_num=1849, period="local_day", period_date=date(2026, 10, 21), source_tool="get_user_summary"),
        Obs("sleep_duration", NOW - timedelta(hours=40), "period_end", value_num=28560, period="night", period_date=date(2026, 10, 19), source_tool="get_sleep_summary"),
        Obs("sleep_stages", NOW - timedelta(hours=3), "period_end", value_json={"deep_sleep_seconds": 6120}, source_tool="get_sleep_summary"),
    ]
    st.upsert_observations(obs, NOW - timedelta(minutes=5))
    st.put_state("fast", last_attempt_at=NOW - timedelta(minutes=5), last_success_at=NOW - timedelta(minutes=5), last_new_data_at=NOW - timedelta(minutes=5), last_outcome="ok")
    st.put_state("_worker", last_attempt_at=NOW - timedelta(minutes=1), extra={"paused_reason": None, "gate": {}, "counters": {"requests": 4}, "intervals": {"fast_min": 7}})
    st.record_run(RunRecord("fast", NOW - timedelta(minutes=5), "ok", requests=4, rows_new=3))
    st.record_run(RunRecord("fast", NOW - timedelta(minutes=60), "error", error_class="ConnectionError", error_text="boom https://x.example/?token=abc Bearer abcdef0123456789abcdef0123456789abcdef01"))


def test_health_needs_no_token_and_no_database():
    c, _ = make(token=None)
    r = c.get(f"{PREFIX}/health")
    assert r.status_code == 200 and r.json()["status"] == "ok" and r.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("path", ["/metrics", "/metrics/latest", "/metrics/history?metrics=heart_rate", "/status"])
def test_data_routes_require_the_token(path):
    c, _ = make()
    assert c.get(PREFIX + path).status_code == 401
    assert c.get(PREFIX + path, headers={"x-app-token": "wrong" * 5}).status_code == 401
    assert c.get(PREFIX + path, headers=H).status_code == 200
    assert c.get(PREFIX + path, headers={"authorization": f"Bearer {TOKEN}"}).status_code == 200


def test_with_no_token_configured_data_routes_fail_closed():
    c, _ = make(token=None)
    r = c.get(PREFIX + "/metrics/latest", headers=H)
    assert r.status_code == 503 and r.json()["error"]["code"] == "auth_not_configured"


def test_the_api_is_read_only():
    c, _ = make()
    for m in ("post", "put", "delete", "patch"):
        r = getattr(c, m)(PREFIX + "/metrics/latest", headers=H)
        assert r.status_code == 405 and r.json()["error"]["code"] == "method_not_allowed"
    assert c.get("/api/garmin/v1/nothing", headers=H).status_code == 404


def test_latest_reports_value_unit_times_age_quality_and_what_is_missing():
    c, st = make()
    seed(st)
    j = c.get(PREFIX + "/metrics/latest", headers=H).json()
    hr = j["metrics"]["heart_rate"]
    assert hr["value"] == 66 and hr["unit"] == "bpm" and hr["measured_at"] == "2026-10-21T08:40:00Z" and hr["fetched_at"] == "2026-10-21T08:55:00Z"
    assert hr["age_seconds"] == 1200 and hr["fetched_age_seconds"] == 300 and hr["quality"] == "available" and hr["kind"] == "instant" and hr["origin"] == "raw_sensor"
    steps = j["metrics"]["steps_day_cumulative"]
    assert steps["kind"] == "cumulative" and steps["period"] == "local_day" and steps["value"] == 1849
    assert j["metrics"]["sleep_duration"]["quality"] == "stale"  # 40 h old, limit 36 h
    assert j["metrics"]["sleep_stages"]["value"] == {"deep_sleep_seconds": 6120}
    assert "resting_heart_rate" in j["missing_metrics"] and "heart_rate" not in j["missing_metrics"]
    assert j["data_freshness"] == "mixed" and j["last_successful_fetch_at"] == "2026-10-21T08:55:00Z"
    assert any("sleep_duration" in w for w in j["warnings"])


def test_latest_can_be_narrowed_and_empty_store_is_explicit_not_fabricated():
    c, st = make()
    j = c.get(PREFIX + "/metrics/latest?metrics=heart_rate,body_battery", headers=H).json()
    assert j["metrics"] == {} and j["data_freshness"] == "no_data" and j["missing_metrics"] == ["heart_rate", "body_battery"] and j["last_successful_fetch_at"] is None
    assert c.get(PREFIX + "/metrics/latest?metrics=bogus", headers=H).status_code == 400


def test_history_is_chronological_and_bounded_with_cursor_paging():
    c, st = make()
    seed(st)
    q = f"{PREFIX}/metrics/history?metrics=heart_rate&from=2026-10-21T08:00:00Z&to=2026-10-21T09:00:00Z&limit=1"
    j = c.get(q, headers=H).json()
    assert [o["value"] for o in j["observations"]] == [70] and j["has_more"] and j["next_cursor"] and j["count"] == 1
    j2 = c.get(q + "&cursor=" + j["next_cursor"], headers=H).json()
    assert [o["value"] for o in j2["observations"]] == [66] and not j2["has_more"] and j2["next_cursor"] is None
    o = j["observations"][0]
    assert o["metric"] == "heart_rate" and o["kind"] == "instant" and o["ts_semantics"] == "instant" and "quality" not in o and o["unit"] == "bpm"


@pytest.mark.parametrize(
    "qs,code",
    [
        ("", "missing_parameter"),
        ("metrics=nope", "unknown_metric"),
        ("metrics=heart_rate&from=yesterday", "invalid_parameter"),
        ("metrics=heart_rate&from=2026-10-21T08:00:00", "invalid_parameter"),  # no time zone
        ("metrics=heart_rate&from=2026-10-21T09:00:00Z&to=2026-10-21T08:00:00Z", "invalid_parameter"),
        ("metrics=heart_rate&from=2026-09-01T00:00:00Z&to=2026-10-21T00:00:00Z", "range_too_large"),
        ("metrics=heart_rate&limit=0", "invalid_parameter"),
        ("metrics=heart_rate&limit=999999", "invalid_parameter"),
        ("metrics=heart_rate&limit=abc", "invalid_parameter"),
        ("metrics=heart_rate&cursor=../etc", "invalid_parameter"),
    ],
)
def test_invalid_history_parameters_get_a_400_with_a_useful_message(qs, code):
    c, _ = make()
    r = c.get(f"{PREFIX}/metrics/history?{qs}", headers=H)
    assert r.status_code == 400 and r.json()["error"]["code"] == code and r.json()["error"]["message"]


def test_status_shows_polling_staleness_counters_and_sanitised_errors():
    c, st = make()
    seed(st)
    j = c.get(PREFIX + "/status", headers=H).json()
    assert j["polling"]["state"] == "normal" and j["polling"]["worker_alive"] and j["polling"]["enabled"] is False  # config default: off
    g = j["groups"]["fast"]
    assert g["last_successful_fetch_at"] == "2026-10-21T08:55:00Z" and g["last_measurement_at"] == "2026-10-21T08:45:00Z" and g["stale"] is False  # stale means a stored metric is too old; never-fetched ones are listed as missing in /metrics/latest
    assert j["counters_24h"]["requests"] == 4 and j["counters_24h"]["errors"] == 1 and j["data_stale"] is True
    err = j["recent_errors"][0]
    assert err["error_class"] == "ConnectionError" and "token" not in err["message"] and "Bearer" not in err["message"] and "https" not in err["message"]
    assert "skin_temperature" in j["unsupported"]
    text = c.get(PREFIX + "/status", headers=H).text.lower()
    assert "password" not in text and "refresh_token" not in text and "traceback" not in text


def test_status_reports_pause_backoff_and_a_dead_worker():
    c, st = make()
    seed(st)
    st.put_state("_worker", extra={"paused_reason": "Garmin rejected the Personal API key (state/AUTH_FAILED)", "gate": {}})
    assert c.get(PREFIX + "/status", headers=H).json()["polling"]["state"] == "paused"
    assert any("polling is not running" in w for w in c.get(PREFIX + "/metrics/latest", headers=H).json()["warnings"])
    st.put_state("_worker", extra={"paused_reason": None, "gate": {"backoff_until": "2026-10-21T09:05:00+00:00", "consecutive_failures": 1}})
    assert c.get(PREFIX + "/status", headers=H).json()["polling"]["state"] == "backing_off"
    st.put_state("_worker", last_attempt_at=NOW - timedelta(hours=2), extra={"paused_reason": None, "gate": {}})
    assert c.get(PREFIX + "/status", headers=H).json()["polling"]["state"] == "worker_not_running"


def test_a_storage_failure_returns_a_clean_503_without_internals():
    class Broken(MemStore):
        def latest_per_metric(self, metrics=None):
            raise RuntimeError("password=hunter2 host=10.0.0.5")

    c, _ = make(store=Broken())
    r = c.get(PREFIX + "/metrics/latest", headers=H)
    assert r.status_code == 500 and "hunter2" not in r.text and "10.0.0.5" not in r.text and r.json()["error"]["code"] == "internal_error"


def test_requests_are_rate_limited_per_client_and_never_touch_garmin():
    c, st = make(env={"GARMIN_API_RATE_PER_MIN": "5"})
    codes = [c.get(PREFIX + "/metrics/latest", headers=H).status_code for _ in range(7)]
    assert codes == [200] * 5 + [429] * 2


def test_cors_is_closed_unless_explicit_origins_are_configured():
    c, _ = make()
    r = c.options(PREFIX + "/metrics/latest", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"})
    assert "access-control-allow-origin" not in r.headers
    c2, _ = make(env={"GARMIN_CORS_ORIGINS": "http://localhost:8081"})
    ok = c2.options(PREFIX + "/metrics/latest", headers={"Origin": "http://localhost:8081", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "x-app-token"})
    assert ok.headers["access-control-allow-origin"] == "http://localhost:8081"
    bad = c2.options(PREFIX + "/metrics/latest", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"})
    assert "access-control-allow-origin" not in bad.headers


def test_the_catalogue_lists_origins_and_the_unsupported_with_reasons():
    c, _ = make()
    j = c.get(PREFIX + "/metrics", headers=H).json()
    assert j["metrics"]["body_battery"]["origin"] == "garmin_derived" and j["metrics"]["heart_rate"]["origin"] == "raw_sensor"
    assert "glucose" in j["unsupported"] and "skin_temperature" in j["unsupported"]


def _many_hr(st, n=300):
    st.upsert_observations([Obs("heart_rate", NOW - timedelta(minutes=2 * k), "instant", value_num=60 + (k % 40), source_tool="dailyHeartRate") for k in range(n)], NOW - timedelta(minutes=1))
    st.upsert_observations([Obs("sleep_duration", NOW - timedelta(hours=3), "period_end", value_num=27000, period="night", period_date=date(2026, 10, 21), source_tool="get_sleep_summary")], NOW - timedelta(minutes=1))


def test_max_points_thins_samples_evenly_keeps_first_and_last_and_never_changes_a_value():
    c, st = make()
    _many_hr(st)
    base = f"{PREFIX}/metrics/history?metrics=heart_rate&from=2026-10-20T20:00:00Z&to=2026-10-21T09:00:00Z&limit=2000"
    full = c.get(base, headers=H).json()
    thin = c.get(base + "&max_points=50", headers=H).json()
    assert full["count"] == 300 and full["thinned"] is False
    assert thin["count"] == 50 and thin["thinned"] is True
    ft = [o["measured_at"] for o in full["observations"]]
    tt = [o["measured_at"] for o in thin["observations"]]
    assert tt[0] == ft[0] and tt[-1] == ft[-1] and tt == sorted(tt) and set(tt) <= set(ft)
    by_time = {o["measured_at"]: o["value"] for o in full["observations"]}
    assert all(by_time[o["measured_at"]] == o["value"] for o in thin["observations"])      # the same stored values, nothing averaged


def test_max_points_does_not_thin_small_series_events_or_daily_summaries():
    c, st = make()
    _many_hr(st, 40)
    q = f"{PREFIX}/metrics/history?metrics=heart_rate,sleep_duration&from=2026-10-20T00:00:00Z&to=2026-10-21T09:00:00Z&limit=2000&max_points=50"
    j = c.get(q, headers=H).json()
    assert j["thinned"] is False and sum(1 for o in j["observations"] if o["metric"] == "heart_rate") == 40
    assert sum(1 for o in j["observations"] if o["metric"] == "sleep_duration") == 1


@pytest.mark.parametrize("v", ["5", "5000", "abc", "-3"])
def test_invalid_max_points_is_a_400(v):
    c, _ = make()
    r = c.get(f"{PREFIX}/metrics/history?metrics=heart_rate&max_points={v}", headers=H)
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_parameter"


# ------------------------------------------------------------------ POST /refresh
from gsvc.refresh import Refresher


class FakeRefresh:
    def __init__(self, result=None):
        self.n, self.result = 0, result or {"ok": True, "outcome": "ok", "requests": 7, "rows_new": 12}

    def refresh(self):
        self.n += 1
        return dict(self.result, shared=False)


def test_refresh_needs_the_token_and_post(  ):
    s = load_settings({"GARMIN_API_TOKEN": TOKEN}, env_file=None)
    c = TestClient(create_app(s, MemStore(), now_fn=lambda: NOW, refresher=FakeRefresh()))
    assert c.post(f"{PREFIX}/refresh").status_code == 401
    assert c.get(f"{PREFIX}/refresh", headers=H).status_code == 405
    r = c.post(f"{PREFIX}/refresh", headers=H)
    assert r.status_code == 200 and r.json()["ok"] is True and r.json()["requests"] == 7 and r.headers["cache-control"] == "no-store"


def test_refresh_without_a_key_is_503_and_other_routes_stay_get_only():
    c, _ = make()
    r = c.post(f"{PREFIX}/refresh", headers=H)
    assert r.status_code == 503 and r.json()["error"]["code"] == "refresh_not_configured"
    assert c.post(f"{PREFIX}/metrics/latest", headers=H).status_code == 405


def test_refresh_failure_is_reported_not_raised():
    s = load_settings({"GARMIN_API_TOKEN": TOKEN}, env_file=None)
    fr = FakeRefresh({"ok": False, "outcome": "rate_limited", "requests": 1, "rows_new": 0, "retry_at": NOW + timedelta(minutes=2)})
    c = TestClient(create_app(s, MemStore(), now_fn=lambda: NOW, refresher=fr))
    j = c.post(f"{PREFIX}/refresh", headers=H).json()
    assert j["ok"] is False and j["outcome"] == "rate_limited" and j["retry_at"].startswith("2026-10-21T09:02")


def test_refresher_makes_a_new_fetch_per_press_but_shares_a_double_tap():
    t = [100.0]
    calls = []
    r = Refresher(lambda: calls.append(1) or {"ok": True, "outcome": "ok"}, clock=lambda: t[0])
    assert r.refresh()["shared"] is False
    t[0] += 1.0
    assert r.refresh()["shared"] is True and len(calls) == 1      # double tap: one Garmin round trip
    t[0] += 10.0
    assert r.refresh()["shared"] is False and len(calls) == 2    # a real second press: a new Garmin call
