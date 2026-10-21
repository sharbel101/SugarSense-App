from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from gsvc.catalog import Every, Job, Slots, build_jobs
from gsvc.config import ConfigError, load_settings
from gsvc.scheduler import JobState, is_due, next_wakeup

TZ = ZoneInfo("Asia/Beirut")
UTC = timezone.utc
T = datetime(2026, 10, 21, 9, 0, tzinfo=UTC)  # 12:00 local


def every(n=7):
    return Job("fast", "fast", (), Every(n))


def slots(*hhmm, retry=60, maxa=4):
    from datetime import time

    return Job("sleep", "sleep", (), Slots(tuple(time(int(h), int(m)) for h, m in (x.split(":") for x in hhmm)), retry, maxa))


def test_every_runs_first_time_then_waits_the_interval_after_the_last_attempt():
    assert is_due(every(), JobState(), T, TZ).due
    st = JobState(last_attempt_at=T - timedelta(minutes=6, seconds=59))
    assert not is_due(every(), st, T, TZ).due
    assert is_due(every(), JobState(last_attempt_at=T - timedelta(minutes=7)), T, TZ).due


def test_failures_double_the_wait_up_to_an_hour_and_never_go_faster_than_the_interval():
    base = T - timedelta(minutes=10)
    assert not is_due(every(), JobState(last_attempt_at=base, consecutive_failures=1), T, TZ).due  # needs 14 min
    assert is_due(every(), JobState(last_attempt_at=T - timedelta(minutes=14), consecutive_failures=1), T, TZ).due
    st = JobState(last_attempt_at=T - timedelta(minutes=59), consecutive_failures=9)
    assert not is_due(every(), st, T, TZ).due and is_due(every(), JobState(last_attempt_at=T - timedelta(minutes=61), consecutive_failures=9), T, TZ).due


def test_restart_does_not_burst_because_due_time_comes_from_persisted_state():
    st = JobState(last_attempt_at=T - timedelta(minutes=1))  # restarted a minute after the last poll
    assert not is_due(every(), st, T, TZ).due


def test_jitter_only_delays():
    st = JobState(last_attempt_at=T - timedelta(minutes=7))
    assert not is_due(every(), st, T, TZ, jitter_s=20).due


def test_slot_before_first_slot_is_not_due_and_names_the_next_time():
    d = is_due(slots("07:30", "11:30"), JobState(), datetime(2026, 10, 21, 3, 0, tzinfo=UTC), TZ)  # 06:00 local
    assert not d.due and d.next_at == datetime(2026, 10, 21, 4, 30, tzinfo=UTC)


def test_slot_open_runs_then_retries_every_hour_until_a_non_empty_answer_or_attempts_run_out():
    j = slots("07:30", "11:30")
    now = datetime(2026, 10, 21, 5, 0, tzinfo=UTC)  # 08:00 local, slot 07:30 open
    d = is_due(j, JobState(), now, TZ)
    assert d.due and d.slot_key
    st = JobState(last_attempt_at=now, slot_key=d.slot_key, slot_attempts=1, last_outcome="empty")
    assert not is_due(j, st, now + timedelta(minutes=30), TZ).due
    assert is_due(j, st, now + timedelta(minutes=60), TZ).due
    used = JobState(last_attempt_at=now, slot_key=d.slot_key, slot_attempts=4)
    assert not is_due(j, used, now + timedelta(minutes=90), TZ).due


def test_slot_that_succeeded_is_not_rerun_after_a_restart_and_the_next_slot_opens_later():
    j = slots("07:30", "11:30")
    now = datetime(2026, 10, 21, 5, 30, tzinfo=UTC)  # 08:30 local
    ok = JobState(last_success_at=datetime(2026, 10, 21, 5, 0, tzinfo=UTC), last_attempt_at=datetime(2026, 10, 21, 5, 0, tzinfo=UTC))
    d = is_due(j, ok, now, TZ)
    assert not d.due and d.next_at == datetime(2026, 10, 21, 8, 30, tzinfo=UTC)
    later = datetime(2026, 10, 21, 8, 31, tzinfo=UTC)  # 11:31 local: second slot opens
    assert is_due(j, ok, later, TZ).due


def test_slots_follow_local_time_across_the_dst_change():
    j = slots("07:30")
    before = datetime(2026, 10, 24, 4, 31, tzinfo=UTC)  # 07:31 local (UTC+3) on Sat 24 Oct
    after = datetime(2026, 10, 26, 5, 31, tzinfo=UTC)  # 07:31 local (UTC+2) on Mon 26 Oct (Lebanon ends DST on the last Sunday of October)
    assert is_due(j, JobState(), before, TZ).due and is_due(j, JobState(), after, TZ).due
    assert not is_due(j, JobState(), datetime(2026, 10, 26, 5, 29, tzinfo=UTC), TZ).due


def test_next_wakeup_is_bounded():
    assert next_wakeup([], T) == 300
    assert next_wakeup([T + timedelta(seconds=5)], T) == 30
    assert next_wakeup([T + timedelta(hours=3)], T) == 300


def test_default_schedule_is_seven_minutes_and_daily_slots():
    jobs = {j.name: j for j in build_jobs(load_settings({}, env_file=None))}
    assert jobs["fast"].schedule == Every(7) and jobs["stress"].schedule == Every(30)
    assert isinstance(jobs["sleep"].schedule, Slots) and len(jobs["readiness"].schedule.times) == 3


def test_configuration_is_validated_and_polling_is_off_by_default():
    s = load_settings({}, env_file=None)
    assert s.polling_enabled is False and s.host == "127.0.0.1" and s.port == 8310 and s.cors_origins == ()
    for bad in ({"GARMIN_FAST_INTERVAL_MIN": "4"}, {"GARMIN_FAST_INTERVAL_MIN": "x"}, {"GARMIN_SLEEP_SLOTS": "25:99"}, {"GARMIN_CORS_ORIGINS": "*"}, {"GARMIN_LOCAL_TZ": "Mars/Base"}, {"GARMIN_POLLING_ENABLED": "maybe"}):
        try:
            load_settings(bad, env_file=None)
            raise AssertionError(f"accepted {bad}")
        except ConfigError:
            pass
    ok = load_settings({"GARMIN_FAST_INTERVAL_MIN": "6", "GARMIN_POLLING_ENABLED": "true", "GARMIN_CORS_ORIGINS": "http://localhost:8081, https://a.example"}, env_file=None)
    assert ok.fast_interval_min == 6 and ok.polling_enabled and ok.cors_origins == ("http://localhost:8081", "https://a.example")
