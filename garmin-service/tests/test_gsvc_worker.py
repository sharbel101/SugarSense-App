import asyncio
import json
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import pytest

from gsvc import gateway as gw
from gsvc.config import load_settings
from gsvc.store import MemStore
from gsvc.worker import AUTH_FAILED_FILE, PAUSED_FILE, Worker
from oauth_support import NeedsLogin
from rate_gate import BACKOFF_SCHEDULE_MIN, BREAKER_PAUSE_S, MIN_REQUEST_GAP_S, CallBlocked, Gate

T0 = datetime(2026, 10, 21, 9, 0, tzinfo=timezone.utc).timestamp()  # 12:00 Beirut


class Clock:
    def __init__(self, t=T0):
        self.t = t

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.t += s

    def now(self):
        return datetime.fromtimestamp(self.t, timezone.utc)


HR = {
    "calendarDate": "2026-10-21",
    "endTimestampGMT": "2026-10-21T08:55:00.0",
    "restingHeartRate": 52,
    "heartRateValueDescriptors": [{"index": 0, "key": "timestamp"}, {"index": 1, "key": "heartrate"}],
    "heartRateValues": [[1792572000000, 70], [1792572120000, 72]],
}
STEPS = [{"startGMT": "2026-10-21T08:30:00.0", "endGMT": "2026-10-21T08:45:00.0", "steps": 50, "primaryActivityLevel": "active", "activityLevelConstant": False}]
SUMMARY = {"calendarDate": "2026-10-21", "wellnessEndTimeGmt": "2026-10-21T08:55:00.0", "totalSteps": 1000}
STRESS = {
    "stressValueDescriptorsDTOList": [{"index": 0, "key": "timestamp"}, {"index": 1, "key": "stressLevel"}],
    "stressValuesArray": [[1792572000000, 20]],
    "bodyBatteryValuesArray": [],
}
ANSWERS = {
    "get_heart_rates": HR,
    "get_steps_data": STEPS,
    "get_user_summary": SUMMARY,
    "get_activities_fordate": "No activities found for 2026-10-21",
    "get_stress_data": STRESS,
    "get_sleep_summary": "No sleep data found",
    "get_hrv_data": "No HRV data found",
    "get_spo2_data": "No SpO2 data",
    "get_respiration_summary": "No respiration data",
    "get_training_readiness": "No training readiness data found for 2026-10-21",
}


class FakeSession:
    def __init__(self, answers, fail, log, gate):
        self.answers, self.fail, self.log, self.gate = answers, fail, log, gate

    async def call(self, name, args):
        gw.ensure_read_only(name)
        self.gate.before_request()  # the real session does this for every call
        self.log.append((name, args))
        f = self.fail.get(name)
        if f is not None:
            raise f
        return self.answers[name]


class FakeGateway:
    def __init__(self, gate, answers=None, fail=None, connect_error=None):
        self.gate, self.answers, self.fail, self.connect_error = gate, dict(ANSWERS if answers is None else answers), fail or {}, connect_error
        self.calls: list = []
        self.sessions = 0

    @asynccontextmanager
    async def session(self):
        self.gate.before_request()
        if self.connect_error:
            raise self.connect_error
        self.sessions += 1
        yield FakeSession(self.answers, self.fail, self.calls, self.gate)


def make(tmp_path, enabled=True, **kw):
    c = Clock()
    gate = Gate(tmp_path / "gate" / "g.json", clock=c, sleep=c.sleep, jitter=lambda: 0.0)
    settings = load_settings({"GARMIN_POLLING_ENABLED": "true" if enabled else "false", "GARMIN_STATE_DIR": str(tmp_path / "state"), **kw.pop("env", {})}, env_file=None)
    fg = FakeGateway(gate, **kw)
    store = MemStore()
    w = Worker(settings, store, gate, fg, tmp_path / "NEEDS_LOGIN", now_fn=c.now, rand=lambda: 0.0)
    return w, fg, store, c, gate


