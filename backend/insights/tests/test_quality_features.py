import unittest
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from sugarsense_insights import features as F
from sugarsense_insights.config import Thresholds, thresholds_for
from sugarsense_insights.models import Reading
from sugarsense_insights.quality import assess, clean_readings, coverage, freshness

from helpers import UTC, local, snapshot

TH = Thresholds()
NOW = datetime(2026, 10, 21, 12, 0, tzinfo=UTC)


def rs(values, start=NOW - timedelta(hours=2), step=5):
    return [Reading(start + timedelta(minutes=i * step), v) for i, v in enumerate(values)]


class Quality(unittest.TestCase):
    def test_conflicting_duplicates_excluded_and_flagged(self):
        a = rs([100, 110, 120])
        bad = a + [Reading(a[1].t, 212.0)]
        clean, flags = clean_readings(bad, NOW, TH)
        self.assertEqual([r.mgdl for r in clean], [100, 120])
        self.assertEqual([f.code for f in flags], ["conflicting_duplicates"])

    def test_exact_duplicate_kept_once_without_flag(self):
        a = rs([100, 110])
        clean, flags = clean_readings(a + [a[1]], NOW, TH)
        self.assertEqual(len(clean), 2); self.assertEqual(flags, [])

    def test_implausible_values_dropped(self):
        clean, flags = clean_readings(rs([100, 10, 700, 105]), NOW, TH)
        self.assertEqual([r.mgdl for r in clean], [100, 105])
        self.assertEqual(sorted(f.code for f in flags), ["implausible_value"] * 2)

    def test_isolated_spike_removed(self):
        clean, flags = clean_readings(rs([100, 110, 250, 112, 115]), NOW, TH)
        self.assertNotIn(250, [r.mgdl for r in clean])
        self.assertIn("implausible_spike", [f.code for f in flags])

    def test_sustained_jump_kept_but_flagged(self):
        clean, flags = clean_readings(rs([100, 100, 200, 200, 200]), NOW, TH)
        self.assertEqual(len(clean), 5)
        self.assertIn("rapid_change", [f.code for f in flags])

    def test_future_timestamp_dropped(self):
        clean, flags = clean_readings(rs([100]) + [Reading(NOW + timedelta(hours=2), 120)], NOW, TH)
        self.assertEqual(len(clean), 1); self.assertEqual(flags[0].code, "future_timestamp")

    def test_coverage_and_gaps(self):
        r = rs([100] * 12, start=NOW - timedelta(hours=1))            # a reading every 5 min for 1 h
        self.assertGreater(coverage(r, NOW - timedelta(hours=1), NOW, TH), 0.95)
        self.assertLess(coverage(r, NOW - timedelta(hours=3), NOW, TH), 0.45)   # only 1 of 3 hours covered
        self.assertEqual(coverage([], NOW - timedelta(hours=1), NOW, TH), 0.0)

    def test_freshness(self):
        self.assertEqual(freshness([], NOW, TH)[0], "none")
        self.assertEqual(freshness([Reading(NOW - timedelta(minutes=10), 100)], NOW, TH)[0], "current")
        self.assertEqual(freshness([Reading(NOW - timedelta(minutes=45), 100)], NOW, TH)[0], "stale")

    def test_assess_missing_sources_independent(self):
        snap = snapshot(NOW, days=8)
        clean, flags = clean_readings(snap.readings, NOW, TH)
        av = assess(snap, clean, flags)
        self.assertTrue(av["glucose"].ok and av["glucose_current"].ok and av["history"].ok)
        for k in ("meals", "insulin", "activity", "sleep", "wearable", "forecast"):
            self.assertFalse(av[k].ok, k)

    def test_assess_short_history_not_recurring(self):
        snap = snapshot(NOW, days=3)
        clean, flags = clean_readings(snap.readings, NOW, TH)
        self.assertFalse(assess(snap, clean, flags)["history"].ok)

    def test_per_user_threshold_overrides_validated(self):
        t = thresholds_for({"insights": {"high_mgdl": 160, "wake": "06:30", "recap": "25:99", "low_mgdl": "x"}})
        self.assertEqual((t.high_mgdl, t.wake, t.recap, t.low_mgdl), (160.0, "06:30", "21:00", 70.0))
        t2 = thresholds_for({"insights": {"low_mgdl": 120, "high_mgdl": 120}})   # not low < high: both ignored
        self.assertEqual((t2.low_mgdl, t2.high_mgdl), (70.0, 180.0))


class Features(unittest.TestCase):
    def test_time_in_range_time_weighted(self):
        r = rs([200] * 13, start=NOW - timedelta(hours=1))
        rng = F.time_in_range(r, NOW - timedelta(hours=1), NOW, TH)
        self.assertAlmostEqual(rng.pct_above, 100.0)
        r2 = rs([60, 60, 120, 120, 200, 200], start=NOW - timedelta(minutes=30))
        rng2 = F.time_in_range(r2, NOW - timedelta(minutes=30), NOW, TH)
        self.assertAlmostEqual(rng2.pct_below, 100 * 10 / 30)
        self.assertAlmostEqual(rng2.pct_in, 100 * 10 / 30)

    def test_stats(self):
        s = F.stats(rs([100, 120, 140]))
        self.assertEqual((s.n, s.minimum, s.maximum, round(s.mean)), (3, 100, 140, 120))
        self.assertIsNone(F.stats(rs([100])))

    def test_excursions_min_duration_and_gap_split(self):
        r = rs([150, 200, 210, 220, 215, 150], step=10)      # above for 30 min
        ex = F.excursions(r, r[0].t, r[-1].t, TH)
        self.assertEqual(len(ex), 1); self.assertEqual(ex[0].kind, "above"); self.assertEqual(ex[0].extreme_mgdl, 220)
        short = rs([150, 200, 150], step=10)
        self.assertEqual(F.excursions(short, short[0].t, short[-1].t, TH), [])
        gap = [Reading(NOW, 200), Reading(NOW + timedelta(minutes=10), 200), Reading(NOW + timedelta(hours=2), 200), Reading(NOW + timedelta(hours=2, minutes=10), 200)]
        self.assertEqual(F.excursions(gap, NOW, NOW + timedelta(hours=3), TH), [])   # each stay is 10 min: gap must not merge them

    def test_overnight_window_dst_fallback(self):
        z = ZoneInfo("America/New_York")
        s, e = F.overnight_window(datetime(2026, 11, 1).date(), TH, z)     # DST ends 2026-11-01: that night is 10 hours long
        self.assertEqual((e - s).total_seconds() / 3600, 10)

    def test_change_between_and_rise(self):
        r = rs([100, 110, 130, 150], step=30)
        self.assertEqual(F.change_between(r, r[0].t, r[-1].t), 50)
        self.assertIsNone(F.change_between(r, r[0].t - timedelta(hours=5), r[-1].t))
        res = F.rise_between(r, r[0].t, r[1].t, r[2].t, r[3].t)
        self.assertEqual(res[0], 150 - 100)


if __name__ == "__main__":
    unittest.main()
