import re
import unittest
from datetime import timedelta

from sugarsense_insights import patterns as P
from sugarsense_insights.config import Thresholds
from sugarsense_insights.models import ForecastPoint, Insulin, Meal, Reading, Sleep, Activity
from sugarsense_insights.quality import clean_readings

from helpers import UTC, breakfast_meals, cgm, local, snapshot, _g

MORNING = local(2026, 10, 21, 7, 30)
EVENING = local(2026, 10, 21, 21, 0)


def prep(snap):
    clean, flags = clean_readings(snap.readings, snap.now, snap.settings.th)
    return clean, flags


def all_refs_used(c):
    text = " ".join(c.claims)
    return all(f"{f.ref}" in re.findall(r"E\d+", text) for f in c.facts)


class Overnight(unittest.TestCase):
    def test_complete_night(self):
        snap = snapshot(MORNING, days=8)
        clean, flags = prep(snap)
        c = P.overnight_summary(snap, clean, flags, P.local_date(snap))
        self.assertIsNotNone(c)
        self.assertGreaterEqual(c.coverage, 0.9)
        self.assertTrue(all_refs_used(c))
        self.assertIn("There is no sleep record, so nothing is said about sleep quality.", c.limitations)
        self.assertFalse(any("sleep" in x.lower() for x in c.claims))

    def test_sparse_night_returns_nothing(self):
        r = [x for x in cgm(8, MORNING) if x.t.minute == 0 and x.t.hour % 2 == 0]   # one reading every 2 h
        snap = snapshot(MORNING, readings=r)
        clean, flags = prep(snap)
        self.assertIsNone(P.overnight_summary(snap, clean, flags, P.local_date(snap)))

    def test_night_with_low_has_top_safety_score(self):
        low = lambda lm: 55.0 if 2 * 60 <= lm <= 3 * 60 else _g(lm)
        snap = snapshot(MORNING, readings=cgm(8, MORNING, curve=low))
        clean, flags = prep(snap)
        c = P.overnight_summary(snap, clean, flags, P.local_date(snap))
        self.assertEqual(c.scores["safety"], 1.0)
        self.assertTrue(any("below range" in x for x in c.claims))

    def test_conflicting_readings_are_reported_as_limitation_and_excluded(self):
        base = cgm(8, MORNING)
        t = local(2026, 10, 21, 1, 0)
        bad = base + [Reading(t, 250.0), Reading(t, 90.0)]
        snap = snapshot(MORNING, readings=bad)
        clean, flags = prep(snap)
        c = P.overnight_summary(snap, clean, flags, P.local_date(snap))
        self.assertTrue(any("conflicting values" in l for l in c.limitations))
        self.assertNotIn("250", " ".join(c.claims))


class Recurring(unittest.TestCase):
    def test_morning_rise_needs_enough_days(self):
        long_ = snapshot(MORNING, days=9)
        short = snapshot(MORNING, days=4)
        for snap, expect in ((long_, True), (short, False)):
            clean, flags = prep(snap)
            c = P.morning_rise_recurring(snap, clean, P.local_date(snap))
            self.assertEqual(c is not None, expect)
        clean, _ = prep(long_)
        c = P.morning_rise_recurring(long_, clean, P.local_date(long_))
        self.assertIn("comparable mornings", c.claims[0]); self.assertEqual(c.direction, "rising")
        self.assertTrue(any("not a diagnosis" in l for l in c.limitations))

    def test_flat_glucose_has_no_pattern(self):
        snap = snapshot(MORNING, readings=cgm(9, MORNING, curve=lambda lm: 110.0))
        clean, _ = prep(snap)
        self.assertIsNone(P.morning_rise_recurring(snap, clean, P.local_date(snap)))

    def test_recurring_meal_response(self):
        snap = snapshot(EVENING, days=9, meals=breakfast_meals(EVENING, 9))
        clean, _ = prep(snap)
        c = P.meal_response_recurring(snap, clean, P.local_date(snap))
        self.assertIsNotNone(c); self.assertIn("breakfast", c.claims[0])
        short = snapshot(EVENING, days=3, meals=breakfast_meals(EVENING, 3))
        clean2, _ = prep(short)
        self.assertIsNone(P.meal_response_recurring(short, clean2, P.local_date(short)))


