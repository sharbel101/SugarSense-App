import os
import re
import unittest
from datetime import timedelta

from sugarsense_insights.config import Thresholds
from sugarsense_insights.models import ForecastPoint, Insulin, Meal, Sleep, Activity
from sugarsense_insights.pipeline import build_candidates
from sugarsense_insights.quality import assess, clean_readings
from sugarsense_insights.validate import NUM_RE, TAG_RE

from helpers import breakfast_meals, local, snapshot

MORNING = local(2026, 10, 21, 7, 30)
EVENING = local(2026, 10, 21, 21, 0)
PKG = os.path.join(os.path.dirname(__file__), "..", "sugarsense_insights")


def rich(now, th=None):
    meals = breakfast_meals(now, 9)
    ins = [Insulin(f"i{k}", m.t - timedelta(minutes=5 + k), "bolus", 4.0, True) for k, m in enumerate(meals)]
    acts = [Activity(local(2026, 10, 20, 17, 0) - timedelta(days=k), "walk", 30.0, "light") for k in range(9)]
    sl = [Sleep(local(2026, 10, 20, 23, 0) - timedelta(days=k), local(2026, 10, 21, 6, 30) - timedelta(days=k), 400.0 + 12 * k, 0.8) for k in range(9)]
    fc = [ForecastPoint(now - timedelta(minutes=5), h, now + timedelta(minutes=h - 5), 130.0, 62.0, 190.0, 0.8) for h in (60, 120)]
    return snapshot(now, days=10, meals=meals, insulin=ins, activities=acts, sleeps=sl, forecast=fc, th=th)


class Traceability(unittest.TestCase):
    def candidates(self, kind, now, mode="full"):
        snap = rich(now, Thresholds(insight_mode=mode))
        clean, flags = clean_readings(snap.readings, now, snap.settings.th)
        cands, _ = build_candidates(kind, snap, clean, flags, assess(snap, clean, flags))
        return snap, cands

    def test_every_number_in_every_claim_is_traceable_and_every_fact_is_cited(self):
        for mode, kind, now in (("full", "morning", MORNING), ("full", "evening", EVENING), ("episodes", "morning", MORNING), ("episodes", "evening", EVENING)):
            snap, cands = self.candidates(kind, now, mode)
            self.assertGreaterEqual(len(cands), 3, (mode, kind))
            th = snap.settings.th
            thresholds = {th.low_mgdl, th.high_mgdl, th.morning_rise_mgdl, th.meal_response_min_rise_mgdl, float(th.excursion_min_minutes), 3.0, 30.0, 2.0, 24.0}
            for c in cands:
                fact_vals = {float(f.value) for f in c.facts if isinstance(f.value, (int, float))}
                refs = {f.ref for f in c.facts}
                for claim in c.claims:
                    cited = set(re.findall(r"E\d+", claim)) - set()
                    self.assertTrue(cited <= refs, (c.category, claim))
                    body = TAG_RE.sub(" ", claim)
                    body = re.sub(r"\b\d{2}:\d{2}\b", " ", body)                 # clock times come from the data window itself
                    for m in NUM_RE.finditer(body):
                        v = float(m.group(1))
                        self.assertTrue(v in fact_vals or v in thresholds, f"untraceable number {v} in {c.category}: {claim}")
                self.assertEqual({f.ref for f in c.facts} - set(re.findall(r"E\d+", " ".join(c.claims))), set(), f"fact not cited in {c.category}")
                self.assertEqual(len({f.ref for f in c.facts}), len(c.facts), "refs must be unique")

    def test_fact_values_are_what_the_text_shows(self):
        _, cands = self.candidates("morning", MORNING)
        ov = next(c for c in cands if c.category == "overnight_summary")
        mn = next(f for f in ov.facts if f.name == "overnight_min")
        self.assertIn(f"lowest {mn.value} mg/dL", ov.claims[0])


class Guards(unittest.TestCase):
    def source(self, name):
        with open(os.path.join(PKG, name), encoding="utf-8") as fh:
            return fh.read()

    def test_only_two_tables_are_ever_written(self):
        written = set()
        for f in os.listdir(PKG):
            if f.endswith(".py"):
                for m in re.finditer(r"(?:INSERT INTO|UPDATE|DELETE FROM)\s+([a-z_]+)", self.source(f)):
                    written.add(m.group(1))
        self.assertEqual(written, {"insight_runs", "insights"})

    def test_source_adapter_is_read_only(self):
        s = self.source("db_source.py")
        self.assertIn("default_transaction_read_only=on", s)
        self.assertNotRegex(s, r"INSERT|UPDATE |DELETE")

    def test_engine_does_not_touch_alert_or_forecast_services(self):
        for f in os.listdir(PKG):
            if f.endswith(".py"):
                s = self.source(f)
                self.assertNotRegex(s, r"forecast_service|collector_monitor|forecast-push|bg_service|8001|8000", f)
        # forecasts are only READ from the predictions table (by db_source); nothing in the engine writes one
        self.assertNotRegex(self.source("store.py"), r"predictions|forecast_runs")

    def test_cli_logs_no_health_content_by_default(self):
        s = self.source("cli.py")
        self.assertIn("--show", s)
        summary = re.search(r"def _summary.*?\n\n", s, re.S).group(0)
        for banned in ("claims", "content", "facts", "explanation", "note"):
            self.assertNotIn(banned, summary)

    def test_llm_client_binds_to_localhost_only(self):
        from sugarsense_insights.config import LlmConfig
        self.assertTrue(LlmConfig().url.startswith("http://127.0.0.1"))


if __name__ == "__main__":
    unittest.main()
