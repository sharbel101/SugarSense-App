"""Read-only JSON API over the stored Garmin metrics. It NEVER calls Garmin or the gateway: every answer comes from the local database.

  GET /api/garmin/v1/health          liveness of this process (no auth, no database)
  GET /api/garmin/v1/metrics         catalogue of metrics, what is unsupported and why
  GET /api/garmin/v1/metrics/latest  newest observation per metric with freshness
  GET /api/garmin/v1/metrics/history bounded, chronological observations (cursor paging)
  GET /api/garmin/v1/status          polling / backoff / staleness / sanitised errors

Everything except /health needs the shared token in `x-app-token` (or `Authorization: Bearer`). With no token configured the data routes refuse (503): fail closed.
This token only keeps scanners out; like the other SugarSense routes it is NOT per-user authentication (a token inside a public web build is visible).
"""
from __future__ import annotations

import hmac
import json
import logging
import re
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone

from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from .config import Settings
from .metrics import GROUPS, METRICS, UNSUPPORTED, metrics_in_group
from .store import WORKER_ROW, StoredObs, scrub

PREFIX = "/api/garmin/v1"
log = logging.getLogger("garmin.api")
_CURSOR = re.compile(r"^\d{1,20}\.\d{1,18}$")
WORKER_ALIVE_S = 15 * 60


def iso(dt: datetime | None) -> str | None:
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z") if dt else None


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str):
        self.status, self.code, self.message = status, code, message


def error_response(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message}}, status_code=status, headers=_headers())


def _headers() -> dict:
    return {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}


def parse_dt(value: str, name: str) -> datetime:
    try:
        d = datetime.fromisoformat(value.strip().replace("Z", "+00:00").replace(" ", "+"))
    except ValueError:
        raise ApiError(400, "invalid_parameter", f"'{name}' must be an ISO 8601 timestamp with a time zone, for example 2026-10-21T08:00:00Z") from None
    if d.tzinfo is None:
        raise ApiError(400, "invalid_parameter", f"'{name}' needs a time zone (Z or +hh:mm)")
    return d.astimezone(timezone.utc)


def value_of(o: StoredObs):
    return o.value_json if (o.value_num is None) else o.value_num


def entry(o: StoredObs, now: datetime) -> dict:
    info = METRICS.get(o.metric)
    age = max(0, int((now - o.measured_at).total_seconds()))
    out = {
        "value": value_of(o),
        "unit": o.unit,
        "kind": o.kind,
        "origin": o.origin,
        "measured_at": iso(o.measured_at),
        "ts_semantics": o.ts_semantics,
        "fetched_at": iso(o.fetched_at),
        "age_seconds": age,
        "fetched_age_seconds": max(0, int((now - o.fetched_at).total_seconds())),
        "quality": "stale" if (info and age > info.stale_after_s) else "available",
    }
    if o.value_num is not None and o.value_json is not None:
        out["details"] = o.value_json
    if o.interval_s:
        out["interval_seconds"] = o.interval_s
    if o.period:
        out["period"] = o.period
    if o.period_date:
        out["period_date"] = o.period_date.isoformat()
    if o.meta:
        out["meta"] = o.meta
    return out


class RateLimiter:
    """Small in-process sliding window per client, so a runaway page loop cannot hammer the database."""

    def __init__(self, per_minute: int, clock=time.monotonic):
        self.per_minute, self.clock = per_minute, clock
        self.hits: dict[str, deque] = defaultdict(deque)

    def allow(self, who: str) -> bool:
        now = self.clock()
        q = self.hits[who]
        while q and now - q[0] > 60:
            q.popleft()
        if len(q) >= self.per_minute:
            return False
        q.append(now)
        if len(self.hits) > 5000:
            self.hits.clear()
        return True


THINNABLE_KINDS = ("instant", "interval")


def thin_rows(rows, max_points: int):
    """Keep at most `max_points` rows per metric by taking evenly spaced ones (always the first and the last), for sample-like metrics only.
    Events and daily summaries are never thinned. This only reduces what is sent to a phone; stored data is untouched and no value is changed or averaged."""
    by: dict = {}
    for r in rows:
        by.setdefault(r.metric, []).append(r)
    keep: set = set()
    thinned = False
    for name, rs in by.items():
        if len(rs) > max_points and rs[0].kind in THINNABLE_KINDS:
            thinned = True
            n = len(rs)
            keep.update(id(rs[round(i * (n - 1) / (max_points - 1))]) for i in range(max_points))
        else:
            keep.update(id(r) for r in rs)
    return [r for r in rows if id(r) in keep], thinned