class Context(unittest.TestCase):
    def test_meal_response_with_estimated_carbs_and_no_insulin_limit(self):
        snap = snapshot(EVENING, days=3, meals=[Meal("m1", local(2026, 10, 21, 8, 30), "confirmed", 50.0, note="my usual")])
        clean, _ = prep(snap)
        cs = P.meal_responses(snap, clean, local(2026, 10, 21, 0, 0), EVENING, "evening")
        self.assertEqual(len(cs), 1)
        c = cs[0]
        self.assertIn("estimated carbohydrates", c.claims[0]); self.assertEqual(c.untrusted, ["my usual"])
        self.assertTrue(any("No insulin record" in l for l in c.limitations))

    def test_meal_without_carbs_or_unconfirmed_is_ignored(self):
        ms = [Meal("a", local(2026, 10, 21, 8, 30), "confirmed", None), Meal("b", local(2026, 10, 21, 8, 30), "draft", 40.0)]
        snap = snapshot(EVENING, days=3, meals=ms)
        clean, _ = prep(snap)
        self.assertEqual(P.meal_responses(snap, clean, local(2026, 10, 21, 0, 0), EVENING, "evening"), [])

    def test_meal_response_not_claimed_when_data_has_a_hole(self):
        hole = lambda t: local(2026, 10, 21, 9, 0) <= t <= local(2026, 10, 21, 11, 0)
        snap = snapshot(EVENING, readings=cgm(3, EVENING, skip=hole), meals=[Meal("m1", local(2026, 10, 21, 8, 30), "confirmed", 50.0)])
        clean, _ = prep(snap)
        self.assertEqual(P.meal_responses(snap, clean, local(2026, 10, 21, 0, 0), EVENING, "evening"), [])

    def test_previous_day_context_only_lists_recorded_events(self):
        snap = snapshot(MORNING, days=3, meals=[Meal("late", local(2026, 10, 20, 22, 15), "confirmed", 30.0)], insulin=[Insulin("i1", local(2026, 10, 20, 22, 20), "bolus", None, False)])
        c = P.previous_day_context(snap, P.local_date(snap))
        self.assertIsNotNone(c)
        self.assertTrue(any("no administered dose" in l for l in c.limitations))
        self.assertIsNone(P.previous_day_context(snapshot(MORNING, days=3), P.local_date(snap)))

    def test_no_forecast_means_no_forecast_candidate(self):
        snap = snapshot(MORNING, days=3)
        self.assertIsNone(P.forecast_outlook(snap, prep(snap)[0]))

    def test_forecast_bound_is_not_a_prediction(self):
        fc = [ForecastPoint(MORNING - timedelta(minutes=5), h, MORNING + timedelta(minutes=h - 5), 130.0, 62.0, 190.0, 0.8) for h in (30, 60, 120)]
        snap = snapshot(MORNING, days=3, forecast=fc)
        c = P.forecast_outlook(snap, prep(snap)[0])
        self.assertEqual(c.interval_level, 0.8)
        joined = " ".join(c.claims)
        self.assertIn("80% interval", joined)
        self.assertIn("a possible bound, not the predicted value", joined)

    def test_stale_forecast_is_not_current(self):
        fc = [ForecastPoint(MORNING - timedelta(hours=2), 60, MORNING - timedelta(hours=1), 130.0, 110.0, 150.0, 0.8)]
        snap = snapshot(MORNING, days=3, forecast=fc)
        self.assertIsNone(P.forecast_outlook(snap, prep(snap)[0]))


class Gated(unittest.TestCase):
    def test_exercise_association_needs_pairs(self):
        acts = [Activity(local(2026, 10, 20, 17, 0) - timedelta(days=k), "walk", 30.0, "light") for k in range(3)]
        snap = snapshot(EVENING, days=9, activities=acts)
        self.assertIsNone(P.exercise_association(snap, prep(snap)[0]))
        acts9 = [Activity(local(2026, 10, 20, 17, 0) - timedelta(days=k), "walk", 30.0, "light") for k in range(8)]
        snap9 = snapshot(EVENING, days=9, activities=acts9)
        self.assertIsNotNone(P.exercise_association(snap9, prep(snap9)[0]))

    def test_sleep_association_needs_pairs_and_correlation(self):
        def sl(k, hours):
            end = local(2026, 10, 20, 7, 0) - timedelta(days=k)
            return Sleep(end - timedelta(hours=hours), end, hours * 60.0, None)
        few = snapshot(MORNING, days=9, sleeps=[sl(k, 7) for k in range(3)])
        self.assertIsNone(P.sleep_association(few, prep(few)[0]))
        # constant sleep duration: no variance, so no correlation can be claimed
        const = snapshot(MORNING, days=9, sleeps=[sl(k, 7) for k in range(8)])
        self.assertIsNone(P.sleep_association(const, prep(const)[0]))

    def test_insulin_timing_not_claimed_without_enough_confirmed_pairs(self):
        snap = snapshot(EVENING, days=9, meals=breakfast_meals(EVENING, 9), insulin=[Insulin("i", local(2026, 10, 21, 8, 25), "bolus", 4.0, True)])
        self.assertIsNone(P.insulin_timing_association(snap, prep(snap)[0]))


class Excursions(unittest.TestCase):
    def test_high_excursion_reported_lows_are_not_event_insights(self):
        snap = snapshot(EVENING, days=2)
        clean, flags = prep(snap)
        highs = P.excursion_candidates(snap, clean, flags, EVENING - timedelta(hours=3), EVENING, "event")
        self.assertTrue(highs and all(c.category == "glucose_excursion" for c in highs))
        lowc = lambda lm: 55.0 if 19 * 60 <= lm <= 20 * 60 else _g(lm)
        s2 = snapshot(EVENING, readings=cgm(2, EVENING, curve=lowc))
        c2, f2 = prep(s2)
        for c in P.excursion_candidates(s2, c2, f2, EVENING - timedelta(hours=3), EVENING, "event"):
            self.assertNotIn("below", " ".join(c.claims))


if __name__ == "__main__":
    unittest.main()
