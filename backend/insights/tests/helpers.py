"""Synthetic data and fakes for tests. SYNTHETIC ONLY: nothing here is, or is derived from, a real person's data."""
from __future__ import annotations

import json
import re
import math
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Optional
from zoneinfo import ZoneInfo

from sugarsense_insights.config import Thresholds
from sugarsense_insights.llm import LlmReply
from sugarsense_insights.models import (Activity, ForecastPoint, Insulin, Meal, Reading, Sleep, Snapshot, UserSettings, WearableSample)

UTC = timezone.utc
TZ = "Asia/Beirut"
USER = "00000000-0000-0000-0000-000000000001"


def _g(minutes_local: float) -> float:
    """Synthetic daily glucose curve (mg/dL): pre-dawn ~100, morning rise to ~150, three meal bumps."""
    v = 100.0
    v += 40 * math.exp(-((minutes_local - 7.5 * 60) ** 2) / (2 * 60 ** 2))
    for center in (9.5 * 60, 14.5 * 60, 21.0 * 60):   # peaks one hour after the 08:30 / 13:30 / 20:00 meals
        v += 125 * math.exp(-((minutes_local - center) ** 2) / (2 * 40 ** 2))
    return v


def cgm(days: int, now: datetime, tz: str = TZ, step_min: int = 5, curve: Callable[[float], float] = _g, skip: Callable[[datetime], bool] = lambda t: False) -> list[Reading]:
    z = ZoneInfo(tz)
    out = []
    t = (now - timedelta(days=days)).replace(second=0, microsecond=0)
    t -= timedelta(minutes=t.minute % step_min)
    while t <= now:
        if not skip(t):
            lt = t.astimezone(z)
            out.append(Reading(t, round(curve(lt.hour * 60 + lt.minute), 1)))
        t += timedelta(minutes=step_min)
    return out


def local(y, mo, d, h, mi, tz: str = TZ) -> datetime:
    return datetime(y, mo, d, h, mi, tzinfo=ZoneInfo(tz)).astimezone(UTC)


def snapshot(now: datetime, days: int = 8, *, tz: str = TZ, readings: Optional[list[Reading]] = None, meals=None, insulin=None, activities=None, sleeps=None,
             wearables=None, forecast=None, th: Optional[Thresholds] = None) -> Snapshot:
    return Snapshot(UserSettings(USER, tz, th or Thresholds()), now, cgm(days, now, tz) if readings is None else readings, meals or [], insulin or [],
                    activities or [], sleeps or [], wearables or [], forecast or [])


class FakeSource:
    def __init__(self, snap: Snapshot) -> None:
        self.snap = snap

    def load(self, user_id, now, lookback_days):
        return self.snap

    def list_users(self):
        return [USER]


def breakfast_meals(now: datetime, days: int, carbs: float = 50.0) -> list[Meal]:
    z = ZoneInfo(TZ)
    out = []
    for k in range(days + 1):
        d = (now.astimezone(z) - timedelta(days=k)).date()
        out.append(Meal(f"m{k}", datetime(d.year, d.month, d.day, 8, 30, tzinfo=z).astimezone(UTC), "confirmed", carbs))
    return out


# ---- fake model --------------------------------------------------------------------------------------------------------
UNIT_WORD = {"mg/dL": "mg/dL", "%": "%", "min": "minutes", "g": "g", "count": "", "": ""}


def good_text(p: dict[str, Any]) -> dict[str, Any]:
    """A faithful explanation built only from the candidate's own first claim (the payload carries claims + refs, not a facts table)."""
    first = p["claims"][0]
    refs = list(dict.fromkeys(re.findall(r"E\d+", first)))[:6]
    txt = re.sub(r"\s*\[E\d+(?:,\s*E\d+)*\]", "", first)
    txt = txt[:300] if len(txt) <= 300 else txt[:txt[:300].rfind(" ")].rstrip(",;:") + "."
    return {"schema_version": "insight-explain-v1", "insight_id": p["insight_id"], "explanation": txt, "evidence_refs": refs or p["refs"][:1], "limitation": None, "insufficient_evidence": False}


class FakeLLM:
    """Scriptable. mode: 'good' | callable(call_index, payloads, correction) -> LlmReply."""

    def __init__(self, mode: Any = "good") -> None:
        self.mode = mode
        self.calls: list[dict[str, Any]] = []

    def explain(self, payloads, correction=None):
        i = len(self.calls)
        self.calls.append({"n": len(payloads), "correction": correction, "payloads": payloads})
        if callable(self.mode):
            return self.mode(i, payloads, correction)
        return LlmReply(json.dumps({"results": [good_text(p) for p in payloads]}), None, 0.01, 100, 20)


def reply_with(items: list[dict[str, Any]]) -> LlmReply:
    return LlmReply(json.dumps({"results": items}), None, 0.01, 100, 20)
