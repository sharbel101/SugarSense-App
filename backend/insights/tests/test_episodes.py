import json
import unittest
from datetime import timedelta

from sugarsense_insights import episodes as E
from sugarsense_insights.config import Thresholds, thresholds_for
from sugarsense_insights.llm import candidate_payload
from sugarsense_insights.models import Activity, Insulin, Meal
from sugarsense_insights.pipeline import build_candidates, run
from sugarsense_insights.quality import assess, clean_readings
from sugarsense_insights.store import InMemoryStore
from sugarsense_insights import features as F

from helpers import FakeLLM, FakeSource, USER, UTC, cgm, local, snapshot, _g

MORNING = local(2026, 10, 21, 7, 30)
EVENING = local(2026, 10, 21, 21, 0)


def prep(snap):
    return clean_readings(snap.readings, snap.now, snap.settings.th)


def day(snap, d=None):
    from sugarsense_insights.patterns import local_date
    return d or local_date(snap)


class GlucoseOnly(unittest.TestCase):
    """The architecture must work with a couple of metrics: here, only glucose."""

    def test_evening_with_glucose_only_gives_a_couple_of_insights(self):
        snap = snapshot(EVENING, days=9)
        r = run("evening", USER, EVENING, FakeSource(snap), InMemoryStore(), FakeLLM(), persist=False)
        cats = [i["category"] for i in r.insights]
        self.assertGreaterEqual(len(cats), 2, cats)
        self.assertIn("episode_digest", cats); self.assertIn("episode_time_pattern", cats)
        self.assertNotIn("episode_context", cats)                  # no meals/insulin/activity: no link is invented
        self.assertTrue(all(i["validation_status"] == "valid" for i in r.insights))
        text = json.dumps([i["content"] for i in r.insights]).lower()
        for banned in ("meal", "insulin", "sleep", "heart rate"):
            self.assertNotIn(banned, text)

    def test_morning_with_glucose_only_gives_a_couple_of_insights(self):
        snap = snapshot(MORNING, days=9)
        r = run("morning", USER, MORNING, FakeSource(snap), InMemoryStore(), FakeLLM(), persist=False)
        cats = [i["category"] for i in r.insights]
        self.assertGreaterEqual(len(cats), 2, cats)
        self.assertEqual(cats.count("episode_digest"), 2)          # last night and yesterday
        self.assertNotIn("overnight_summary", cats)                # whole-window statistics are not part of the default mode

    def test_model_payload_contains_only_episode_claims_not_raw_readings(self):
        snap = snapshot(EVENING, days=9)
        clean, flags = prep(snap)
        cands, _ = build_candidates("evening", snap, clean, flags, assess(snap, clean, flags))
        digest = next(c for c in cands if c.category == "episode_digest")
        p = candidate_payload(digest, "I1")
        self.assertEqual(set(p), {"insight_id", "category", "claims", "refs", "boundaries", "limitations"})
        self.assertLess(len(json.dumps(p)), 1800)
        self.assertNotRegex(json.dumps(p), r"readings\"?: ?\[")


class Digest(unittest.TestCase):
    def test_no_episode_is_reported_as_such_and_states_what_is_unknown(self):
        snap = snapshot(EVENING, readings=cgm(3, EVENING, curve=lambda lm: 120.0))
        clean, flags = prep(snap)
        s, e = F.day_bounds(day(snap), __import__("zoneinfo").ZoneInfo("Asia/Beirut"))
        c = E.episode_digest(snap, clean, flags, s, e, "Today so far", "k", "evening")
        self.assertIn("no stay outside 70-180 mg/dL", c.claims[0])
        self.assertTrue(any("not assumed in range" in l for l in c.limitations))
        self.assertLess(c.scores["safety"], 0.2)

    def test_highs_and_lows_counted_and_worst_values_reported(self):
        curve = lambda lm: 55.0 if 3 * 60 <= lm <= 4 * 60 else _g(lm)
        snap = snapshot(EVENING, readings=cgm(3, EVENING, curve=curve))
        clean, flags = prep(snap)
        s, e = F.day_bounds(day(snap), __import__("zoneinfo").ZoneInfo("Asia/Beirut"))
        c = E.episode_digest(snap, clean, flags, s, e, "Today so far", "k", "evening")
        joined = " ".join(c.claims)
        self.assertIn("below 70 mg/dL", joined); self.assertIn("The lowest stay reached 55 mg/dL", joined)
        self.assertIn("Covered time outside these stays was in range", joined)
        self.assertTrue(any("not a safety alert" in b for b in c.boundaries))
        self.assertEqual(c.scores["safety"], 1.0)

    def test_too_little_coverage_gives_nothing(self):
        r = [x for x in cgm(3, EVENING) if x.t.hour in (9, 10)]          # two hours of a day
        snap = snapshot(EVENING, readings=r)
        clean, flags = prep(snap)
        s, e = F.day_bounds(day(snap), __import__("zoneinfo").ZoneInfo("Asia/Beirut"))
        self.assertIsNone(E.episode_digest(snap, clean, flags, s, e, "Today so far", "k", "evening"))

    def test_uncovered_time_is_not_counted_as_in_range(self):
        hole = lambda t: local(2026, 10, 21, 12, 0) <= t <= local(2026, 10, 21, 15, 30)
        snap = snapshot(EVENING, readings=cgm(3, EVENING, skip=hole))
        clean, flags = prep(snap)
        s, e = F.day_bounds(day(snap), __import__("zoneinfo").ZoneInfo("Asia/Beirut"))
        c = E.episode_digest(snap, clean, flags, s, e, "Today so far", "k", "evening")
        cov = next(f.value for f in c.facts if f.name == "coverage")
        self.assertLess(cov, 90)
        self.assertIn(f"readings covered {cov}% of the time", c.claims[0])


