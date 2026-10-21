"""Forecast-performance insight and the evidence framework. Synthetic data only; every expectation is computed by hand in the comments."""
import dataclasses
import os
import random
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

from sugarsense_insights import evidence as EV
from sugarsense_insights import performance as PERF
from sugarsense_insights.models import ScoredForecast
from sugarsense_insights.pipeline import run
from sugarsense_insights.store import InMemoryStore

from helpers import FakeLLM, FakeSource, USER, local, snapshot

NOW = local(2026, 10, 21, 21, 0)


def scored(days, horizon=120, err=lambda d, i: 35.0, version="meal-aware-0.1+direct_120", per_day=36, start_hour=6, now=NOW, interval=0.8):
    """per_day forecasts per day from start_hour every 15 min; error = observed - predicted. Returns forecasts for the `days` days before now."""
    out = []
    for d in range(days, 0, -1):
        base = (now - timedelta(days=d)).replace(hour=start_hour, minute=0, second=0, microsecond=0)
        for i in range(per_day):
            a = base + timedelta(minutes=15 * i)
            pred = 120.0
            obs = pred + err(d, i)
            out.append(ScoredForecast(a, horizon, version, pred, obs, pred - 30, pred + 30, interval, "exact"))
    return out


def with_scored(rows):
    snap = snapshot(NOW, days=8)
    return dataclasses.replace(snap, scored=rows)


class Stats(unittest.TestCase):
    def test_sign_test_is_exact(self):
        self.assertAlmostEqual(EV.sign_test_p(10, 10), 2 / 1024)           # 2 * (1/2)^10
        self.assertAlmostEqual(EV.sign_test_p(5, 10), 1.0)
        self.assertEqual(EV.sign_test_p(0, 0), 1.0)
        self.assertAlmostEqual(EV.bonferroni(0.02, 4), 0.08)

    def test_default_levels(self):
        self.assertEqual(EV.default_level("meal_response"), EV.DESCRIPTIVE)
        self.assertEqual(EV.default_level("recurring_meal_response"), EV.REPEATED)
        self.assertEqual(set(EV.LEVELS), set(EV.CRITERIA))

    def test_grading_needs_blocks_and_material_size_and_consistency(self):
        few = [(float(i), 40.0) for i in range(5)]
        self.assertEqual(EV.grade_directional(few, 20, 1).level, EV.EXPLORATORY)
        small = [(float(i), 5.0) for i in range(20)]
        self.assertEqual(EV.grade_directional(small, 20, 1).level, EV.EXPLORATORY)             # consistent but not material
        mixed = [(float(i), 40.0 if i % 2 else -40.0) for i in range(20)]
        self.assertEqual(EV.grade_directional(mixed, 20, 1).level, EV.EXPLORATORY)             # 10 of 20: no direction
        solid = [(float(i), 40.0) for i in range(20)]
        self.assertEqual(EV.grade_directional(solid, 20, 1).level, EV.VALIDATED)
        fading = [(float(i), 40.0 if i < 12 else -2.0) for i in range(20)]                      # strong early, gone later: not validated
        self.assertNotEqual(EV.grade_directional(fading, 20, 1).level, EV.VALIDATED)

    def test_more_hypotheses_raise_the_bar(self):
        blocks = [(float(i), 40.0 if i < 9 else -40.0) for i in range(11)]                    # 9 of 11 same direction
        one = EV.grade_directional(blocks, 20, 1)
        many = EV.grade_directional(blocks, 20, 4)
        self.assertGreater(many.p_corrected, one.p_corrected)


