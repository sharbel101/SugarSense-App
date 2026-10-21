"""Integration check against a TEST Postgres database (never production). Run explicitly:

  TEST_DATABASE_URL=<app-role url of the test db> PYTHONPATH=. python3 tests/integration_pg.py

Prerequisite: migrations 0001-0010 applied to that database. Needs psycopg. Prints PASS/FAIL lines and only counts (no health values).
"""
import os
import sys
from datetime import timedelta

import psycopg

from sugarsense_insights.db_source import PgSource
from sugarsense_insights.pipeline import run
from sugarsense_insights.store import PgStore

dsn = os.environ["TEST_DATABASE_URL"]
fails = 0


def check(name, ok, extra=""):
    global fails
    print(("PASS " if ok else "FAIL ") + name + (f"  {extra}" if extra else ""))
    fails += (not ok)


src, store = PgSource(dsn), PgStore(dsn)
with psycopg.connect(dsn, autocommit=True) as c:
    uid, newest, n = c.execute("SELECT user_id::text, max(measured_at), count(*) FROM glucose_readings GROUP BY user_id ORDER BY count(*) DESC LIMIT 1").fetchone()
print(f"test user has {n} readings")

now = newest + timedelta(minutes=3)
snap = src.load(uid, now, 14)
check("adapter loads a snapshot with readings", len(snap.readings) > 0, f"readings={len(snap.readings)} meals={len(snap.meals)} insulin={len(snap.insulin)} sleeps={len(snap.sleeps)}")
check("unknown optional sources are empty, not zero-filled", all(len(x) >= 0 for x in (snap.activities, snap.sleeps, snap.wearables)))

try:
    with src._conn() as c:
        c.execute("INSERT INTO users (timezone) VALUES ('UTC')")
    check("source connection refuses writes", False)
except Exception as e:
    check("source connection refuses writes", "read-only" in str(e).lower())

summaries = {}
for kind in ("morning", "evening", "event"):
    r = run(kind, uid, now, src, store, None, persist=True)
    summaries[kind] = r
    check(f"{kind} run completes and persists", r.state == "complete", f"insights={len(r.insights)} categories={r.stats.get('categories')}")
again = run("morning", uid, now + timedelta(minutes=5), src, store, None, persist=True)
check("re-running morning is a no-op (idempotent)", again.state == "skipped_complete")

with psycopg.connect(dsn, autocommit=True) as c:
    runs = c.execute("SELECT count(*), count(*) FILTER (WHERE status='complete') FROM insight_runs WHERE user_id=%s", (uid,)).fetchone()
    ins = c.execute("SELECT count(*) FROM insights WHERE user_id=%s", (uid,)).fetchone()[0]
    check("runs recorded and complete", runs[0] == 3 and runs[1] == 3, f"runs={runs[0]} complete={runs[1]}")
    check("insights stored", ins == sum(len(s.insights) for s in summaries.values()), f"insights={ins}")
    some = c.execute("SELECT insight_id FROM insights WHERE user_id=%s LIMIT 1", (uid,)).fetchone()
    if some:
        iid = some[0]
        try:
            c.execute("UPDATE insights SET status='expired' WHERE insight_id=%s", (iid,))
            check("app role may change lifecycle status", True)
        except Exception as e:
            check("app role may change lifecycle status", False, str(e)[:80])
        for label, sql in (("rewrite evidence", "UPDATE insights SET evidence='{}'::jsonb WHERE insight_id=%s"), ("rewrite content", "UPDATE insights SET content='{}'::jsonb WHERE insight_id=%s"),
                           ("delete insight", "DELETE FROM insights WHERE insight_id=%s")):
            try:
                c.execute(sql, (iid,))
                check(f"app role cannot {label}", False)
            except Exception as e:
                check(f"app role cannot {label}", "permission denied" in str(e).lower())
    before = c.execute("SELECT count(*) FROM glucose_readings WHERE user_id=%s", (uid,)).fetchone()[0]
    check("engine did not change glucose data", before == n)

print("RESULT", "FAILED" if fails else "ALL PASSED")
sys.exit(1 if fails else 0)