class TimePattern(unittest.TestCase):
    def test_needs_three_days_and_is_worded_as_observation(self):
        few = snapshot(EVENING, days=2)
        self.assertIsNone(E.episode_time_pattern(few, prep(few)[0], day(few), "evening"))
        many = snapshot(EVENING, days=6)
        c = E.episode_time_pattern(many, prep(many)[0], day(many), "evening")
        self.assertIsNotNone(c)
        self.assertRegex(c.claims[0], r"A stay above range began between \d\d:00 and \d\d:00 on \d+ of \d+ days")
        self.assertTrue(any("not an established pattern" in l for l in c.limitations))
        self.assertTrue(any("Do not name a cause" in b for b in c.boundaries))

    def test_flat_glucose_has_no_time_pattern(self):
        snap = snapshot(EVENING, readings=cgm(6, EVENING, curve=lambda lm: 120.0))
        self.assertIsNone(E.episode_time_pattern(snap, prep(snap)[0], day(snap), "evening"))


class Context(unittest.TestCase):
    def snap_with(self, **kw):
        return snapshot(EVENING, days=3, **kw)

    def ctx(self, snap):
        clean, flags = prep(snap)
        s, e = F.day_bounds(day(snap), __import__("zoneinfo").ZoneInfo("Asia/Beirut"))
        return E.episode_context(snap, clean, flags, s, e, "evening")

    def test_glucose_only_has_no_context_candidates(self):
        self.assertEqual(self.ctx(self.snap_with()), [])

    def test_meals_only_mentions_meals_and_says_the_other_sources_do_not_exist(self):
        cs = self.ctx(self.snap_with(meals=[Meal("m", local(2026, 10, 21, 8, 30), "confirmed", 45.0)]))
        self.assertTrue(cs)
        c = cs[0]
        self.assertIn("a meal logged", c.claims[0]); self.assertIn("estimated carbohydrates", c.claims[0])
        self.assertIn("No insulin records exist, so no link to insulin is described.", c.limitations)
        self.assertIn("No activity records exist, so no link to activity is described.", c.limitations)
        self.assertNotIn("insulin record(s)", c.claims[0])

    def test_source_with_records_but_none_near_the_episode_says_so(self):
        far = [Insulin("i", local(2026, 10, 20, 3, 0), "bolus", 3.0, True)]
        cs = self.ctx(self.snap_with(meals=[Meal("m", local(2026, 10, 21, 8, 30), "confirmed", 45.0)], insulin=far))
        joined = " ".join(c.claims[0] for c in cs)
        self.assertIn("no insulin record", joined)

    def test_all_three_sources_listed_and_framed_as_records_not_cause(self):
        snap = self.snap_with(meals=[Meal("m", local(2026, 10, 21, 8, 30), "confirmed", 45.0)], insulin=[Insulin("i", local(2026, 10, 21, 8, 20), "bolus", 4.0, True)],
                              activities=[Activity(local(2026, 10, 21, 7, 0), "walk", 20.0, "light")])
        c = self.ctx(snap)[0]
        self.assertIn("insulin record(s)", c.claims[0]); self.assertIn("activity record(s)", c.claims[0])
        self.assertIn("a list of records, not a cause", c.claims[0])
        self.assertNotIn("units", c.claims[0].lower())             # no insulin dose size is stated


class Mode(unittest.TestCase):
    def test_default_is_episode_mode_and_profile_can_switch(self):
        self.assertEqual(Thresholds().insight_mode, "episodes")
        self.assertEqual(thresholds_for({"insights": {"mode": "full"}}).insight_mode, "full")
        self.assertEqual(thresholds_for({"insights": {"mode": "bogus"}}).insight_mode, "episodes")

    def test_episode_candidates_have_every_fact_cited(self):
        import re
        snap = snapshot(EVENING, days=6, meals=[Meal("m", local(2026, 10, 21, 8, 30), "confirmed", 45.0)])
        clean, flags = prep(snap)
        cands, _ = build_candidates("evening", snap, clean, flags, assess(snap, clean, flags))
        for c in cands:
            self.assertEqual({f.ref for f in c.facts} - set(re.findall(r"E\d+", " ".join(c.claims))), set(), c.category)


if __name__ == "__main__":
    unittest.main()
