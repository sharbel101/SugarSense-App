"""Garmin's official Personal API: read-only.

The owner creates a Personal API key in Garmin Connect (Settings > Personal API token). The key is exchanged for a 24 h bearer token (a JWT);
every data call is a plain GET with that token. There is no sign-in, no password, no MFA and no third party. The token is cached in memory and
renewed when less than an hour is left, or once after a 401.
"""
from __future__ import annotations

import base64
import json
import time
import urllib.error
import urllib.request

BASE = "https://personal.connectapi.garmin.com"
TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token"
RENEW_BEFORE_S = 3600


class ApiError(Exception):
    """kind: auth (key rejected or still 401 after a renewal) | rate_limited | transient (network, 5xx) | client (another 4xx)."""

    def __init__(self, kind: str, status: int = 0, retry_after: float | None = None, message: str = ""):
        super().__init__(f"{kind} ({status}) {message}".strip())
        self.kind, self.status, self.retry_after = kind, status, retry_after


def jwt_exp(token: str) -> float | None:
    """The `exp` claim of a JWT, read WITHOUT verifying it (only used to decide when to renew)."""
    try:
        p = token.split(".")[1]
        return float(json.loads(base64.urlsafe_b64decode(p + "=" * (-len(p) % 4)))["exp"])
    except Exception:  # noqa: BLE001
        return None


def _urllib_transport(method: str, url: str, headers: dict, timeout: float):
    req = urllib.request.Request(url, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise ApiError("transient", 0, message=type(e).__name__) from None


class PersonalClient:
    def __init__(self, key: str, base: str = BASE, transport=_urllib_transport, now=time.time, timeout: float = 30.0):
        if not key or not key.strip():
            raise ValueError("a Personal API key is required")
        self._key, self._base, self._tx, self._now, self._timeout = key.strip(), base, transport, now, timeout
        self._token: str | None = None
        self._exp: float = 0.0
        self.requests = 0

    # ------------------------------------------------------------------ token
    def _renew(self) -> None:
        self.requests += 1
        status, headers, body = self._tx("POST", self._base + TOKEN_PATH, {"Authorization": "ApiKey " + self._key}, self._timeout)
        if status in (401, 403):
            raise ApiError("auth", status, message="the Personal API key was rejected")
        if status == 429:
            raise ApiError("rate_limited", status, _retry_after(headers))
        if status != 200 or not body.strip():
            raise ApiError("transient" if status >= 500 or status == 0 else "client", status)
        token = body.decode("utf-8", "replace").strip()
        self._token, self._exp = token, jwt_exp(token) or (self._now() + 12 * 3600)

    def token(self, force: bool = False) -> str:
        if force or self._token is None or self._exp - self._now() < RENEW_BEFORE_S:
            self._renew()
        assert self._token is not None
        return self._token

    # ------------------------------------------------------------------ data
    def get(self, path: str):
        """GET a data path. Returns the decoded JSON, or None for an empty answer (204: nothing recorded for that day)."""
        for attempt in (0, 1):
            tok = self.token(force=attempt == 1)
            self.requests += 1
            status, headers, body = self._tx("GET", self._base + path, {"Authorization": "Bearer " + tok, "Accept": "application/json"}, self._timeout)
            if status == 401 and attempt == 0:
                continue  # the token may have been revoked or expired: renew once and retry
            if status == 401:
                raise ApiError("auth", status, message="still unauthorised after a token renewal")
            if status == 204 or (status == 200 and not body.strip()):
                return None
            if status == 200:
                try:
                    return json.loads(body)
                except ValueError:
                    raise ApiError("transient", status, message="the answer was not JSON") from None
            if status == 429:
                raise ApiError("rate_limited", status, _retry_after(headers))
            if status >= 500:
                raise ApiError("transient", status)
            raise ApiError("client", status, message=path.split("?")[0])
        raise ApiError("auth", 401)


def _retry_after(headers: dict) -> float | None:
    for k, v in headers.items():
        if k.lower() == "retry-after":
            try:
                return float(v)
            except ValueError:
                return None
    return None
