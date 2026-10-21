import asyncio
import json
import os
import types
from contextlib import asynccontextmanager

import pytest

import connector_client as cc
from rate_gate import BACKOFF_SCHEDULE_MIN, BREAKER_PAUSE_S, MIN_REQUEST_GAP_S, POLL_MIN_INTERVAL_S, CallBlocked, Gate

T0 = 1_800_000_000.0


class Clock:
    def __init__(self, t=T0):
        self.t = t

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.t += s


def gate(tmp_path, c=None):
    c = c or Clock()
    return Gate(tmp_path / "s" / "g.json", clock=c, sleep=c.sleep, jitter=lambda: 0.0), c


def cfg(**k):
    return cc.Config(url=k.get("url", cc.DEFAULT_URL), transport=k.get("transport", "auto"))


# ------------------------------------------------------------------ fakes
class FakeResult:
    def __init__(self, value, error=False):
        self.content = [types.SimpleNamespace(type="text", text=json.dumps(value) if not isinstance(value, str) else value)]
        self.isError = error


class FakeSession:
    def __init__(self, offered=None, fail=None):
        self.offered = offered if offered is not None else list(cc.ALLOWED_TOOLS) + ["log_food", "delete_workout", "upload_workout", "set_activity_name"]
        self.fail = fail or {}
        self.calls = []

    async def list_tools(self):
        return types.SimpleNamespace(tools=[types.SimpleNamespace(name=n) for n in self.offered])

    async def call_tool(self, name, args):
        self.calls.append((name, args))
        if name in self.fail:
            raise self.fail[name]
        return FakeResult({"tool": name, "args": args})


def opener(session, record=None):
    @asynccontextmanager
    async def open_fn(cfg_, transport):
        if record is not None:
            record.append(transport)
        yield session

    return open_fn


# ------------------------------------------------------------------ policy
def test_every_allowed_tool_is_a_read_and_writes_are_refused():
    for n in cc.ALLOWED_TOOLS:
        cc.ensure_allowed(n)
        assert n.startswith("get_")
    for bad in ["log_food", "delete_workout", "upload_workout", "set_activity_name", "add_weigh_in", "schedule_workout", "create_manual_activity", "get_sleep_summary_and_delete", "get_unknown_tool", "download_activity_file", "request_reload"]:
        with pytest.raises(cc.ToolNotAllowed):
            cc.ensure_allowed(bad)


def test_poll_never_calls_a_tool_outside_the_allow_list_even_if_the_server_offers_it(tmp_path):
    g, _ = gate(tmp_path)
    s = FakeSession()
    out = asyncio.run(cc.cmd_poll(cfg(), g, "2026-10-21", tmp_path / "d", opener(s)))
    called = {c[0] for c in s.calls}
    assert called == set(cc.ALLOWED_TOOLS)
    assert not called & {"log_food", "delete_workout", "upload_workout", "set_activity_name"}
    assert out["status"] == "ok" and out["saved"] == len(cc.ALLOWED_TOOLS)


def test_tools_command_reports_what_is_usable_and_what_is_refused(tmp_path):
    g, _ = gate(tmp_path)
    r = asyncio.run(cc.cmd_tools(cfg(), g, opener(FakeSession(offered=["get_sleep_summary", "log_food", "get_stats"]))))
    assert r["usable_by_this_client"] == ["get_sleep_summary", "get_stats"] and r["refused_by_policy"] == 1 and r["offered"] == 3


# ------------------------------------------------------------------ data and files
def test_data_is_saved_privately_per_day_and_the_manifest_contains_no_values(tmp_path):
    g, _ = gate(tmp_path)
    s = FakeSession()
    asyncio.run(cc.cmd_poll(cfg(), g, "2026-10-21", tmp_path / "d", opener(s)))
    f = tmp_path / "d" / "2026-10-21" / "get_sleep_summary.json"
    assert json.loads(f.read_text())["tool"] == "get_sleep_summary"
    man = (tmp_path / "d" / "2026-10-21" / "_manifest.json").read_text()
    assert "get_sleep_summary" in man and "args" not in man
    if os.name != "nt":
        assert oct(f.stat().st_mode & 0o777) == "0o600" and oct(f.parent.stat().st_mode & 0o777) == "0o700"


def test_arguments_match_the_tool_definitions(tmp_path):
    g, _ = gate(tmp_path)
    s = FakeSession()
    asyncio.run(cc.cmd_poll(cfg(), g, "2026-10-21", tmp_path / "d", opener(s)))
    args = dict(s.calls)
    assert args["get_sleep_summary"] == {"date": "2026-10-21"}
    assert args["get_hrv_data"] == {"date": "2026-10-21", "return_timeseries": False}
    assert args["get_body_battery"] == {"start_date": "2026-10-21", "end_date": "2026-10-21"}