def create_app(settings: Settings, store, now_fn=lambda: datetime.now(timezone.utc)) -> Starlette:
    limiter = RateLimiter(settings.rate_per_minute)

    def guard(request: Request) -> None:
        if not settings.api_token:
            raise ApiError(503, "auth_not_configured", "the server has no access token configured; data routes are closed")
        supplied = request.headers.get("x-app-token") or ""
        if not supplied:
            auth = request.headers.get("authorization") or ""
            if auth.lower().startswith("bearer "):
                supplied = auth[7:].strip()
        if not hmac.compare_digest(supplied.encode(), settings.api_token.encode()):
            raise ApiError(401, "unauthorized", "missing or invalid access token")
        who = request.headers.get("x-real-ip") if (request.client and request.client.host in {"127.0.0.1", "::1"}) else (request.client.host if request.client else "?")
        if not limiter.allow(who or "?"):
            raise ApiError(429, "rate_limited", "too many requests to this API; slow down (this does not call Garmin)")

    def wrap(fn):
        def handler(request: Request) -> Response:
            t0 = time.monotonic()
            status = 500
            try:
                guard(request)
                resp = fn(request)
            except ApiError as e:
                resp = error_response(e.status, e.code, e.message)
            except Exception as e:  # noqa: BLE001 - never leak internals or stack traces
                log.error("route failed", extra={"route": request.url.path, "error_class": type(e).__name__})
                code = "storage_unavailable" if type(e).__module__.startswith("psycopg") else "internal_error"
                resp = error_response(503 if code == "storage_unavailable" else 500, code, "the service could not answer this request")
            status = resp.status_code
            log.info(json.dumps({"event": "request", "method": request.method, "path": request.url.path, "status": status, "ms": int((time.monotonic() - t0) * 1000)}))
            return resp

        return handler

    def health(request: Request) -> Response:
        return JSONResponse({"status": "ok", "service": "garmin-metrics-api", "time": iso(now_fn())}, headers=_headers())

    def catalogue(request: Request) -> Response:
        return JSONResponse(
            {
                "source": "garmin",
                "metrics": {n: {"unit": m.unit, "kind": m.kind, "origin": m.origin, "group": m.group, "stale_after_seconds": m.stale_after_s, "description": m.description} for n, m in METRICS.items()},
                "unsupported": UNSUPPORTED,
                "notes": ["origin=garmin_derived values are scores or summaries Garmin calculated; raw_sensor values are samples or counts the watch measured.", "A rising heart rate or high activity is not evidence of low glucose."],
            },
            headers=_headers(),
        )

    def parse_metric_list(raw: str | None) -> list[str] | None:
        if raw is None or raw.strip() == "":
            return None
        names = [m.strip() for m in raw.split(",") if m.strip()]
        if len(names) > len(METRICS):
            raise ApiError(400, "invalid_parameter", "too many metrics requested")
        unknown = [n for n in names if n not in METRICS]
        if unknown:
            raise ApiError(400, "unknown_metric", "unknown metric(s): " + ", ".join(sorted(set(u[:40] for u in unknown))[:10]))
        return list(dict.fromkeys(names))

    def worker_info(states: dict) -> dict:
        w = states.get(WORKER_ROW) or {}
        extra = w.get("extra") or {}
        seen = w.get("last_attempt_at")
        return {"seen": seen, "extra": extra}

    def latest(request: Request) -> Response:
        names = parse_metric_list(request.query_params.get("metrics"))
        now = now_fn()
        rows = store.latest_per_metric(names)
        states = store.all_states()
        by = {r.metric: r for r in rows}
        wanted = names or list(METRICS)
        metrics = {n: entry(by[n], now) for n in wanted if n in by}
        missing = [n for n in wanted if n not in by]
        qualities = {m["quality"] for m in metrics.values()}
        freshness = "no_data" if not metrics else ("fresh" if qualities == {"available"} else ("stale" if qualities == {"stale"} else "mixed"))
        warnings = []
        stale = sorted(n for n, m in metrics.items() if m["quality"] == "stale")
        if stale:
            warnings.append("stale: " + ", ".join(stale) + ". The watch syncs to the phone in batches, so the newest samples can lag; check /status to tell a stalled poll from an unsynced watch.")
        wi = worker_info(states)
        reason = (wi["extra"] or {}).get("paused_reason")
        if reason:
            warnings.append("polling is not running: " + str(reason))
        successes = [s["last_success_at"] for k, s in states.items() if k != WORKER_ROW and s.get("last_success_at")]
        return JSONResponse(
            {"source": "garmin", "generated_at": iso(now), "last_successful_fetch_at": iso(max(successes)) if successes else None, "metrics": metrics, "data_freshness": freshness, "missing_metrics": missing, "warnings": warnings},
            headers=_headers(),
        )

    def history(request: Request) -> Response:
        q = request.query_params
        names = parse_metric_list(q.get("metrics"))
        if not names:
            raise ApiError(400, "missing_parameter", "'metrics' is required (comma-separated metric names, see /metrics)")
        now = now_fn()
        end = parse_dt(q["to"], "to") if q.get("to") else now
        start = parse_dt(q["from"], "from") if q.get("from") else end - timedelta(hours=24)
        if start >= end:
            raise ApiError(400, "invalid_parameter", "'from' must be earlier than 'to'")
        if end - start > timedelta(days=settings.history_max_span_days):
            raise ApiError(400, "range_too_large", f"the range may not exceed {settings.history_max_span_days} days")
        limit = settings.history_default_limit
        if q.get("limit") is not None:
            try:
                limit = int(q["limit"])
            except ValueError:
                raise ApiError(400, "invalid_parameter", "'limit' must be an integer") from None
            if not 1 <= limit <= settings.history_max_limit:
                raise ApiError(400, "invalid_parameter", f"'limit' must be between 1 and {settings.history_max_limit}")
        max_points = None
        if q.get("max_points") is not None:
            try:
                max_points = int(q["max_points"])
            except ValueError:
                raise ApiError(400, "invalid_parameter", "'max_points' must be an integer") from None
            if not 10 <= max_points <= 2000:
                raise ApiError(400, "invalid_parameter", "'max_points' must be between 10 and 2000")
        after = None
        if q.get("cursor"):
            if not _CURSOR.match(q["cursor"]):
                raise ApiError(400, "invalid_parameter", "'cursor' is not valid")
            us, rid = q["cursor"].split(".")
            after = (datetime.fromtimestamp(int(us) / 1_000_000, tz=timezone.utc), int(rid))
        rows = store.history(names, start, end, limit + 1, after)
        more = len(rows) > limit
        rows = rows[:limit]
        thinned = False
        if max_points is not None:
            rows, thinned = thin_rows(rows, max_points)
        obs = []
        for o in rows:
            e = entry(o, now)
            e.pop("age_seconds", None)
            e.pop("fetched_age_seconds", None)
            e.pop("quality", None)
            obs.append({"metric": o.metric, **e})
        cursor = None
        if more and rows:
            last = rows[-1]
            cursor = f"{int(last.measured_at.timestamp() * 1_000_000)}.{last.id}"
        return JSONResponse(
            {"source": "garmin", "generated_at": iso(now), "from": iso(start), "to": iso(end), "metrics_requested": names, "count": len(obs), "limit": limit, "thinned": thinned, "has_more": more, "next_cursor": cursor, "order": "measured_at ascending", "observations": obs},
            headers=_headers(),
        )

    def status(request: Request) -> Response:
        now = now_fn()
        states = store.all_states()
        runs = store.recent_runs(now - timedelta(hours=24), 500)
        wi = worker_info(states)
        extra = wi["extra"] or {}
        seen = wi["seen"]
        alive = bool(seen and (now - seen).total_seconds() < WORKER_ALIVE_S)
        reason = extra.get("paused_reason")
        gate = extra.get("gate") or {}
        if reason:
            state = "paused"
        elif gate.get("breaker_open_until"):
            state = "circuit_breaker_open"
        elif gate.get("backoff_until"):
            state = "backing_off"
        elif not alive:
            state = "worker_not_running"
        else:
            state = "normal"
        latest_rows = {r.metric: r for r in store.latest_per_metric(None)}
        groups = {}
        any_stale = False
        for g in GROUPS:
            js = states.get(g) or {}
            ms = [latest_rows[m] for m in metrics_in_group(g) if m in latest_rows]
            newest = max((m.measured_at for m in ms), default=None)
            stale_metrics = sorted(m.metric for m in ms if (now - m.measured_at).total_seconds() > METRICS[m.metric].stale_after_s)
            stale = (not ms) or bool(stale_metrics)
            any_stale = any_stale or stale
            groups[g] = {
                "last_attempt_at": iso(js.get("last_attempt_at")),
                "last_successful_fetch_at": iso(js.get("last_success_at")),
                "last_new_data_at": iso(js.get("last_new_data_at")),
                "last_measurement_at": iso(newest),
                "last_outcome": js.get("last_outcome"),
                "consecutive_failures": js.get("consecutive_failures", 0),
                "stale": stale,
                "stale_metrics": stale_metrics,
            }
        counters = {"requests": 0, "errors": 0, "rate_limited": 0, "cache_hits": 0, "new_rows": 0, "runs": len(runs)}
        for r in runs:
            counters["requests"] += r.requests
            counters["cache_hits"] += r.cache_hits
            counters["new_rows"] += r.rows_new
            if r.outcome in {"error", "schema_drift", "auth_failed", "needs_login"}:
                counters["errors"] += 1
            if r.outcome == "rate_limited":
                counters["rate_limited"] += 1
        recent_errors = [
            {"at": iso(r.started_at), "job": r.job, "outcome": r.outcome, "error_class": r.error_class, "message": scrub(r.error_text)}
            for r in runs
            if r.outcome in {"error", "schema_drift", "auth_failed", "needs_login", "rate_limited", "partial"} and (r.error_class or r.error_text)
        ][:5]
        successes = [s["last_success_at"] for k, s in states.items() if k != WORKER_ROW and s.get("last_success_at")]
        return JSONResponse(
            {
                "source": "garmin",
                "generated_at": iso(now),
                "polling": {
                    "enabled": settings.polling_enabled,
                    "state": state,
                    "paused_reason": reason,
                    "worker_alive": alive,
                    "worker_last_seen_at": iso(seen),
                    "backoff_until": gate.get("backoff_until"),
                    "breaker_open_until": gate.get("breaker_open_until"),
                    "consecutive_gateway_failures": gate.get("consecutive_failures", 0),
                    "intervals_minutes": extra.get("intervals"),
                },
                "last_successful_poll_at": iso(max(successes)) if successes else None,
                "groups": groups,
                "data_stale": any_stale,
                "counters_24h": counters,
                "counters_since_worker_start": extra.get("counters"),
                "recent_errors": recent_errors,
                "unsupported": UNSUPPORTED,
            },
            headers=_headers(),
        )

    routes = [
        Route(f"{PREFIX}/health", health, methods=["GET"]),
        Route(f"{PREFIX}/metrics", wrap(catalogue), methods=["GET"]),
        Route(f"{PREFIX}/metrics/latest", wrap(latest), methods=["GET"]),
        Route(f"{PREFIX}/metrics/history", wrap(history), methods=["GET"]),
        Route(f"{PREFIX}/status", wrap(status), methods=["GET"]),
    ]
    middleware = []
    if settings.cors_origins:
        middleware.append(Middleware(CORSMiddleware, allow_origins=list(settings.cors_origins), allow_methods=["GET", "OPTIONS"], allow_headers=["x-app-token", "authorization", "content-type"], max_age=600))
    app = Starlette(routes=routes, middleware=middleware)

    async def not_found(request, exc):
        return error_response(404, "not_found", "no such route")

    async def method_not_allowed(request, exc):
        return error_response(405, "method_not_allowed", "this API is read-only (GET)")

    app.add_exception_handler(404, not_found)
    app.add_exception_handler(405, method_not_allowed)
    return app


def main() -> None:  # pragma: no cover - process entry point
    import uvicorn

    from .config import load_settings
    from .store import PgStore

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    s = load_settings()
    if not s.api_db_url:
        raise SystemExit("GARMIN_API_DATABASE_URL is not set")
    if s.host not in {"127.0.0.1", "::1", "localhost"}:
        raise SystemExit("GARMIN_API_HOST must be a loopback address; nginx is the only public entry point")
    uvicorn.run(create_app(s, PgStore(s.api_db_url)), host=s.host, port=s.port, log_level="warning", proxy_headers=False, server_header=False)


if __name__ == "__main__":  # pragma: no cover
    main()
