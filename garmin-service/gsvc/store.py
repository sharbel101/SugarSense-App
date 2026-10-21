"""Storage. PgStore talks to PostgreSQL (tables from backend/db/migrations/0011_garmin_metrics.sql); MemStore is a faithful in-memory twin for unit tests.

Idempotency: (metric, measured_at, source_tool) is unique. A repeated fetch of the same measurement inserts nothing. A changed value for the same key
(for example the newest 15-minute step interval that was still filling, or a daily summary that was revised) is updated only by a LATER fetch, so an
older answer can never overwrite a newer one. Cumulative day totals are stored as returned, one row per source timestamp, never summed.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Iterable

from .parsers import Obs
from .scheduler import JobState

WORKER_ROW = "_worker"
_SECRET_LIKE = re.compile(r"(eyJ[A-Za-z0-9_\-\.]{10,}|[A-Fa-f0-9]{32,}|[A-Za-z0-9_\-]{40,}|Bearer\s+\S+|https?://\S+|[\w.+-]+@[\w-]+\.[\w.]+)")


def scrub(text: str | None, limit: int = 160) -> str | None:
    """Error text that is safe to store and show: tokens, long hex/base64 strings, e-mail addresses and URLs removed, length capped."""
    if text is None:
        return None
    return _SECRET_LIKE.sub("[redacted]", str(text)).replace("\n", " ")[:limit]


@dataclass
class RunRecord:
    job: str
    started_at: datetime
    outcome: str
    finished_at: datetime | None = None
    requests: int = 0
    cache_hits: int = 0
    rows_seen: int = 0
    rows_new: int = 0
    latest_measured_at: datetime | None = None
    error_class: str | None = None
    error_text: str | None = None
    duration_ms: int | None = None


@dataclass
class StoredObs:
    id: int
    metric: str
    kind: str
    measured_at: datetime
    ts_semantics: str
    interval_s: int | None
    value_num: float | None
    value_json: dict | None
    unit: str | None
    period: str | None
    period_date: object
    source_tool: str
    origin: str
    fetched_at: datetime
    first_fetched_at: datetime
    revisions: int
    meta: dict


# ------------------------------------------------------------------ in-memory twin
class MemStore:
    def __init__(self):
        self.obs: dict[tuple, StoredObs] = {}
        self.runs: list[RunRecord] = []
        self.states: dict[str, dict] = {}
        self._id = 0

    def upsert_observations(self, rows: Iterable[Obs], fetched_at: datetime) -> tuple[int, int]:
        new = changed = 0
        for o in rows:
            key = (o.metric, o.measured_at, o.source_tool)
            cur = self.obs.get(key)
            if cur is None:
                self._id += 1
                self.obs[key] = StoredObs(self._id, o.metric, o.kind, o.measured_at, o.ts_semantics, o.interval_s, o.value_num, o.value_json, o.unit, o.period, o.period_date, o.source_tool, o.origin, fetched_at, fetched_at, 0, dict(o.meta))
                new += 1
            elif cur.fetched_at <= fetched_at and (cur.value_num != o.value_num or cur.value_json != o.value_json):
                cur.value_num, cur.value_json, cur.interval_s, cur.meta = o.value_num, o.value_json, o.interval_s, dict(o.meta)
                cur.fetched_at, cur.revisions = fetched_at, cur.revisions + 1
                changed += 1
        return new, changed

    def latest_per_metric(self, metrics: list[str] | None = None) -> list[StoredObs]:
        best: dict[str, StoredObs] = {}
        for o in self.obs.values():
            if metrics and o.metric not in metrics:
                continue
            b = best.get(o.metric)
            if b is None or (o.measured_at, o.id) > (b.measured_at, b.id):
                best[o.metric] = o
        return sorted(best.values(), key=lambda o: o.metric)

    def history(self, metrics: list[str], start: datetime, end: datetime, limit: int, after: tuple[datetime, int] | None = None) -> list[StoredObs]:
        rows = [o for o in self.obs.values() if o.metric in metrics and start <= o.measured_at <= end and (after is None or (o.measured_at, o.id) > after)]
        rows.sort(key=lambda o: (o.measured_at, o.id))
        return rows[:limit]

    def record_run(self, r: RunRecord) -> None:
        self.runs.append(r)

    def recent_runs(self, since: datetime, limit: int = 200) -> list[RunRecord]:
        return sorted([r for r in self.runs if r.started_at >= since], key=lambda r: r.started_at, reverse=True)[:limit]

    def get_state(self, job: str) -> JobState:
        s = self.states.get(job, {})
        return JobState(s.get("last_attempt_at"), s.get("last_success_at"), s.get("last_outcome"), s.get("consecutive_failures", 0), s.get("slot_key"), s.get("slot_attempts", 0))

    def put_state(self, job: str, **fields) -> None:
        self.states.setdefault(job, {}).update(fields)

    def all_states(self) -> dict[str, dict]:
        return {k: dict(v) for k, v in self.states.items()}

    def acquire_singleton(self) -> bool:
        return True

    def prune_runs(self, older_than: datetime) -> int:
        n = len(self.runs)
        self.runs = [r for r in self.runs if r.started_at >= older_than]
        return n - len(self.runs)

    def close(self) -> None:
        pass


# ------------------------------------------------------------------ PostgreSQL
_COLS = "id, metric, kind, measured_at, ts_semantics, interval_s, value_num, value_json, unit, period, period_date, source_tool, origin, fetched_at, first_fetched_at, revisions, meta"


class PgStore:
    """One short-lived connection per call group; low volume, so no pool. `url` comes from the environment and is never logged."""

    def __init__(self, url: str, connect=None):
        import psycopg

        self._psycopg = psycopg
        self._url = url
        self._connect = connect or (lambda: psycopg.connect(self._url, autocommit=False, connect_timeout=10, application_name="garmin-service"))

    def _conn(self):
        return self._connect()

    def upsert_observations(self, rows: Iterable[Obs], fetched_at: datetime) -> tuple[int, int]:
        from psycopg.types.json import Jsonb

        sql = f"""INSERT INTO garmin_observations (metric, kind, measured_at, ts_semantics, interval_s, value_num, value_json, unit, period, period_date, source_tool, origin, fetched_at, first_fetched_at, meta)
VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
ON CONFLICT (metric, measured_at, source_tool) DO UPDATE SET
  value_num = EXCLUDED.value_num, value_json = EXCLUDED.value_json, interval_s = EXCLUDED.interval_s, meta = EXCLUDED.meta,
  fetched_at = EXCLUDED.fetched_at, revisions = garmin_observations.revisions + 1
WHERE garmin_observations.fetched_at <= EXCLUDED.fetched_at
  AND (garmin_observations.value_num IS DISTINCT FROM EXCLUDED.value_num OR garmin_observations.value_json IS DISTINCT FROM EXCLUDED.value_json)
RETURNING (xmax = 0)"""
        new = changed = 0
        with self._conn() as conn, conn.cursor() as cur:
            for o in rows:
                cur.execute(sql, (o.metric, o.kind, o.measured_at, o.ts_semantics, o.interval_s, o.value_num, Jsonb(o.value_json) if o.value_json is not None else None, o.unit, o.period, o.period_date, o.source_tool, o.origin, fetched_at, fetched_at, Jsonb(o.meta)))
                r = cur.fetchone()
                if r is not None:
                    new, changed = (new + 1, changed) if r[0] else (new, changed + 1)
        return new, changed

    @staticmethod
    def _stored(r) -> StoredObs:
        return StoredObs(*r)

    def latest_per_metric(self, metrics: list[str] | None = None) -> list[StoredObs]:
        with self._conn() as conn, conn.cursor() as cur:
            cur.execute(f"SELECT DISTINCT ON (metric) {_COLS} FROM garmin_observations WHERE (%s::text[] IS NULL OR metric = ANY(%s)) ORDER BY metric, measured_at DESC, id DESC", (metrics, metrics))
            return [self._stored(r) for r in cur.fetchall()]

    def history(self, metrics: list[str], start: datetime, end: datetime, limit: int, after: tuple[datetime, int] | None = None) -> list[StoredObs]:
        with self._conn() as conn, conn.cursor() as cur:
            cur.execute(
                f"SELECT {_COLS} FROM garmin_observations WHERE metric = ANY(%s) AND measured_at >= %s AND measured_at <= %s AND (%s::timestamptz IS NULL OR (measured_at, id) > (%s, %s)) ORDER BY measured_at, id LIMIT %s",
                (metrics, start, end, after[0] if after else None, after[0] if after else None, after[1] if after else 0, limit),
            )
            return [self._stored(r) for r in cur.fetchall()]

    def record_run(self, r: RunRecord) -> None:
        with self._conn() as conn, conn.cursor() as cur:
            cur.execute(
                "INSERT INTO garmin_poll_runs (job, started_at, finished_at, outcome, requests, cache_hits, rows_seen, rows_new, latest_measured_at, error_class, error_text, duration_ms) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (r.job, r.started_at, r.finished_at, r.outcome, r.requests, r.cache_hits, r.rows_seen, r.rows_new, r.latest_measured_at, r.error_class, scrub(r.error_text), r.duration_ms),
            )

    def recent_runs(self, since: datetime, limit: int = 200) -> list[RunRecord]:
        with self._conn() as conn, conn.cursor() as cur:
            cur.execute("SELECT job, started_at, outcome, finished_at, requests, cache_hits, rows_seen, rows_new, latest_measured_at, error_class, error_text, duration_ms FROM garmin_poll_runs WHERE started_at >= %s ORDER BY started_at DESC LIMIT %s", (since, limit))
            return [RunRecord(*r) for r in cur.fetchall()]

    def get_state(self, job: str) -> JobState:
        with self._conn() as conn, conn.cursor() as cur:
            cur.execute("SELECT last_attempt_at, last_success_at, last_outcome, consecutive_failures, slot_key, slot_attempts FROM garmin_job_state WHERE job = %s", (job,))
            r = cur.fetchone()
        return JobState(*r) if r else JobState()

    def put_state(self, job: str, **fields) -> None:
        from psycopg.types.json import Jsonb

        allowed = {"last_attempt_at", "last_success_at", "last_new_data_at", "last_measured_at", "last_outcome", "consecutive_failures", "slot_key", "slot_attempts", "extra"}
        bad = set(fields) - allowed
        if bad:
            raise ValueError(f"unknown state fields: {sorted(bad)}")
        cols = list(fields)
        vals = [Jsonb(fields[c]) if c == "extra" else fields[c] for c in cols]
        sets = ", ".join(f"{c} = EXCLUDED.{c}" for c in cols)
        with self._conn() as conn, conn.cursor() as cur:
            cur.execute(f"INSERT INTO garmin_job_state (job, {', '.join(cols)}, updated_at) VALUES (%s, {', '.join(['%s'] * len(cols))}, now()) ON CONFLICT (job) DO UPDATE SET {sets}, updated_at = now()", [job, *vals])

    def all_states(self) -> dict[str, dict]:
        with self._conn() as conn, conn.cursor() as cur:
            cur.execute("SELECT job, last_attempt_at, last_success_at, last_new_data_at, last_measured_at, last_outcome, consecutive_failures, extra, updated_at FROM garmin_job_state")
            cols = ["job", "last_attempt_at", "last_success_at", "last_new_data_at", "last_measured_at", "last_outcome", "consecutive_failures", "extra", "updated_at"]
            return {r[0]: dict(zip(cols[1:], r[1:])) for r in cur.fetchall()}

    def prune_runs(self, older_than: datetime) -> int:
        with self._conn() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM garmin_poll_runs WHERE started_at < %s", (older_than,))
            return cur.rowcount

    def acquire_singleton(self) -> bool:
        """Hold a session-level advisory lock for the life of the process: a second worker for the same database exits instead of overlapping."""
        self._lock_conn = self._psycopg.connect(self._url, autocommit=True, connect_timeout=10, application_name="garmin-worker-lock")
        with self._lock_conn.cursor() as cur:
            cur.execute("SELECT pg_try_advisory_lock(%s)", (727042,))
            return bool(cur.fetchone()[0])

    def close(self) -> None:
        conn = getattr(self, "_lock_conn", None)
        if conn is not None:
            conn.close()
