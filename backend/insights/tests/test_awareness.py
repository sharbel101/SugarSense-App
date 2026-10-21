"""Insulin and carbohydrate still active, the heading-low card, frequent lows and wearable context. SYNTHETIC data only."""
import unittest
from datetime import timedelta

from sugarsense_insights import awareness as A
from sugarsense_insights.models import Insulin, Meal, Reading, WearableSample
from sugarsense_insights.pipeline import run
from sugarsense_insights.quality import clean_readings
from sugarsense_insights.store import InMemoryStore

from helpers import FakeLLM, FakeSource, USER, UTC, cgm, local, snapshot

NOW = local(2026, 10, 21, 15, 20)


def falling(now, start=140.0, drop=24.0, minutes=20):
    """Quiet readings for two days, then a fall of `drop` mg/dL over the last `minutes`."""
    base = [Reading(now - timedelta(minutes=m), 110.0) for m in range(30, 2 * 24 * 60, 5)]
    tail = [Reading(now - timedelta(minutes=m), start - drop * (minutes - m) / minutes) for m in range(minutes, -1, -5)]
    return sorted(base + tail, key=lambda r: r.t)


def snap_with(readings=None, insulin=None, meals=None, **kw):
    return snapshot(NOW, days=3, readings=readings or falling(NOW), insulin=insulin, meals=meals, **kw)


def cands(snap):
    clean, flags = clean_readings(snap.readings, snap.now, snap.settings.th)
    return A.heading_low(snap, clean, flags)


class OnBoard(unittest.TestCase):
    def test_straight_line_decay_and_unknown_when_nothing_is_logged(self):
        s = snap_with(insulin=[Insulin("i1", NOW - timedelta(hours=1), "bolus", 5.0, True), Insulin("i2", NOW - timedelta(hours=6), "bolus", 4.0, True),
                               Insulin("b", NOW - timedelta(hours=1), "basal", 20.0, True)],
                      meals=[Meal("m1", NOW - timedelta(minutes=90), "confirmed", 40.0)])
        self.assertEqual(A.insulin_on_board(s), 4.0)       # 5 u, 1 of 5 h gone; the 6 h old dose is over; basal is not counted
        self.assertEqual(A.carbs_on_board(s), 20.0)        # 40 g, 1.5 of 3 h gone
        e = snap_with()
        self.assertIsNone(A.insulin_on_board(e))           # no records = unknown, never zero
        self.assertIsNone(A.carbs_on_board(e))


