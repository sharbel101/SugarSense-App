"""Research-informed detectors. SYNTHETIC data only. Every expected number is derived from the way the series is built (see the comments)."""
import dataclasses
import unittest
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from sugarsense_insights import research as RS
from sugarsense_insights.config import Thresholds
from sugarsense_insights.models import Activity, Insulin, Meal, Reading
from sugarsense_insights.pipeline import run
from sugarsense_insights.quality import clean_readings
from sugarsense_insights.store import InMemoryStore

from helpers import FakeLLM, FakeSource, TZ, USER, UTC, local, snapshot

Z = ZoneInfo(TZ)
NOW = local(2026, 10, 21, 21, 30)
TODAY = NOW.astimezone(Z).date()


def series(days, fn, now=NOW):
    """5-minute readings for `days` days back; fn(local datetime) -> mg/dL or None (a gap)."""
    out, t = [], (now - timedelta(days=days)).replace(second=0, microsecond=0)
    t -= timedelta(minutes=t.minute % 5)
    while t <= now:
        v = fn(t.astimezone(Z))
        if v is not None:
            out.append(Reading(t, float(v)))
        t += timedelta(minutes=5)
    return out


def snap_of(readings, **kw):
    s = snapshot(NOW, readings=readings, **kw)
    return s


def clean_of(s):
    return clean_readings(s.readings, s.now, s.settings.th)[0]


def facts(c):
    return {f.name: f.value for f in c.facts}


def day_index(t):   # 0 = today, 1 = yesterday ...
    return (TODAY - t.date()).days


class TimeWindow(unittest.TestCase):
    def test_a_recurring_afternoon_high_is_reported_with_days_range_and_duration(self):
        # high (215) 15:00-18:00 on 6 of the 7 completed days (not on day 4), 110 otherwise
        fn = lambda t: 215 if (15 <= t.hour < 18 and day_index(t) != 4) else 110
        s = snap_of(series(8, fn))
        c = RS.time_window_high(s, clean_of(s), TODAY)
        self.assertIsNotNone(c)
        f = facts(c)
        self.assertEqual(f["window"], "15:00-18:00")
        self.assertGreaterEqual(f["days_above_in_window"], 5)
        self.assertEqual(f["median_minutes_above"], 180)     # whole 3 h window above range, to the reading resolution (+-5)
        self.assertEqual((f["typical_low"], f["typical_high"]), (215, 215))
        self.assertIn(c.evidence_level, ("repeated", "validated"))
        self.assertIn("days", c.detail)
        self.assertNotRegex(" ".join(c.claims).lower(), r"because|caused|due to|as a result")

    def test_two_days_are_not_a_pattern(self):
        fn = lambda t: 215 if (15 <= t.hour < 18 and day_index(t) in (1, 2)) else 110
        s = snap_of(series(8, fn))
        self.assertIsNone(RS.time_window_high(s, clean_of(s), TODAY))

    def test_always_high_is_not_a_time_of_day_pattern(self):
        s = snap_of(series(8, lambda t: 215))
        self.assertIsNone(RS.time_window_high(s, clean_of(s), TODAY))

    def test_days_without_enough_readings_are_not_counted(self):
        fn = lambda t: None if (15 <= t.hour < 18 and day_index(t) in (1, 2, 3, 4, 5)) else (215 if 15 <= t.hour < 18 else 110)
        s = snap_of(series(8, fn))
        self.assertIsNone(RS.time_window_high(s, clean_of(s), TODAY))   # only 2 eligible days remain