def run(coro):
    return asyncio.run(coro)


def test_first_cycle_polls_what_is_due_stores_data_and_a_second_cycle_does_nothing(tmp_path):
    w, fg, store, c, gate = make(tmp_path)
    res = run(w.run_cycle())
    assert set(res["ran"]) >= {"fast", "stress"}  # slot jobs are also open at noon, they answer 'empty'
    names = [n for n, _ in fg.calls]
    assert names.count("get_heart_rates") == 1 and names.count("get_stress_data") == 1
    assert all(args["date"] == "2026-10-21" for _, args in fg.calls)
    assert {o.metric for o in store.obs.values()} >= {"heart_rate", "steps_interval", "steps_day_cumulative", "stress_level", "resting_heart_rate"}
    again = run(w.run_cycle())
    assert again["ran"] == [] and fg.sessions == 1


def test_requests_are_spaced_by_the_shared_gate_and_one_session_serves_the_whole_cycle(tmp_path):
    w, fg, store, c, gate = make(tmp_path)
    t0 = c.t
    run(w.run_cycle())
    assert fg.sessions == 1
    assert c.t - t0 >= MIN_REQUEST_GAP_S * len(fg.calls)


def test_poll_floor_blocks_a_second_session_within_five_minutes_even_if_a_job_is_due(tmp_path):
    w, fg, store, c, gate = make(tmp_path, env={"GARMIN_FAST_INTERVAL_MIN": "5"})
    run(w.run_cycle())
    c.t += 5 * 60 - 1
    gate.mark_polled()  # another process polled just now
    r = run(w.run_cycle())
    assert r["ran"] == [] and fg.sessions == 1


def test_restart_does_not_burst(tmp_path):
    w, fg, store, c, gate = make(tmp_path)
    run(w.run_cycle())
    n = len(fg.calls)
    # a brand new worker process on the same store, one minute later
    c.t += 60
    w2 = Worker(w.s, store, gate, fg, tmp_path / "NEEDS_LOGIN", now_fn=c.now, rand=lambda: 0.0)
    assert run(w2.run_cycle())["ran"] == [] and len(fg.calls) == n


def test_unchanged_answers_are_cache_hits_and_create_no_rows(tmp_path):
    w, fg, store, c, gate = make(tmp_path)
    run(w.run_cycle())
    rows = len(store.obs)
    c.t += 8 * 60
    run(w.run_cycle())
    assert len(store.obs) == rows
    last = store.recent_runs(w.now().replace(year=2000))[0]
    assert last.job in {"fast", "stress", "sleep", "hrv", "spo2_resp", "readiness"}
    fast_runs = [r for r in store.runs if r.job == "fast"]
    assert fast_runs[-1].outcome == "unchanged" and fast_runs[-1].cache_hits >= 3 and fast_runs[-1].rows_new == 0


def test_new_data_in_a_later_answer_is_added_and_counted(tmp_path):
    w, fg, store, c, gate = make(tmp_path)
    run(w.run_cycle())
    fg.answers["get_heart_rates"] = {**HR, "heartRateValues": HR["heartRateValues"] + [[1792572240000, 75]]}
    c.t += 8 * 60
    run(w.run_cycle())
    assert sum(1 for o in store.obs.values() if o.metric == "heart_rate") == 3
    assert [r for r in store.runs if r.job == "fast"][-1].rows_new == 1


def test_rate_limit_stops_the_cycle_starts_the_backoff_and_blocks_further_requests(tmp_path):
    w, fg, store, c, gate = make(tmp_path, fail={"get_steps_data": RuntimeError("HTTP 429 Too Many Requests")})
    run(w.run_cycle())
    assert "get_user_summary" not in [n for n, _ in fg.calls]  # stopped right after the 429
    snap = gate.snapshot()
    assert round((snap["backoff_until"] - c.t) / 60) == BACKOFF_SCHEDULE_MIN[0]
    assert [r for r in store.runs if r.job == "fast"][-1].outcome == "rate_limited"
    with pytest.raises(CallBlocked):
        gate.before_request()
    before, sessions = len(fg.calls), fg.sessions
    c.t += 4 * 60  # still inside the 5 minute backoff
    assert run(w.run_cycle())["ran"] == [] and len(fg.calls) == before and fg.sessions == sessions