def test_tools_the_server_does_not_offer_are_skipped_not_guessed(tmp_path):
    g, _ = gate(tmp_path)
    s = FakeSession(offered=["get_sleep_summary"])
    out = asyncio.run(cc.cmd_poll(cfg(), g, "2026-10-21", tmp_path / "d", opener(s)))
    assert [c[0] for c in s.calls] == ["get_sleep_summary"] and out["status"] == "partial" and out["tools"]["get_stats"] == "not offered by the server"


# ------------------------------------------------------------------ gentleness
def test_poll_is_limited_to_once_per_five_minutes_and_persists(tmp_path):
    g, c = gate(tmp_path)
    asyncio.run(cc.cmd_poll(cfg(), g, "2026-10-21", tmp_path / "d", opener(FakeSession())))
    s2 = FakeSession()
    again = asyncio.run(cc.cmd_poll(cfg(), Gate(g.path, clock=c, sleep=c.sleep), "2026-10-21", tmp_path / "d", opener(s2)))
    assert again["status"] == "skipped" and s2.calls == []
    c.t += POLL_MIN_INTERVAL_S
    assert asyncio.run(cc.cmd_poll(cfg(), g, "2026-10-21", tmp_path / "d", opener(FakeSession())))["status"] == "ok"


def test_at_least_two_seconds_between_requests(tmp_path):
    g, c = gate(tmp_path)
    s = FakeSession()
    start = c.t
    asyncio.run(cc.cmd_poll(cfg(), g, "2026-10-21", tmp_path / "d", opener(s)))
    assert c.t - start >= MIN_REQUEST_GAP_S * len(cc.ALLOWED_TOOLS)


def test_a_rate_limit_answer_stops_the_poll_and_starts_a_five_minute_backoff(tmp_path):
    g, c = gate(tmp_path)
    s = FakeSession(fail={"get_stress_summary": RuntimeError("HTTP 429 Too Many Requests")})
    out = asyncio.run(cc.cmd_poll(cfg(), g, "2026-10-21", tmp_path / "d", opener(s)))
    assert out["status"] == "partial" and "get_heart_rates_summary" not in [x[0] for x in s.calls]
    st = g.snapshot()
    assert round((st["backoff_until"] - c.t) / 60) == BACKOFF_SCHEDULE_MIN[0]
    with pytest.raises(CallBlocked):
        g.before_request()


def test_three_failures_in_a_row_open_the_breaker(tmp_path):
    g, c = gate(tmp_path)
    boom = {n: RuntimeError("server error") for n in cc.ALLOWED_TOOLS}
    asyncio.run(cc.cmd_poll(cfg(), g, "2026-10-21", tmp_path / "d", opener(FakeSession(fail=boom))))
    with pytest.raises(CallBlocked, match="circuit breaker"):
        g.before_request()
    c.t += BREAKER_PAUSE_S
    g.before_request()  # one probe after the pause


def test_unreadable_gate_state_pauses_instead_of_allowing(tmp_path):
    g, c = gate(tmp_path)
    g.path.parent.mkdir(parents=True)
    g.path.write_text("garbage")
    with pytest.raises(CallBlocked):
        Gate(g.path, clock=c, sleep=c.sleep).before_request()


# ------------------------------------------------------------------ transport and secrets
def test_auto_transport_tries_streamable_then_sse_once(tmp_path):
    g, _ = gate(tmp_path)
    seen = []

    @asynccontextmanager
    async def flaky(cfg_, transport):
        seen.append(transport)
        if transport == "streamable":
            raise ConnectionError("404 not found")
        yield FakeSession()

    r = asyncio.run(cc.cmd_tools(cfg(transport="auto"), g, flaky))
    assert seen == ["streamable", "sse"] and r["offered"] > 0






def test_config_defaults_to_the_gateway_with_oauth_and_needs_no_file(tmp_path):
    c = cc.load_config(tmp_path / "absent.env")
    assert c.url == "https://missingmcp.com/garmin/mcp" and c.transport == "auto"




def test_nothing_in_this_project_can_log_in_to_garmin():
    import ast
    from pathlib import Path

    for f in Path(cc.__file__).parent.glob("*.py"):
        src = f.read_text(encoding="utf-8")
        tree = ast.parse(src)
        for n in ast.walk(tree):
            if isinstance(n, (ast.Import, ast.ImportFrom)):
                mods = [a.name for a in n.names] + ([n.module] if isinstance(n, ast.ImportFrom) and n.module else [])
                assert not any(m and m.split(".")[0] in {"garminconnect", "garth", "getpass"} for m in mods), f.name


def test_config_file_if_present_must_be_private_and_https(tmp_path):
    p = tmp_path / "connector.env"
    p.write_text("CONNECTOR_URL=http://evil.example.com/mcp\n")
    if os.name != "nt":
        os.chmod(p, 0o644)
        with pytest.raises(cc.ConfigError, match="chmod 600"):
            cc.load_config(p)
        os.chmod(p, 0o600)
    with pytest.raises(cc.ConfigError, match="https"):
        cc.load_config(p)
    p.write_text("CONNECTOR_TRANSPORT=carrier-pigeon\n")
    with pytest.raises(cc.ConfigError, match="CONNECTOR_TRANSPORT"):
        cc.load_config(p)