class Detector(unittest.TestCase):
    def test_a_persistent_underestimate_is_reported_with_exact_numbers(self):
        cands, notes = PERF.evaluate(with_scored(scored(5)))
        self.assertEqual(len(cands), 1)
        c = cands[0]
        self.assertEqual(c.category, "forecast_performance")
        self.assertIn(c.evidence_level, (EV.VALIDATED, EV.REPEATED))
        f = {x.name: x.value for x in c.facts}
        self.assertEqual((f["horizon"], f["days"], f["median_difference"], f["interval_level"]), (120, 5, 35, 80))
        self.assertEqual(f["forecasts_matched"], 5 * 36)
        self.assertEqual(f["periods_same_direction"], f["comparison_periods"])
        text = " ".join(c.claims)
        self.assertIn("was lower than what was recorded", text)
        self.assertNotIn("because", text.lower())
        self.assertTrue(any("not independent" in l for l in c.limitations))
        # the interval contained 120+35 = 155 > upper 150 -> never inside
        self.assertEqual(f["interval_coverage"], 0)

    def test_overestimate_wording_and_safety_weight(self):
        c = PERF.forecast_performance(with_scored(scored(5, err=lambda d, i: -30.0)))
        self.assertIn("was higher than what was recorded", " ".join(c.claims))
        self.assertGreater(c.scores["safety"], 0.4)

    def test_noise_without_direction_is_not_reported(self):
        rng = random.Random(3)
        rows = scored(5, err=lambda d, i: rng.choice([-45.0, 45.0]))
        c, notes = PERF.evaluate(with_scored(rows))
        self.assertEqual(c, [])
        self.assertTrue(any("exploratory" in n for n in notes))

    def test_one_bad_forecast_or_one_bad_day_is_not_a_pattern(self):
        one_day = scored(5, err=lambda d, i: 60.0 if d == 3 else 0.0)
        self.assertEqual(PERF.evaluate(with_scored(one_day))[0], [])

    def test_too_little_data_is_not_judged(self):
        self.assertEqual(PERF.evaluate(with_scored(scored(2)))[0], [])                          # 2 days
        self.assertEqual(PERF.evaluate(with_scored(scored(5, per_day=4)))[0], [])               # 20 forecasts, below 30
        self.assertEqual(PERF.evaluate(with_scored([]))[0], [])

    def test_a_single_long_run_is_not_counted_as_many_independent_samples(self):
        rows = scored(1, per_day=200)                                                           # 200 forecasts, one day
        self.assertEqual(PERF.evaluate(with_scored(rows))[0], [])

    def test_only_the_live_model_version_is_judged_and_shadow_is_ignored(self):
        shadow = scored(5, version="meal-aware-0.3-shadow+direct_120")
        self.assertEqual(PERF.evaluate(with_scored(shadow))[0], [])
        old = scored(5, version="old")
        new = scored(1, version="new", now=NOW + timedelta(days=1))   # issued today, after the old version
        # the newest live version has 1 day only: the old version's evidence is not borrowed
        self.assertEqual(PERF.evaluate(with_scored(old + new))[0], [])

    def test_interpolated_matches_are_excluded(self):
        rows = [dataclasses.replace(r, match_quality="interpolated") for r in scored(5)]
        self.assertEqual(PERF.evaluate(with_scored(rows))[0], [])

    def test_no_future_data_is_used(self):
        late = scored(5)
        future = [ScoredForecast(NOW + timedelta(hours=1, minutes=5 * i), 120, late[0].model_version, 100, 300, 70, 130, 0.8, "exact") for i in range(60)]
        c, _ = PERF.evaluate(with_scored(late + future))
        self.assertEqual(len(c), 1)
        f = {x.name: x.value for x in c[0].facts}
        self.assertEqual((f["forecasts_matched"], f["median_difference"]), (5 * 36, 35))        # the 60 not-yet-resolved forecasts changed nothing

    def test_effect_below_the_material_size_is_suppressed(self):
        self.assertEqual(PERF.evaluate(with_scored(scored(5, err=lambda d, i: 8.0)))[0], [])    # needs >= 22 at 120 min

    def test_one_horizon_is_reported_even_when_several_qualify(self):
        rows = scored(5, horizon=60, err=lambda d, i: 30.0) + scored(5, horizon=120, err=lambda d, i: 45.0)
        c, _ = PERF.evaluate(with_scored(rows))
        self.assertEqual(len(c), 1)
        self.assertEqual({x.name: x.value for x in c[0].facts}["horizon"], 120)                 # the larger effect


class Pipeline(unittest.TestCase):
    def _go(self, rows, flag):
        snap = dataclasses.replace(snapshot(NOW, days=8), scored=rows)
        env = {"INSIGHTS_FORECAST_PERFORMANCE": "1"} if flag else {}
        with mock.patch.dict(os.environ, env, clear=False):
            if not flag:
                os.environ.pop("INSIGHTS_FORECAST_PERFORMANCE", None)
            return run("evening", USER, NOW, FakeSource(snap), InMemoryStore(), FakeLLM())

    def test_flag_off_means_no_performance_card(self):
        r = self._go(scored(5), flag=False)
        self.assertNotIn("forecast_performance", [i["category"] for i in r.insights])

    def test_flag_on_adds_the_card_with_its_level_and_a_validated_explanation(self):
        r = self._go(scored(5), flag=True)
        card = [i for i in r.insights if i["category"] == "forecast_performance"]
        self.assertEqual(len(card), 1)
        ev = card[0]["evidence"]
        self.assertIn(ev["level"], ("repeated", "validated"))
        self.assertTrue(ev["pattern_id"].startswith("forecast_bias:"))
        self.assertIn("level_criteria", ev)
        self.assertEqual(card[0]["content"]["headline"], "How your forecasts have been doing")
        self.assertEqual(card[0]["validation_status"], "not_applicable")            # fixed Python wording: the model never writes this card
        self.assertNotIn("of 180", card[0]["content"]["paragraph"])
        self.assertIn("In 15 of those periods", card[0]["content"]["paragraph"])

    def test_every_card_gets_a_level(self):
        r = self._go([], flag=True)
        self.assertTrue(r.insights)
        for i in r.insights:
            self.assertIn(i["evidence"]["level"], EV.LEVELS)


if __name__ == "__main__":
    unittest.main()
