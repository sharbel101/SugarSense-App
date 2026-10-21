"""Read-only Postgres adapter. Reads existing tables only; maps NULL to None (never to zero); cancelled records are excluded.

Requires the optional psycopg driver (imported lazily). Use a read-capable role: the app role's DATABASE_URL works (SELECT everywhere).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from .config import thresholds_for
from .models import (Activity, ForecastPoint, Insulin, Meal, Reading, Sleep, Snapshot, UserSettings, WearableSample)


def _f(x: Any) -> Optional[float]:
    return None if x is None else float(x)


class PgSource:
    def __init__(self, dsn: str) -> None:
        import psycopg  # type: ignore
        self._psycopg = psycopg
        self.dsn = dsn

    def _conn(self):
        # read-only session: this adapter must never be able to write
        return self._psycopg.connect(self.dsn, autocommit=True, connect_timeout=10, options="-c default_transaction_read_only=on")

    def list_users(self) -> list[str]:
        with self._conn() as c:
            return [r[0] for r in c.execute("SELECT user_id::text FROM users ORDER BY created_at, user_id").fetchall()]

    def load(self, user_id: str, now: datetime, lookback_days: int) -> Snapshot:
        since = now - timedelta(days=lookback_days)
        with self._conn() as c:
            u = c.execute("SELECT timezone, profile FROM users WHERE user_id=%s", (user_id,)).fetchone()
            if u is None:
                raise LookupError("unknown user")
            settings = UserSettings(user_id, u[0], thresholds_for(u[1]))
            readings = [Reading(r[0], float(r[1]), r[2], _f(r[3])) for r in c.execute(
                "SELECT measured_at, glucose_mgdl, source, sensor_quality FROM glucose_readings WHERE user_id=%s AND measured_at BETWEEN %s AND %s ORDER BY measured_at",
                (user_id, since, now + timedelta(minutes=30))).fetchall()]
            meals = [Meal(r[0], r[1], r[2], _f(r[3]), _f(r[4]), _f(r[5]), r[6]) for r in c.execute(
                "SELECT meal_id::text, eaten_at, status, carbs_g, fat_g, protein_g, note FROM meal_events WHERE user_id=%s AND eaten_at >= %s AND status <> 'cancelled'",
                (user_id, since)).fetchall()]
            insulin = [Insulin(r[0], r[1], r[2], _f(r[3]), r[4] == "confirmed") for r in c.execute(
                "SELECT insulin_id::text, administered_at, kind, units_administered, confirmation FROM insulin_events WHERE user_id=%s AND administered_at >= %s AND status='active'",
                (user_id, since)).fetchall()]
            acts = [Activity(r[0], r[1], _f(r[2]), r[3], r[4]) for r in c.execute(
                "SELECT started_at, activity_type, duration_min, intensity, source FROM activity_events WHERE user_id=%s AND started_at >= %s", (user_id, since)).fetchall()]
            sleeps = [Sleep(r[0], r[1], _f(r[2]), _f(r[3]), r[4]) for r in c.execute(
                "SELECT started_at, ended_at, duration_min, quality_score, source FROM sleep_events WHERE user_id=%s AND started_at >= %s", (user_id, since)).fetchall()]
            wear: list[WearableSample] = []
            for r in c.execute("SELECT feature_at, hr_mean_bpm, hrv_rmssd_ms FROM context_features WHERE user_id=%s AND feature_at >= %s", (user_id, since)).fetchall():
                if r[1] is not None:
                    wear.append(WearableSample(r[0], "heart_rate", float(r[1]), "bpm", "context_features"))
                if r[2] is not None:
                    wear.append(WearableSample(r[0], "hrv_rmssd", float(r[2]), "ms", "context_features"))
            fc = [ForecastPoint(r[0], int(r[1]), r[2], float(r[3]), float(r[4]), float(r[5]), float(r[6])) for r in c.execute(
                """SELECT anchor_at, horizon_min, target_at, predicted_mgdl, lower_mgdl, upper_mgdl, interval_level FROM predictions
                   WHERE user_id=%s AND anchor_at = (SELECT max(anchor_at) FROM predictions WHERE user_id=%s) ORDER BY horizon_min""", (user_id, user_id)).fetchall()]
        return Snapshot(settings, now, readings, meals, insulin, acts, sleeps, wear, fc)
