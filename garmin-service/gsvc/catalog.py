"""Which gateway tools each job calls, how often, and which parser reads the answer. All tools are read-only `get_*` tools the gateway really offers."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Callable

from . import parsers as P
from .config import Settings
from .metrics import metrics_in_group


@dataclass(frozen=True)
class ToolCall:
    tool: str
    args: Callable[[date], dict]
    parse: Callable
    previous_day_early: bool = False  # also fetch yesterday during the first minutes of the local day so its last intervals are not lost


@dataclass(frozen=True)
class Every:
    minutes: int


@dataclass(frozen=True)
class Slots:
    times: tuple  # local wall-clock times
    retry_min: int
    max_attempts: int


@dataclass(frozen=True)
class Job:
    name: str
    group: str
    calls: tuple[ToolCall, ...]
    schedule: object  # Every | Slots


def _d(day: date) -> dict:
    return {"date": day.isoformat()}


# Every tool name used anywhere in this service. Anything else is refused before a request is made (see gateway.ensure_read_only).
ALL_TOOLS = frozenset(
    {"get_heart_rates", "get_steps_data", "get_user_summary", "get_activities_fordate", "get_stress_data", "get_sleep_summary", "get_hrv_data", "get_spo2_data", "get_respiration_summary", "get_training_readiness"}
)


def build_jobs(s: Settings) -> list[Job]:
    return [
        Job(
            "fast",
            "fast",
            (
                ToolCall("get_heart_rates", _d, P.parse_heart_rates, previous_day_early=True),
                ToolCall("get_steps_data", _d, P.parse_steps, previous_day_early=True),
                ToolCall("get_user_summary", _d, P.parse_user_summary),
                ToolCall("get_activities_fordate", _d, P.parse_activities),
            ),
            Every(s.fast_interval_min),
        ),
        Job("stress", "stress", (ToolCall("get_stress_data", _d, P.parse_stress),), Every(s.stress_interval_min)),
        Job("sleep", "sleep", (ToolCall("get_sleep_summary", _d, P.parse_sleep),), Slots(s.sleep_slots, s.slot_retry_min, s.slot_max_attempts)),
        Job("hrv", "hrv", (ToolCall("get_hrv_data", lambda d: {"date": d.isoformat(), "return_timeseries": False}, P.parse_hrv),), Slots(s.hrv_slots, s.slot_retry_min, s.slot_max_attempts)),
        Job(
            "spo2_resp",
            "spo2_resp",
            (ToolCall("get_spo2_data", _d, P.parse_spo2), ToolCall("get_respiration_summary", _d, P.parse_respiration)),
            Slots(s.spo2_resp_slots, s.slot_retry_min, s.slot_max_attempts),
        ),
        Job("readiness", "readiness", (ToolCall("get_training_readiness", _d, P.parse_readiness),), Slots(s.readiness_slots, s.slot_retry_min, s.slot_max_attempts)),
    ]


def job_by_name(jobs: list[Job], name: str) -> Job:
    return next(j for j in jobs if j.name == name)