def test_retry_after_longer_than_the_schedule_is_respected_and_jitterless_cap_applies():
    class E(Exception):
        def __init__(self):
            self.response = type("R", (), {"headers": {"retry-after": "900"}})()

    assert gw.retry_after_seconds(E()) == 900
    assert gw.retry_after_seconds(RuntimeError("HTTP 429, Retry-After: 120")) == 120
    assert gw.retry_after_seconds(RuntimeError("HTTP 429")) is None
    assert gw.retry_after_seconds(RuntimeError("Retry-After: Wed, 21 Oct 2026 07:28:00 GMT")) is None


def test_gate_applies_retry_after_but_never_less_than_the_schedule(tmp_path):
    c = Clock()
    g = Gate(tmp_path / "g.json", clock=c, sleep=c.sleep, jitter=lambda: 0.0)
    g.record_failure(rate_limited=True, retry_after_s=900)
    assert round((g.snapshot()["backoff_until"] - c.t) / 60) == 15
    g2 = Gate(tmp_path / "h.json", clock=c, sleep=c.sleep, jitter=lambda: 0.0)
    g2.record_failure(rate_limited=True, retry_after_s=30)
    assert round((g2.snapshot()["backoff_until"] - c.t) / 60) == 5


def test_auth_failure_pauses_polling_and_is_never_retried_or_turned_into_a_login(tmp_path):
    w, fg, store, c, gate = make(tmp_path, fail={"get_heart_rates": gw.ToolError("401 Unauthorized: Garmin session expired")})
    run(w.run_cycle())
    assert (w.s.state_dir / AUTH_FAILED_FILE).exists() and "rejected" in w.paused_reason()
    n = len(fg.calls)
    c.t += 3600

    async def drive():  # the real loop, three iterations, no waiting
        loops = []

        async def fake_sleep(sec):
            loops.append(sec)
            c.t += sec
            if len(loops) >= 4:
                w.stop()

        w._sleep = fake_sleep
        await w.run_forever()
        return loops

    run(drive())
    assert len(fg.calls) == n and fg.sessions == 1  # paused: not one more request, no new session
    (w.s.state_dir / AUTH_FAILED_FILE).unlink()  # only a human removing the flag (run `resume`) re-enables polling
    assert w.paused_reason() is None


def test_needs_login_at_connect_sends_nothing_and_pauses(tmp_path):
    w, fg, store, c, gate = make(tmp_path, connect_error=NeedsLogin("tokens missing"))
    (tmp_path / "NEEDS_LOGIN").write_text("{}")  # oauth_support writes this when it refuses a sign-in
    res = run(w.run_cycle())
    assert "needs_login" in res["note"] and fg.calls == []
    assert "NEEDS_LOGIN" in w.paused_reason()
    assert gate.snapshot()["consecutive_failures"] == 0  # not a service failure


def test_transient_failures_trip_the_circuit_breaker_and_recover_with_one_probe(tmp_path):
    w, fg, store, c, gate = make(tmp_path, connect_error=ConnectionError("boom"))
    for _ in range(3):
        c.t += 60 * 60  # each attempt is due again
        gate.mark_polled()
        gate_state = gate.snapshot()
        gate_state["last_poll_epoch"] = 0
        gate._save(gate_state)
        run(w.run_cycle())
    with pytest.raises(CallBlocked, match="circuit breaker"):
        gate.before_request()
    c.t += BREAKER_PAUSE_S
    gate.before_request()  # the single probe is allowed


