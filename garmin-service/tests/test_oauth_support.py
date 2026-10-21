import asyncio
import json
import os

import pytest

import connector_client as cc
import oauth_support as o
from mcp.shared.auth import OAuthToken


def test_parse_redirect_extracts_code_and_state_and_rejects_everything_else():
    r = o.parse_redirect("http://127.0.0.1:8976/callback?code=abc123&state=xyz&iss=https%3A%2F%2Fmissingmcp.com")
    assert (r.code, r.state) == ("abc123", "xyz")
    for bad in ["http://127.0.0.1:8976/callback?state=only", "http://127.0.0.1:8976/callback", "not a url", "http://127.0.0.1:8976/callback?error=access_denied&state=s"]:
        with pytest.raises(o.NeedsLogin):
            o.parse_redirect(bad)


def test_token_storage_roundtrip_is_private(tmp_path):
    st = o.FileStorage(tmp_path / "oauth")
    assert asyncio.run(st.get_tokens()) is None and not st.has_tokens()
    asyncio.run(st.set_tokens(OAuthToken(access_token="A" * 20, token_type="Bearer", refresh_token="R" * 20, expires_in=3600)))
    assert st.has_tokens() and asyncio.run(st.get_tokens()).refresh_token == "R" * 20
    if os.name != "nt":
        assert oct(st.tokens_path.stat().st_mode & 0o777) == "0o600" and oct(st.dir.stat().st_mode & 0o777) == "0o700"


def test_unattended_provider_can_never_start_a_sign_in(tmp_path):
    flag = tmp_path / "NEEDS_LOGIN"
    p = o.make_provider("https://missingmcp.com/garmin/mcp", interactive=False, storage=o.FileStorage(tmp_path / "oauth"), flag=flag)
    with pytest.raises(o.NeedsLogin, match="login"):
        asyncio.run(p.context.redirect_handler("https://example.com/authorize?x=1"))
    assert flag.exists() and "login manually" in flag.read_text()


def test_interactive_provider_prints_the_link_and_reads_the_pasted_address(tmp_path):
    out = []
    p = o.make_provider("https://missingmcp.com/garmin/mcp", interactive=True, storage=o.FileStorage(tmp_path / "oauth"),
                        input_fn=lambda _: "http://127.0.0.1:8976/callback?code=C&state=S", print_fn=out.append)
    asyncio.run(p.context.redirect_handler("https://missingmcp.com/authorize?client_id=1"))
    got = asyncio.run(p.context.callback_handler())
    assert "https://missingmcp.com/authorize" in "".join(out) and (got.code, got.state) == ("C", "S")
    assert str(p.context.client_metadata.redirect_uris[0]) == o.REDIRECT_URI


def test_login_command_refuses_without_a_terminal_and_never_runs_unattended(monkeypatch):
    monkeypatch.setattr(cc.sys.stdin, "isatty", lambda: False, raising=False)
    with pytest.raises(SystemExit, match="manual only"):
        asyncio.run(cc.cmd_login(cc.Config(url=cc.DEFAULT_URL, transport="auto")))


def test_tools_and_poll_without_tokens_stop_with_needs_login_and_send_nothing(tmp_path, monkeypatch):
    # the real open_session with the unattended provider and no saved tokens: no request may reach the network
    import socket

    sent = []

    def no_net(*a, **k):
        sent.append(1)
        raise ConnectionError("network blocked in test")

    monkeypatch.setattr(socket.socket, "connect", no_net)
    monkeypatch.setattr(socket, "getaddrinfo", no_net)
    monkeypatch.setattr(o, "OAUTH_DIR", tmp_path / "oauth")
    monkeypatch.setattr(o, "NEEDS_LOGIN_FLAG", tmp_path / "NEEDS_LOGIN")
    from rate_gate import Gate

    g = Gate(tmp_path / "g.json", jitter=lambda: 0.0)
    with pytest.raises(Exception) as e:
        asyncio.run(cc.cmd_tools(cc.Config(url=cc.DEFAULT_URL, transport="streamable"), g))
    assert not isinstance(e.value, SystemExit)
    # whatever the failure is, it must not be a request that carried credentials: there are none, and the sign-in was never started
    assert not (tmp_path / "oauth" / "tokens.json").exists()