class Hypo(unittest.TestCase):
    def lows(self, days):
        return lambda t: 62 if (t.hour == 2 and day_index(t) in days and t.minute < 30) else 120

    def test_repeated_lows_with_timing_severity_and_no_invented_links(self):
        s = snap_of(series(10, self.lows({2, 4, 6})))
        c = RS.hypo_pattern(s, clean_of(s), TODAY)
        f = facts(c)
        self.assertEqual((f["lows_count"], f["low_days"], f["lowest"]), (3, 3, 62))
        self.assertEqual(f["lows_in_window"], 3)
        text = " ".join(c.claims) + " ".join(c.limitations)
        self.assertIn("No activity records exist", text)         # no activity data -> no exercise claim
        self.assertIn("No insulin doses are recorded", text)
        self.assertNotIn("followed a recorded activity", text)
        self.assertEqual(c.scores["safety"], 1.0)
        self.assertEqual(c.evidence_level, "repeated")

    def test_one_low_is_not_reported_here(self):
        s = snap_of(series(10, self.lows({3})))
        self.assertIsNone(RS.hypo_pattern(s, clean_of(s), TODAY))

    def test_exercise_and_insulin_associations_are_counted_from_records_only(self):
        acts = [Activity(local(2026, 10, 21 - d, 18, 0).replace(), "run", 40.0, None, "garmin") for d in (3, 5)]   # the evening before the lows at 02:00 of days 2 and 4
        ins = [Insulin("i1", local(2026, 10, 18, 23, 30), "bolus", 4.0, True)]
        s = snap_of(series(10, self.lows({2, 4, 6})), activities=acts, insulin=ins)
        c = RS.hypo_pattern(s, clean_of(s), TODAY)
        f = facts(c)
        self.assertEqual(f["lows_after_exercise_record"], 2)
        self.assertEqual(f["lows_after_insulin_record"], 1)
        self.assertIn("cannot establish the cause", " ".join(c.limitations))


class Overnight(unittest.TestCase):
    def test_dawn_rise_needs_repetition_and_skips_mornings_with_a_logged_meal(self):
        def fn(t):
            if day_index(t) in (1, 2, 3, 4, 5, 6) and 3 <= t.hour < 8:
                return 100 + (60 if t.hour >= 6 else 0)        # 100 -> 160 after 06:00 = +60
            return 105
        meals = [Meal("m1", local(2026, 10, 21 - 5, 5, 30), "confirmed", 30.0)]    # a meal before the 06:00 peak on day 5
        s = snap_of(series(9, fn), meals=meals)
        out = RS.overnight_patterns(s, clean_of(s), TODAY)
        dawn = [c for c in out if c.key == "dawn_rise"]
        self.assertEqual(len(dawn), 1)
        f = facts(dawn[0])
        self.assertEqual((f["mornings_with_rise"], f["median_rise"]), (5, 60))
        self.assertTrue(any("left out" in l for l in dawn[0].limitations))
        self.assertNotIn("dawn phenomenon", " ".join(dawn[0].claims).lower())

    def test_two_mornings_are_not_a_dawn_pattern(self):
        fn = lambda t: (160 if t.hour >= 6 else 100) if (day_index(t) in (1, 2) and 3 <= t.hour < 8) else 105
        s = snap_of(series(9, fn))
        self.assertEqual([c for c in RS.overnight_patterns(s, clean_of(s), TODAY) if c.key == "dawn_rise"], [])

    def test_overnight_lows_need_at_least_two_nights(self):
        fn = lambda t: 60 if (day_index(t) in (2, 5) and t.hour == 3) else 110
        s = snap_of(series(9, fn))
        c = [x for x in RS.overnight_patterns(s, clean_of(s), TODAY) if x.key == "overnight_low"]
        self.assertEqual(facts(c[0])["nights_with_low"], 2)
        fn1 = lambda t: 60 if (day_index(t) == 2 and t.hour == 3) else 110
        s1 = snap_of(series(9, fn1))
        self.assertEqual([x for x in RS.overnight_patterns(s1, clean_of(s1), TODAY) if x.key == "overnight_low"], [])


