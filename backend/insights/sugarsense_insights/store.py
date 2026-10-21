"""Persistence. InMemoryStore (tests, dry runs) and PgStore (production; psycopg imported lazily so the engine and its tests need no driver).

The store only ever writes insight_runs and insights. Idempotency: claim_run() is the single gate; a finished run is never redone.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional, Protocol

STALE_RUNNING = timedelta(minutes=30)


class Store(Protocol):
    def claim_run(self, user_id: str, run_key: str, kind: str, now: datetime, engine_version: str, prompt_version: str, model_version: Optional[str]) -> tuple[Optional[int], str]: ...
    def finish_run(self, run_id: int, status: str, stats: dict[str, Any], now: datetime) -> None: ...
    def history(self, user_id: str, since: datetime) -> list[dict[str, Any]]: ...
    def save_insight(self, user_id: str, run_id: int, rec: dict[str, Any]) -> str: ...
    def supersede(self, insight_id: str, now: datetime) -> None: ...
    def active(self, user_id: str, now: datetime) -> list[dict[str, Any]]: ...


class InMemoryStore:
    def __init__(self) -> None:
        self.runs: dict[tuple[str, str], dict[str, Any]] = {}
        self.insights: dict[str, dict[str, Any]] = {}
        self._n = 0

    def claim_run(self, user_id, run_key, kind, now, engine_version, prompt_version, model_version):
        k = (user_id, run_key)
        r = self.runs.get(k)
        if r is None:
            self._n += 1
            self.runs[k] = {"run_id": self._n, "status": "running", "started_at": now, "kind": kind, "stats": {}, "engine_version": engine_version}
            return self._n, "claimed"
        if r["status"] == "complete":
            return r["run_id"], "complete"
        if r["status"] == "failed" or (r["status"] == "running" and now - r["started_at"] > STALE_RUNNING):
            r.update(status="running", started_at=now)
            return r["run_id"], "claimed"
        return r["run_id"], "busy"

    def finish_run(self, run_id, status, stats, now):
        for r in self.runs.values():
            if r["run_id"] == run_id:
                r.update(status=status, stats=stats, finished_at=now)

    def history(self, user_id, since):
        ev = {r["run_id"]: r.get("engine_version") for r in self.runs.values()}
        return [dict(i, insight_id=iid, paragraph=(i.get("content") or {}).get("paragraph"), source=(i.get("content") or {}).get("source"), engine_version=ev.get(i.get("run_id")))
                for iid, i in self.insights.items() if i["user_id"] == user_id and i["created_at"] >= since]

    def save_insight(self, user_id, run_id, rec):
        iid = str(uuid.uuid4())
        self.insights[iid] = {"user_id": user_id, "run_id": run_id, "status": "active", **rec}
        return iid

    def supersede(self, insight_id, now):
        self.insights[insight_id]["status"] = "superseded"

    def active(self, user_id, now):
        out = []
        for iid, i in self.insights.items():
            if i["user_id"] == user_id and i["status"] == "active" and (i.get("expires_at") is None or i["expires_at"] > now):
                out.append(dict(i, insight_id=iid))
        return sorted(out, key=lambda r: -r["priority"])


class PgStore:
    def __init__(self, dsn: str) -> None:
        import psycopg  # type: ignore
        self._psycopg = psycopg
        self.dsn = dsn

    def _conn(self):
        return self._psycopg.connect(self.dsn, autocommit=True, connect_timeout=10)

    def claim_run(self, user_id, run_key, kind, now, engine_version, prompt_version, model_version):
        with self._conn() as c:
            row = c.execute(
                """INSERT INTO insight_runs (user_id, run_key, kind, status, started_at, engine_version, prompt_version, model_version)
                   VALUES (%s,%s,%s,'running',%s,%s,%s,%s)
                   ON CONFLICT (user_id, run_key) DO UPDATE SET status='running', started_at=EXCLUDED.started_at,
                       engine_version=EXCLUDED.engine_version, prompt_version=EXCLUDED.prompt_version, model_version=EXCLUDED.model_version
                   WHERE insight_runs.status='failed' OR (insight_runs.status='running' AND insight_runs.started_at < %s)
                   RETURNING run_id""",
                (user_id, run_key, kind, now, engine_version, prompt_version, model_version, now - STALE_RUNNING)).fetchone()
            if row:
                return row[0], "claimed"
            cur = c.execute("SELECT run_id, status FROM insight_runs WHERE user_id=%s AND run_key=%s", (user_id, run_key)).fetchone()
            return (cur[0], "complete" if cur[1] == "complete" else "busy") if cur else (None, "busy")

    def finish_run(self, run_id, status, stats, now):
        with self._conn() as c:
            c.execute("UPDATE insight_runs SET status=%s, finished_at=%s, stats=%s::jsonb WHERE run_id=%s", (status, now, json.dumps(stats), run_id))

    def history(self, user_id, since):
        with self._conn() as c:
            rows = c.execute(
                """SELECT i.insight_id::text, i.dedupe_key, i.category, i.trigger, i.facts_hash, i.content_version, i.created_at, i.status, i.evidence, i.content->>'paragraph', i.content->>'source', r.engine_version
                   FROM insights i LEFT JOIN insight_runs r ON r.run_id = i.run_id WHERE i.user_id=%s AND i.created_at >= %s""", (user_id, since)).fetchall()
        return [{"insight_id": r[0], "dedupe_key": r[1], "category": r[2], "trigger": r[3], "facts_hash": r[4], "content_version": r[5],
                 "created_at": r[6], "status": r[7], "evidence_facts": [[f["name"], f["value"], f["unit"]] for f in (r[8] or {}).get("facts", [])], "paragraph": r[9], "source": r[10], "engine_version": r[11]} for r in rows]

    def save_insight(self, user_id, run_id, rec):
        with self._conn() as c:
            row = c.execute(
                """INSERT INTO insights (user_id, run_id, category, trigger, dedupe_key, facts_hash, content_version, supersedes_insight_id,
                       observation_start, observation_end, priority, status, validation_status, evidence, content, expires_at)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'active',%s,%s::jsonb,%s::jsonb,%s)
                   ON CONFLICT (user_id, dedupe_key, content_version) DO NOTHING RETURNING insight_id::text""",
                (user_id, run_id, rec["category"], rec["trigger"], rec["dedupe_key"], rec["facts_hash"], rec["content_version"], rec.get("supersedes_insight_id"),
                 rec["observation_start"], rec["observation_end"], rec["priority"], rec["validation_status"], json.dumps(rec["evidence"]), json.dumps(rec["content"]), rec.get("expires_at"))).fetchone()
            return row[0] if row else ""

    def supersede(self, insight_id, now):
        with self._conn() as c:
            c.execute("UPDATE insights SET status='superseded' WHERE insight_id=%s", (insight_id,))

    def active(self, user_id, now):
        with self._conn() as c:
            rows = c.execute("SELECT insight_id::text, category, priority, content FROM insights WHERE user_id=%s AND status='active' AND (expires_at IS NULL OR expires_at > %s) ORDER BY priority DESC", (user_id, now)).fetchall()
        return [{"insight_id": r[0], "category": r[1], "priority": float(r[2]), "content": r[3]} for r in rows]
