"""The only code that talks to the Garmin MCP gateway: read-only tools, one session per cycle, every request through the shared Gate.

It reuses connector_client's OAuth session opener, which can refresh tokens but can NEVER start a sign-in. There is no retry-by-logging-in path here:
the transport is streamable HTTP only (the earlier SSE fallback just produced a misleading 405).
"""
from __future__ import annotations

import asyncio
import re
from contextlib import asynccontextmanager

import connector_client as cc
from oauth_support import NeedsLogin
from rate_gate import CallBlocked, Gate

from .catalog import ALL_TOOLS

CALL_TIMEOUT_S = 90
_AUTH_WORDS = re.compile(r"\b(401|403)\b|unauthori[sz]ed|forbidden|not connected|session (has )?expired|token (has )?expired|re-?auth|sign[ -]?in required|login required", re.I)


class ToolNotAllowed(Exception):
    pass


class ToolError(Exception):
    """The gateway answered, but flagged the tool call as an error (bad arguments, no data source ...). The service itself is fine."""


class AuthFailed(Exception):
    """The gateway says the account/session is not authorised. Never retried automatically."""


def ensure_read_only(name: str) -> None:
    if name not in ALL_TOOLS or not name.startswith("get_") or any(w in name for w in cc.WRITE_WORDS):
        raise ToolNotAllowed(f"'{name}' is not an allowed read-only tool; refused locally, nothing was sent")


def classify(e: BaseException) -> str:
    """-> needs_login | auth_failed | rate_limited | tool_error | transient"""
    e = cc._leaf(e)
    if isinstance(e, NeedsLogin):
        return "needs_login"
    if isinstance(e, AuthFailed):
        return "auth_failed"
    if cc.is_rate_limited(e):
        return "rate_limited"
    if isinstance(e, ToolError):
        return "auth_failed" if _AUTH_WORDS.search(str(e)) else "tool_error"
    if _AUTH_WORDS.search(str(e) + type(e).__name__):
        return "auth_failed"
    return "transient"


def retry_after_seconds(e: BaseException) -> float | None:
    """Retry-After from the response headers (seconds form) or, failing that, from the error text. None when absent or unparseable."""
    e = cc._leaf(e)
    headers = getattr(getattr(e, "response", None), "headers", None)
    raw = headers.get("retry-after") if headers is not None else None
    if raw is None:
        m = re.search(r"retry[- ]after\D{0,3}(\d{1,6})", str(e), re.I)
        raw = m.group(1) if m else None
    try:
        v = float(raw)
    except (TypeError, ValueError):
        return None
    return v if v > 0 else None


class Gateway:
    def __init__(self, cfg: cc.Config, gate: Gate, open_fn=cc.open_session, timeout_s: float = CALL_TIMEOUT_S):
        self.cfg, self.gate, self.open_fn, self.timeout_s = cfg, gate, open_fn, timeout_s

    @asynccontextmanager
    async def session(self):
        self.gate.before_request()  # may raise CallBlocked: backoff / breaker / min gap
        async with self.open_fn(self.cfg, "streamable") as s:
            yield _Session(s, self.gate, self.timeout_s)


class _Session:
    def __init__(self, s, gate: Gate, timeout_s: float):
        self.s, self.gate, self.timeout_s = s, gate, timeout_s
        self.requests = 0

    async def call(self, name: str, args: dict):
        ensure_read_only(name)
        self.gate.before_request()
        self.requests += 1
        res = await asyncio.wait_for(self.s.call_tool(name, args), self.timeout_s)
        try:
            return cc.parse_result(res)
        except RuntimeError as e:
            raise ToolError(str(e)[:200]) from None


__all__ = ["Gateway", "ToolNotAllowed", "ToolError", "AuthFailed", "classify", "retry_after_seconds", "ensure_read_only", "CallBlocked", "NeedsLogin"]