def test_a_tool_level_error_does_not_stop_the_other_tools_or_charge_the_gate(tmp_path):
    w, fg, store, c, gate = make(tmp_path, fail={"get_user_summary": gw.ToolError("invalid date argument")})
    run(w.run_cycle())
    assert "get_activities_fordate" in [n for n, _ in fg.calls]  # later tools still ran
    assert [r for r in store.runs if r.job == "fast"][-1].outcome == "partial"
    assert gate.snapshot()["consecutive_failures"] == 0
    assert not (w.s.state_dir / AUTH_FAILED_FILE).exists()


def test_schema_drift_stores_nothing_for_that_tool_and_is_recorded(tmp_path):
    w, fg, store, c, gate = make(tmp_path, answers={**ANSWERS, "get_heart_rates": {"unexpected": True}})
    run(w.run_cycle())
    assert not any(o.metric == "heart_rate" for o in store.obs.values())
    assert [r for r in store.runs if r.job == "fast"][-1].outcome == "schema_drift"


def test_early_in_the_local_day_yesterday_is_fetched_too_so_late_intervals_are_not_lost(tmp_path):
    w, fg, store, c, gate = make(tmp_path)
    c.t = datetime(2026, 10, 20, 21, 10, tzinfo=timezone.utc).timestamp()  # 00:10 local on the 21st
    run(w.run_cycle())
    days = sorted({a["date"] for n, a in fg.calls if n == "get_heart_rates"})
    assert days == ["2026-10-20", "2026-10-21"]
    assert sorted({a["date"] for n, a in fg.calls if n == "get_user_summary"}) == ["2026-10-21"]


def test_disabled_and_operator_pause_stop_polling_without_touching_data(tmp_path):
    w, fg, store, c, gate = make(tmp_path, enabled=False)
    assert "disabled" in w.paused_reason()
    w2, *_ = make(tmp_path / "b")
    assert w2.paused_reason() is None
    w2.s.state_dir.mkdir(parents=True, exist_ok=True)
    (w2.s.state_dir / PAUSED_FILE).write_text("x")
    assert "operator" in w2.paused_reason()


def test_only_read_only_tools_can_be_called():
    from gsvc.catalog import ALL_TOOLS, build_jobs

    for t in ALL_TOOLS:
        gw.ensure_read_only(t)
    used = {call.tool for j in build_jobs(load_settings({}, env_file=None)) for call in j.calls}
    assert used == set(ALL_TOOLS)
    for bad in ["log_food", "delete_workout", "upload_workout", "set_activity_name", "get_activities", "get_sleep_summary_and_delete", "request_reload", "download_activity_file"]:
        with pytest.raises(gw.ToolNotAllowed):
            gw.ensure_read_only(bad)


def test_heartbeat_mirrors_gate_and_pause_state_for_the_status_api(tmp_path):
    w, fg, store, c, gate = make(tmp_path, fail={"get_steps_data": RuntimeError("429")})
    run(w.run_cycle())
    w.heartbeat(None, "x")
    extra = store.states["_worker"]["extra"]
    assert extra["gate"]["backoff_until"] and extra["counters"]["rate_limits"] == 1 and extra["paused_reason"] is None


def test_nothing_in_the_service_can_sign_in():
    import ast
    from pathlib import Path

    root = Path(gw.__file__).parent
    for f in list(root.glob("*.py")):
        tree = ast.parse(f.read_text(encoding="utf-8"))
        for n in ast.walk(tree):
            if isinstance(n, (ast.Import, ast.ImportFrom)):
                mods = [a.name for a in n.names] + ([n.module] if isinstance(n, ast.ImportFrom) and n.module else [])
                assert not any(m and m.split(".")[0] in {"garminconnect", "garth", "getpass"} for m in mods), f.name
            if isinstance(n, ast.Call):
                fn = n.func
                name = fn.attr if isinstance(fn, ast.Attribute) else getattr(fn, "id", "")
                assert name not in {"cmd_login", "make_provider_interactive"}, f.name
            if isinstance(n, ast.Constant) and n.value is True:
                pass
        src = f.read_text(encoding="utf-8")
        assert "interactive=True" not in src, f.name