class Variability(unittest.TestCase):
    def test_a_change_in_variability_is_reported_only_with_two_well_covered_periods(self):
        def fn(t):
            i = day_index(t)
            if i <= 14:
                return 140 + (60 if (t.hour // 3) % 2 else -40)     # swinging: CV ~ 25%
            return 140 + (6 if (t.hour // 3) % 2 else -6)           # flat: CV ~ 4%
        s = snap_of(series(29, fn))
        c = RS.variability_change(s, clean_of(s), TODAY)
        self.assertIsNotNone(c)
        f = facts(c)
        self.assertGreater(f["cv_recent"], f["cv_previous"] + 5)
        self.assertIn("less consistent", " ".join(c.claims))
        self.assertEqual(c.evidence_level, "repeated")
        short = snap_of(series(9, fn))
        self.assertIsNone(RS.variability_change(short, clean_of(short), TODAY))   # no previous period -> nothing

    def test_no_change_no_card(self):
        s = snap_of(series(29, lambda t: 140 + (30 if (t.hour // 3) % 2 else -30)))
        self.assertIsNone(RS.variability_change(s, clean_of(s), TODAY))


class Baseline(unittest.TestCase):
    def test_recent_evening_shift_is_found_in_the_right_window(self):
        fn = lambda t: 120 + (40 if (day_index(t) <= 7 and 19 <= t.hour < 22) else 0)
        s = snap_of(series(22, fn))
        c = RS.baseline_shift(s, clean_of(s), TODAY)
        self.assertIsNotNone(c)
        f = facts(c)
        self.assertAlmostEqual(f["difference"], 40, delta=15)    # the 3-hour block that holds most of the evening rise
        self.assertIn("higher", " ".join(c.claims))

    def test_a_small_shift_or_too_few_prior_days_is_silent(self):
        s = snap_of(series(22, lambda t: 120 + (10 if day_index(t) <= 7 else 0)))
        self.assertIsNone(RS.baseline_shift(s, clean_of(s), TODAY))
        short = snap_of(series(9, lambda t: 120 + (60 if day_index(t) <= 7 else 0)))
        self.assertIsNone(RS.baseline_shift(short, clean_of(short), TODAY))


def meal_curve(meals, rise):
    """glucose 110, plus `rise` ramping linearly over 60 min after each meal then flat 60 min and back down by 150 min."""
    def fn(t):
        v = 110.0
        for m in meals:
            dt = (t.astimezone(UTC) - m).total_seconds() / 60
            if 0 <= dt <= 60: v += rise * dt / 60
            elif 60 < dt <= 120: v += rise
            elif 120 < dt <= 180: v += rise * (180 - dt) / 60
        return v
    return fn


class PostMeal(unittest.TestCase):
    def setUp(self):
        self.times = [local(2026, 10, 21 - d, 12, 0) for d in range(1, 8)]
        self.meals = [Meal(f"m{i}", t, "confirmed", 45.0, fat_g=10.0) for i, t in enumerate(self.times)]

    def test_comparable_meals_give_a_median_rise_and_count(self):
        s = snap_of(series(9, meal_curve(self.times, 70)), meals=self.meals)
        c = RS.post_meal_pattern(s, clean_of(s), TODAY)
        self.assertIsNotNone(c)
        f = facts(c)
        self.assertEqual(f["comparable_meals"], 7)
        self.assertEqual(f["meals_with_rise"], 7)
        self.assertAlmostEqual(f["median_rise_90min"], 70, delta=6)
        self.assertEqual(f["meals_with_insulin_record"], 0)
        self.assertEqual((f["carb_band_low"], f["carb_band_high"]), (30, 60))
        self.assertTrue(all("carbs_g" in m for m in c.detail["meals"]))
        self.assertNotRegex(" ".join(c.claims).lower(), r"because|caused")

    def test_too_few_meals_or_small_rises_are_silent(self):
        s = snap_of(series(9, meal_curve(self.times, 70)), meals=self.meals[:3])
        self.assertIsNone(RS.post_meal_pattern(s, clean_of(s), TODAY))
        s2 = snap_of(series(9, meal_curve(self.times, 15)), meals=self.meals)
        self.assertIsNone(RS.post_meal_pattern(s2, clean_of(s2), TODAY))

    def test_unknown_carbohydrate_is_not_a_comparable_meal(self):
        meals = [dataclasses.replace(m, carbs_g=None) for m in self.meals]
        s = snap_of(series(9, meal_curve(self.times, 70)), meals=meals)
        self.assertIsNone(RS.post_meal_pattern(s, clean_of(s), TODAY))

    def test_insulin_records_are_counted_not_assumed(self):
        ins = [Insulin(f"i{i}", t, "bolus", 4.0, True) for i, t in enumerate(self.times[:3])]
        s = snap_of(series(9, meal_curve(self.times, 70)), meals=self.meals, insulin=ins)
        self.assertEqual(facts(RS.post_meal_pattern(s, clean_of(s), TODAY))["meals_with_insulin_record"], 3)


class InsulinFalls(unittest.TestCase):
    def test_repeated_falls_after_doses_without_a_logged_meal(self):
        times = [local(2026, 10, 21 - d, 15, 0) for d in (1, 2, 3, 5)]
        def fn(t):
            v = 150.0
            for m in times:
                dt = (t.astimezone(UTC) - m).total_seconds() / 60
                if 0 <= dt <= 120: v -= 70 * dt / 120
                elif 120 < dt <= 240: v -= 70 * (240 - dt) / 120
            return v
        ins = [Insulin(f"i{i}", t, "correction", 3.0, True) for i, t in enumerate(times)]
        s = snap_of(series(9, fn), insulin=ins)
        c = RS.insulin_fall_pattern(s, clean_of(s), TODAY)
        self.assertIsNotNone(c)
        f = facts(c)
        self.assertEqual((f["doses_followed_by_fall"], f["median_fall"]), (4, 70))
        text = " ".join(c.claims)
        self.assertIn("cannot establish", text)
        self.assertNotRegex(text.lower(), r"too (large|big)|reduce your|lower your dose")

    def test_a_logged_meal_nearby_explains_the_fall_and_the_dose_is_left_out(self):
        times = [local(2026, 10, 21 - d, 15, 0) for d in (1, 2, 3, 5)]
        fn = lambda t: 150.0 - (70 if any(0 <= (t.astimezone(UTC) - m).total_seconds() / 60 <= 120 for m in times) else 0)
        ins = [Insulin(f"i{i}", t, "bolus", 3.0, True) for i, t in enumerate(times)]
        meals = [Meal(f"m{i}", t, "confirmed", 40.0) for i, t in enumerate(times)]
        s = snap_of(series(9, fn), insulin=ins, meals=meals)
        self.assertIsNone(RS.insulin_fall_pattern(s, clean_of(s), TODAY))


class Completeness(unittest.TestCase):
    def test_meals_without_insulin_records_make_the_insulin_record_look_incomplete_without_claiming_nothing_was_taken(self):
        meals = [Meal(f"m{i}", NOW - timedelta(hours=3 * (i + 1)), "confirmed", 40.0) for i in range(3)]
        s = snap_of(series(3, lambda t: 120), meals=meals)
        c = RS.insulin_record_gap(s, clean_of(s), TODAY)
        self.assertEqual(facts(c)["meals_without_insulin_record"], 3)
        self.assertIn("missing information", " ".join(c.limitations))
        self.assertEqual(c.category, "data_completeness")

    def test_complete_records_are_silent(self):
        meals = [Meal(f"m{i}", NOW - timedelta(hours=3 * (i + 1)), "confirmed", 40.0) for i in range(3)]
        ins = [Insulin(f"i{i}", m.t, "bolus", 4.0, True) for i, m in enumerate(meals)]
        s = snap_of(series(3, lambda t: 120), meals=meals, insulin=ins)
        self.assertIsNone(RS.insulin_record_gap(s, clean_of(s), TODAY))


class Reconcile(unittest.TestCase):
    def test_a_richer_card_replaces_the_older_card_for_the_same_finding_but_not_a_lows_block(self):
        from sugarsense_insights.models import Candidate, Fact
        def cand(cat, facts_=()):
            return Candidate(key=cat, category=cat, trigger="evening", window=(NOW, NOW), facts=list(facts_), claims=[], boundaries=[], limitations=[], coverage=1, method="")
        tw, old_above = cand("time_window_high"), cand("episode_time_pattern", [Fact("E1", "days_with_stay_above", 4, "count")])
        old_both = cand("episode_time_pattern", [Fact("E1", "days_with_stay_above", 4, "count"), Fact("E2", "days_with_stay_below", 3, "count")])
        self.assertEqual([c.category for c in RS.reconcile([tw, old_above])], ["time_window_high"])
        self.assertEqual(len(RS.reconcile([tw, old_both])), 2)       # its low-glucose part is not covered by the new card
        self.assertEqual([c.category for c in RS.reconcile([cand("hypo_pattern"), cand("frequent_lows")])], ["hypo_pattern"])


class StayDuplicates(unittest.TestCase):
    def test_a_context_card_retires_the_plain_excursion_card_of_the_same_stay_but_not_of_another_stay(self):
        store = InMemoryStore()
        rid = store.claim_run(USER, "k", "event", NOW, "e", "p", None)[0]
        rec = lambda cat, key: {"category": cat, "trigger": "event", "dedupe_key": key, "facts_hash": key, "content_version": 1, "priority": 1, "validation_status": "valid", "created_at": NOW, "expires_at": NOW + timedelta(hours=6), "evidence": {}, "content": {}, "observation_start": NOW, "observation_end": NOW}
        a = store.save_insight(USER, rid, rec("glucose_excursion", "excursion:20261023T0921"))
        other = store.save_insight(USER, rid, rec("glucose_excursion", "excursion:20261023T0600"))
        keep = store.save_insight(USER, rid, rec("episode_context", "episode_ctx:above:20261023T0921"))
        self.assertEqual(store.expire_stay_duplicates(USER, "20261023T0921", ("glucose_excursion",), keep, NOW), 1)
        active = {i["insight_id"] for i in store.active(USER, NOW)}
        self.assertEqual(active, {other, keep})


class PipelineIntegration(unittest.TestCase):
    def _afternoon_high_snapshot(self):
        fn = lambda t: 215 if (15 <= t.hour < 18 and day_index(t) != 4) else 110
        return snapshot(NOW, readings=series(9, fn))

    def test_the_card_goes_through_the_model_and_validator_and_carries_level_status_and_details(self):
        snap = self._afternoon_high_snapshot()
        store = InMemoryStore()
        r = run("evening", USER, NOW, FakeSource(snap), store, FakeLLM())
        cards = [i for i in r.insights if i["category"] == "time_window_high"]
        self.assertEqual(len(cards), 1)
        c = cards[0]
        self.assertEqual(c["content"]["headline"], "Glucose is often high between 15:00 and 18:00")
        self.assertIn(c["evidence"]["level"], ("repeated", "validated"))
        self.assertEqual(c["evidence"]["detail"]["status"], "new")
        self.assertTrue(c["evidence"]["detail"]["days"])
        self.assertIn("level_criteria", c["evidence"])
        self.assertNotIn("episode_time_pattern", [i["category"] for i in r.insights])

    def test_a_second_run_does_not_duplicate_and_the_newest_card_of_a_singleton_type_retires_the_old_one(self):
        snap = self._afternoon_high_snapshot()
        store = InMemoryStore()
        run("evening", USER, NOW, FakeSource(snap), store, FakeLLM())
        later = NOW + timedelta(hours=1)
        snap2 = dataclasses.replace(snap, now=later, readings=snap.readings)
        run("event", USER, later, FakeSource(snap2), store, FakeLLM())
        active = [i["category"] for i in store.active(USER, later)]
        self.assertEqual(active.count("time_window_high"), 1)

    def test_no_evidence_no_card(self):
        snap = snapshot(NOW, readings=series(9, lambda t: 120))
        r = run("evening", USER, NOW, FakeSource(snap), InMemoryStore(), FakeLLM())
        self.assertFalse({"time_window_high", "hypo_pattern", "post_meal_pattern", "variability_change", "baseline_shift", "insulin_fall_pattern"} & {i["category"] for i in r.insights})


if __name__ == "__main__":
    unittest.main()