class HeadingLow(unittest.TestCase):
    def test_falling_with_insulin_active_and_little_food_gives_a_python_only_card(self):
        s = snap_with(insulin=[Insulin("i1", NOW - timedelta(hours=1), "bolus", 4.0, True)], meals=[Meal("m1", NOW - timedelta(hours=3, minutes=30), "confirmed", 30.0)])
        out = cands(s)
        self.assertEqual(len(out), 1)
        c = out[0]
        self.assertTrue(c.python_only)
        self.assertEqual(c.ttl_min, 60)
        text = " ".join(c.claims)
        self.assertIn("small snack", text)
        self.assertIn("rough estimate", text)
        self.assertNotIn("will ", text)
        self.assertNotRegex(text, r"\d+\s*(?:u\b|units? of (?:insulin )?(?:more|less))")   # an estimate of what is active is allowed; no dose is ever given
        self.assertTrue(any(f.name == "insulin_still_active_estimate" and f.kind == "estimated" for f in c.facts))

    def test_stays_silent_without_the_ingredients(self):
        dose = [Insulin("i1", NOW - timedelta(hours=1), "bolus", 4.0, True)]
        self.assertEqual(cands(snap_with(insulin=None)), [])                                                        # no insulin records: unknown, no card
        self.assertEqual(cands(snap_with(insulin=dose, meals=[Meal("m1", NOW - timedelta(minutes=30), "confirmed", 60.0)])), [])   # plenty of food still to come
        self.assertEqual(cands(snap_with(insulin=[Insulin("i1", NOW - timedelta(hours=6), "bolus", 4.0, True)])), [])          # the dose is over
        flat = [Reading(NOW - timedelta(minutes=m), 110.0) for m in range(0, 400, 5)]
        self.assertEqual(cands(snap_with(readings=flat, insulin=dose)), [])                                        # not falling
        self.assertEqual(cands(snap_with(readings=falling(NOW, start=210.0, drop=30), insulin=dose)), [])        # far above range: normal after a meal
        self.assertEqual(cands(snap_with(readings=falling(NOW, start=95.0, drop=40), insulin=dose)), [])         # already below range: the alert system's job
        old = falling(NOW - timedelta(minutes=40))
        self.assertEqual(cands(snap_with(readings=old, insulin=dose)), [])                                         # stale reading

    def test_event_run_stores_it_with_a_short_expiry_and_never_asks_the_model_about_it(self):
        s = snap_with(insulin=[Insulin("i1", NOW - timedelta(hours=1), "bolus", 4.0, True)], meals=[Meal("m1", NOW - timedelta(hours=3, minutes=30), "confirmed", 30.0)])
        store, llm = InMemoryStore(), FakeLLM()
        r = run("event", USER, NOW, FakeSource(s), store, llm)
        card = [i for i in r.insights if i["category"] == "heading_low"]
        self.assertEqual(len(card), 1)
        c = card[0]
        self.assertEqual(c["content"]["source"], "rules")
        self.assertEqual(c["validation_status"], "not_applicable")
        self.assertEqual(c["expires_at"] - NOW, timedelta(minutes=60))
        self.assertTrue(all(p["category"] != "heading_low" for call in llm.calls for p in call["payloads"]))
        self.assertIn("snack", c["content"]["paragraph"])
        self.assertIn("estimate", c["content"]["safety"])


class FrequentLows(unittest.TestCase):
    def _lows(self, n_days):
        out = []
        for k in range(8):
            for m in range(0, 24 * 60, 5):
                t = NOW - timedelta(days=k) - timedelta(minutes=m)
                lt = t.astimezone(__import__("zoneinfo").ZoneInfo("Asia/Beirut"))
                low = k < n_days and 3 * 60 <= lt.hour * 60 + lt.minute <= 3 * 60 + 25
                out.append(Reading(t, 58.0 if low else 115.0))
        return sorted(out, key=lambda r: r.t)

    def test_three_lows_on_three_days_makes_a_card_with_the_time_block(self):
        s = snapshot(NOW, readings=self._lows(4))
        clean, flags = clean_readings(s.readings, s.now, s.settings.th)
        out = A.frequent_lows(s, clean, flags, NOW.date())
        self.assertEqual(len(out), 1)
        text = " ".join(out[0].claims)
        self.assertRegex(text, r"\b[34] separate stays below 70 mg/dL")
        self.assertIn("03:00 and 06:00", text)
        self.assertEqual(out[0].category, "frequent_lows")
        self.assertTrue(any(o.care_team for o in out[0].explanations + out[0].suggestions))

    def test_one_low_is_not_frequent(self):
        s = snapshot(NOW, readings=self._lows(1))
        clean, flags = clean_readings(s.readings, s.now, s.settings.th)
        self.assertEqual(A.frequent_lows(s, clean, flags, NOW.date()), [])


class WearableContext(unittest.TestCase):
    def test_only_what_exists_is_stated(self):
        s = snap_with(wearables=[WearableSample(NOW - timedelta(minutes=10 * k), "stress_level", 60.0 + k, "score_0_100", "garmin") for k in range(1, 12)]
                      + [WearableSample(NOW - timedelta(hours=7), "sleep_duration", 5.5 * 3600, "s", "garmin")])
        b = A._B()
        claims = A.wearable_context(s, NOW, b)
        text = " ".join(claims)
        self.assertIn("stress score averaged", text)
        self.assertIn("5.5 hours of sleep", text)
        self.assertNotIn("sleep score", text)
        self.assertEqual(A.wearable_context(snap_with(), NOW, A._B()), [])


if __name__ == "__main__":
    unittest.main()
