"""MemStore semantics always; the same contract against real PostgreSQL when GARMIN_TEST_DATABASE_URL points at a scratch database with migration 0011 applied."""
import os
from datetime import date, datetime, timedelta, timezone

import pytest

from gsvc.parsers import Obs
from gsvc.store import MemStore, PgStore, RunRecord, scrub

UTC = timezone.utc
T0 = datetime(2026, 10, 21, 8, 0, tzinfo=UTC)


def hr(minute, v, tool="dailyHeartRate"):
    return Obs("heart_rate", T0 + timedelta(minutes=minute), "instant", value_num=v, source_tool=tool)


def stores():
    out = [pytest.param(lambda: MemStore(), id="mem")]
    url = os.environ.get("GARMIN_TEST_DATABASE_URL")
    if url:
        def make():
            s = PgStore(url)
            with s._conn() as c, c.cursor() as cur:
                cur.execute("DELETE FROM garmin_observations; DELETE FROM garmin_poll_runs; DELETE FROM garmin_job_state")
            return s
        out.append(pytest.param(make, id="postgres"))
    return out


@pytest.fixture(params=stores())
def store(request):
    return request.param()


def test_inserting_the_same_measurement_twice_creates_one_row(store):
    f1, f2 = T0 + timedelta(minutes=10), T0 + timedelta(minutes=17)
    assert store.upsert_observations([hr(0, 70), hr(2, 72)], f1) == (2, 0)
    assert store.upsert_observations([hr(0, 70), hr(2, 72), hr(4, 74)], f2) == (1, 0)
    assert len(store.history(["heart_rate"], T0 - timedelta(hours=1), T0 + timedelta(hours=1), 100)) == 3


def test_a_later_fetch_may_revise_but_an_older_one_never_overwrites_a_newer_one(store):
    step = lambda v: Obs("steps_day_cumulative", T0, "period_end", value_num=v, period="local_day", period_date=date(2026, 10, 21), source_tool="dailysummaries")
    store.upsert_observations([step(11)], T0 + timedelta(minutes=10))
    assert store.upsert_observations([step(40)], T0 + timedelta(minutes=17)) == (0, 1)  # the day total grew
    assert store.upsert_observations([step(11)], T0 + timedelta(minutes=12)) == (0, 0)  # an older answer arrives late: ignored
    row = store.latest_per_metric(["steps_day_cumulative"])[0]
    assert row.value_num == 40 and row.revisions == 1 and row.fetched_at == T0 + timedelta(minutes=17)


def test_cumulative_values_are_separate_rows_and_never_added(store):
    c = lambda m, v: Obs("steps_day_cumulative", T0 + timedelta(minutes=m), "period_end", value_num=v, period="local_day", period_date=date(2026, 10, 21), source_tool="dailysummaries")
    store.upsert_observations([c(0, 1000), c(7, 1100)], T0)
    rows = store.history(["steps_day_cumulative"], T0 - timedelta(hours=1), T0 + timedelta(hours=1), 10)
    assert [r.value_num for r in rows] == [1000, 1100] and store.latest_per_metric(["steps_day_cumulative"])[0].value_num == 1100


def test_measured_at_is_kept_apart_from_fetched_at(store):
    store.upsert_observations([hr(0, 70)], T0 + timedelta(minutes=25))
    r = store.latest_per_metric(None)[0]
    assert r.measured_at == T0 and r.fetched_at == T0 + timedelta(minutes=25) and r.first_fetched_at == r.fetched_at


def test_history_is_chronological_bounded_and_pages_by_cursor(store):
    store.upsert_observations([hr(m, 60 + m) for m in (8, 0, 4, 2, 6)], T0)
    got = store.history(["heart_rate"], T0, T0 + timedelta(minutes=8), 3)
    assert [g.value_num for g in got] == [60, 62, 64]
    nxt = store.history(["heart_rate"], T0, T0 + timedelta(minutes=8), 3, after=(got[-1].measured_at, got[-1].id))
    assert [g.value_num for g in nxt] == [66, 68]
    assert store.history(["heart_rate"], T0 + timedelta(hours=2), T0 + timedelta(hours=3), 10) == []


def test_job_state_and_runs_round_trip(store):
    store.put_state("fast", last_attempt_at=T0, last_outcome="ok", consecutive_failures=0)
    store.put_state("fast", consecutive_failures=2, slot_key="k", slot_attempts=1)
    st = store.get_state("fast")
    assert st.last_attempt_at == T0 and st.consecutive_failures == 2 and st.slot_key == "k"
    assert store.get_state("nope").last_attempt_at is None
    store.record_run(RunRecord("fast", T0, "ok", finished_at=T0, requests=4, rows_new=3))
    assert store.recent_runs(T0 - timedelta(minutes=1))[0].requests == 4
    assert store.prune_runs(T0 + timedelta(days=1)) == 1


def test_error_text_is_scrubbed_before_storage():
    t = scrub("failed https://x.example/cb?code=abc token Bearer abcdef0123456789abcdef0123456789abcdef01 for a@b.co " + "A" * 60)
    assert "https" not in t and "Bearer" not in t and "a@b.co" not in t and "AAAA" not in t and len(t) <= 160
