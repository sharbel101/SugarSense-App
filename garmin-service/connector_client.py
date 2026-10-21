#!/usr/bin/env python3
"""Read-only client for the Garmin MCP gateway (https://missingmcp.com/garmin/mcp, the one behind your claude.ai "garmin" connector), for use OUTSIDE Claude.

  python connector_client.py check              offline: show the configuration (nothing is sent)
  python connector_client.py login              MANUAL one-time OAuth sign-in with the gateway (guarded, needs a terminal)
  python connector_client.py tools              connect once and list which tools the server offers and which of them this client may use
  python connector_client.py poll [--date D]    fetch today's (or day D's) compact metrics and save them under ./data/<day>/

Safety rules, all enforced in code and tested:
  * READ-ONLY: only the tools in ALLOWED_TOOLS can ever be called. Everything else (logging food, editing or deleting activities,
    uploading or scheduling workouts, weight entries ...) is refused locally before any request is made.
  * No key or password exists here. Sign-in is OAuth, done once by hand with `login`; the saved tokens live in ./oauth (folder 700, files 600)
    and `tools` / `poll` can only refresh them, never start a sign-in (they stop with NEEDS LOGIN instead).
  * Gentle on the service: >= 2 s between requests, at most one poll per 5 minutes, longer and longer waits after rate-limit answers,
    and a circuit breaker after 3 failures in a row (rate_gate.py; state survives restarts).
  * Nothing here logs in to Garmin. The connector service does that on its side with the accounts you connected there.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import stat
import sys
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from oauth_support import FileStorage, NeedsLogin, make_provider
from rate_gate import CallBlocked, Gate

HERE = Path(__file__).resolve().parent
ENV_FILE = HERE / "connector.env"
DATA_DIR = HERE / "data"
DEFAULT_URL = "https://missingmcp.com/garmin/mcp"  # the gateway behind your claude.ai "garmin" connector (free, OAuth sign-in, no API key)

# Tool name -> arguments for one calendar day. Compact "summary" variants are preferred over the 25-50 KB time series.
ALLOWED_TOOLS: dict[str, "callable"] = {
    "get_sleep_summary": lambda d: {"date": d},
    "get_stress_summary": lambda d: {"date": d},
    "get_heart_rates_summary": lambda d: {"date": d},
    "get_respiration_summary": lambda d: {"date": d},
    "get_hrv_data": lambda d: {"date": d, "return_timeseries": False},
    "get_rhr_day": lambda d: {"date": d},
    "get_body_battery": lambda d: {"start_date": d, "end_date": d},
    "get_spo2_data": lambda d: {"date": d},
    "get_stats": lambda d: {"date": d},
    "get_training_readiness": lambda d: {"date": d},
}
# Defence in depth: even if someone adds a name to ALLOWED_TOOLS, a name that looks like a write is refused.
WRITE_WORDS = ("add_", "set_", "delete", "remove", "create", "upload", "log_", "update", "schedule", "unschedule", "download", "import", "edit", "reload", "request_")


class ToolNotAllowed(Exception):
    pass


class ConfigError(Exception):
    pass


def ensure_allowed(name: str) -> None:
    if name not in ALLOWED_TOOLS or not name.startswith("get_") or any(w in name for w in WRITE_WORDS):
        raise ToolNotAllowed(f"'{name}' is not on the read-only allow-list; refused locally, nothing was sent")


@dataclass
class Config:
    url: str
    transport: str  # auto (streamable HTTP, then SSE once) | streamable | sse


def load_config(path: Path = ENV_FILE) -> Config:
    """Optional ./connector.env may set CONNECTOR_URL and CONNECTOR_TRANSPORT. There is no key or password anywhere: sign-in is OAuth (see oauth_support.py)."""
    vals: dict[str, str] = {}
    if path.exists():
        if os.name != "nt" and stat.S_IMODE(path.stat().st_mode) & 0o077:
            raise ConfigError(f"{path} is readable by others. Run: chmod 600 {path}")
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                vals[k.strip()] = v.strip().strip('"').strip("'")
    url = vals.get("CONNECTOR_URL") or DEFAULT_URL
    transport = (vals.get("CONNECTOR_TRANSPORT") or "auto").lower()
    if transport not in {"auto", "streamable", "sse"}:
        raise ConfigError("CONNECTOR_TRANSPORT must be auto, streamable or sse")
    if not url.startswith("https://") and not url.startswith("http://127.0.0.1") and not url.startswith("http://localhost"):
        raise ConfigError("CONNECTOR_URL must be https:// (plain http is only accepted for localhost tests)")
    return Config(url=url, transport=transport)


def describe(cfg: Config) -> str:
    p = urlsplit(cfg.url)
    have = FileStorage().has_tokens()
    return f"server: {p.scheme}://{p.netloc}{p.path} | auth: OAuth sign-in | saved tokens: {'yes' if have else 'NO - run `python connector_client.py login` by hand'} | transport: {cfg.transport}"


# ------------------------------------------------------------------------------------------------- connection
def _leaf(e: BaseException) -> BaseException:
    while isinstance(e, BaseExceptionGroup) and e.exceptions:
        e = e.exceptions[0]
    return e


@asynccontextmanager
async def open_session(cfg: Config, transport: str):
    """Yield an initialized MCP ClientSession over the chosen transport."""
    from mcp import ClientSession

    url = cfg.url
    auth = make_provider(url, interactive=False)  # unattended: can refresh tokens, can never start a sign-in
    if transport == "sse":
        from mcp.client.sse import sse_client

        async with sse_client(url, auth=auth) as streams:
            async with ClientSession(streams[0], streams[1]) as session:
                await session.initialize()
                yield session
    else:
        import httpx2
        from mcp.client.streamable_http import streamable_http_client

        async with httpx2.AsyncClient(timeout=httpx2.Timeout(30.0, read=300.0), auth=auth) as client:
            async with streamable_http_client(url, http_client=client) as streams:
                async with ClientSession(streams[0], streams[1]) as session:
                    await session.initialize()
                    yield session


def is_rate_limited(e: BaseException) -> bool:
    t = (str(e) + type(e).__name__).lower()
    return "429" in t or "too many" in t or "rate limit" in t or "ratelimit" in t


def parse_result(res) -> object:
    """Tool result -> JSON value (or the raw text). Raises RuntimeError when the server flagged an error."""
    texts = [getattr(c, "text", "") for c in (res.content or []) if getattr(c, "type", "text") == "text"]
    body = "\n".join(t for t in texts if t)
    if getattr(res, "isError", False):
        raise RuntimeError(body[:200] or "tool error")
    try:
        return json.loads(body)
    except ValueError:
        return body


async def run_with_session(cfg: Config, gate: Gate, work, open_fn=open_session):
    """Connect (auto: streamable HTTP first, then SSE once) and run `work(session)`. Each connection attempt goes through the gate."""
    order = ["streamable", "sse"] if cfg.transport == "auto" else [cfg.transport]
    last: BaseException | None = None
    for t in order:
        gate.before_request()
        try:
            async with open_fn(cfg, t) as session:
                return await work(session)
        except CallBlocked:
            raise
        except BaseException as e:  # noqa: BLE001
            if isinstance(e, (KeyboardInterrupt, SystemExit)):
                raise
            last = _leaf(e)
            if isinstance(last, NeedsLogin):
                raise last  # not a service failure: nothing to count, nothing to retry
            if is_rate_limited(last):
                gate.record_failure(rate_limited=True)
                raise last
            gate.record_failure(rate_limited=False)
            continue
    raise RuntimeError("could not connect: " + type(last).__name__ + ": " + str(last)[:150]) from last


async def list_tool_names(session) -> set[str]:
    res = await session.list_tools()
    return {t.name for t in res.tools}


async def cmd_tools(cfg: Config, gate: Gate, open_fn=open_session) -> dict:
    async def work(session):
        names = await list_tool_names(session)
        gate.record_success()
        return names

    names = await run_with_session(cfg, gate, work, open_fn)
    usable = sorted(n for n in ALLOWED_TOOLS if n in names)
    return {"offered": len(names), "usable_by_this_client": usable, "allowed_but_not_offered": sorted(n for n in ALLOWED_TOOLS if n not in names), "refused_by_policy": len(names) - len(usable)}


def _write_private(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(path.parent, 0o700)
    except OSError:
        pass
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(text)


async def cmd_poll(cfg: Config, gate: Gate, day: str, data_dir: Path = DATA_DIR, open_fn=open_session) -> dict:
    ok, wait = gate.may_poll()
    if not ok:
        return {"status": "skipped", "note": f"polled less than 5 minutes ago; next poll in {int(wait)} s"}
    gate.mark_polled()  # recorded first so a crash cannot become a hot loop
    manifest: dict[str, object] = {"day": day, "started": datetime.now(timezone.utc).isoformat(timespec="seconds"), "tools": {}}

    async def work(session):
        offered = await list_tool_names(session)
        gate.record_success()
        for name, build_args in ALLOWED_TOOLS.items():
            ensure_allowed(name)
            if name not in offered:
                manifest["tools"][name] = "not offered by the server"
                continue
            try:
                gate.before_request()
            except CallBlocked as b:
                manifest["tools"][name] = f"skipped: {b.reason}"
                manifest["stopped_early"] = b.reason
                break
            try:
                value = parse_result(await session.call_tool(name, build_args(day)))
            except BaseException as e:  # noqa: BLE001
                if isinstance(e, (KeyboardInterrupt, SystemExit)):
                    raise
                leaf = _leaf(e)
                manifest["tools"][name] = f"error: {type(leaf).__name__}: {str(leaf)[:120]}"
                rl = is_rate_limited(leaf)
                gate.record_failure(rate_limited=rl)
                if rl:
                    manifest["stopped_early"] = "rate limited"
                    break
                continue
            gate.record_success()
            _write_private(data_dir / day / f"{name}.json", json.dumps(value, indent=1, ensure_ascii=False))
            manifest["tools"][name] = f"ok ({len(json.dumps(value))} bytes)"

    await run_with_session(cfg, gate, work, open_fn)
    _write_private(data_dir / day / "_manifest.json", json.dumps(manifest, indent=1))
    ok_n = sum(1 for v in manifest["tools"].values() if str(v).startswith("ok"))
    return {"status": "ok" if ok_n == len(ALLOWED_TOOLS) else "partial", "saved": ok_n, "tools": manifest["tools"], "folder": str(data_dir / day)}


async def cmd_login(cfg: Config) -> dict:
    """MANUAL sign-in. Guarded (login_guard.py), needs a terminal, one attempt. The Garmin password is typed on the gateway page, never here."""
    from login_guard import LoginGuard, LoginRefused

    if not (sys.stdin.isatty() and sys.stdout.isatty()) or os.environ.get("INVOCATION_ID"):
        raise SystemExit("login is manual only: it needs an interactive terminal (not cron, systemd, a pipe or a redirect).")
    guard = LoginGuard()
    try:
        guard.check_or_raise()
    except LoginRefused as e:
        raise SystemExit(str(e))
    print("This starts ONE sign-in. The gateway will check your Garmin password with Garmin, so do it only when connect.garmin.com works in your browser")
    print("and at least 24-48 hours have passed since your last failed Garmin attempt (a block can be extended by trying during it).")
    if input("Type YES to continue: ").strip() != "YES":
        return {"status": "cancelled", "note": "nothing was sent"}
    attempt = guard.begin()
    try:
        import httpx2
        from mcp import ClientSession
        from mcp.client.streamable_http import streamable_http_client

        provider = make_provider(cfg.url, interactive=True)
        async with httpx2.AsyncClient(timeout=httpx2.Timeout(30.0, read=300.0), auth=provider) as client:
            async with streamable_http_client(cfg.url, http_client=client) as streams:
                async with ClientSession(streams[0], streams[1]) as session:
                    await session.initialize()
                    names = await list_tool_names(session)
    except BaseException as e:  # noqa: BLE001
        guard.finish(attempt, ok=False, error=_leaf(e))
        raise
    guard.finish(attempt, ok=True)
    from oauth_support import NEEDS_LOGIN_FLAG

    NEEDS_LOGIN_FLAG.unlink(missing_ok=True)
    return {"status": "signed in", "tools_offered": len(names), "note": "Tokens saved in ./oauth (folder 700, files 600). Now run: tools"}


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("check")
    sub.add_parser("tools")
    sub.add_parser("login")
    p = sub.add_parser("poll")
    p.add_argument("--date", default=None, help="YYYY-MM-DD (default: today on this machine)")
    a = ap.parse_args(argv)
    try:
        cfg = load_config()
    except ConfigError as e:
        print(e)
        return 2
    try:
        if a.cmd == "check":
            print(describe(cfg))
            return 0
        if a.cmd == "login":
            print(json.dumps(asyncio.run(cmd_login(cfg)), indent=1))
            return 0
        gate = Gate()
        if a.cmd == "tools":
            print(json.dumps(asyncio.run(cmd_tools(cfg, gate)), indent=1))
        else:
            day = a.date or date.today().isoformat()
            date.fromisoformat(day)
            print(json.dumps(asyncio.run(cmd_poll(cfg, gate, day)), indent=1))
        return 0
    except NeedsLogin as n:
        print(f"NEEDS LOGIN (nothing was sent to the service): {n}")
        return 4
    except CallBlocked as b:
        until = datetime.fromtimestamp(b.until_epoch or 0, timezone.utc)
        print(f"Blocked locally (nothing was sent): {b.reason} until {until:%Y-%m-%d %H:%M:%S} UTC")
        return 3
    except Exception as e:  # noqa: BLE001
        print(f"FAILED: {type(e).__name__}: {str(e)[:300]}")
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
