// Run: npm run test:wearablemodel
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ageText, availableRanges, baselineOf, buildBars, buildLine, DAY, freshnessOf, HOUR, METRICS, nearestByX, statusOf, trendText, windowOf,
} from '../src/services/wearableModel.ts';
import { buildDemoData, getWearableData } from '../src/services/wearableData.ts';

const NOW = Date.parse('2026-10-21T14:00:00');
const day = (n, v) => ({ t: NOW - n * DAY, v });
const daily = (vals) => vals.map((v, i) => day(vals.length - 1 - i, v));

test('freshness comes from the measurement time: fresh, delayed, stale, none', () => {
  assert.equal(freshnessOf(NOW - 4 * 60_000, NOW, 'instant').state, 'fresh');
  assert.match(freshnessOf(NOW - 4 * 60_000, NOW, 'instant').text, /^Measured \d{1,2}:\d{2} (AM|PM) \(4 min ago\)$/);
  const d = freshnessOf(NOW - 2 * HOUR, NOW, 'instant');
  assert.equal(d.state, 'delayed');
  assert.match(d.text, /^Data delayed/);
  assert.equal(freshnessOf(NOW - 5 * HOUR, NOW, 'instant').state, 'stale');
  assert.equal(freshnessOf(null, NOW, 'instant').state, 'none');
  assert.equal(freshnessOf(NOW - 20 * HOUR, NOW, 'daily').state, 'fresh');
  assert.equal(freshnessOf(NOW - 3 * DAY, NOW, 'daily').state, 'stale');
  assert.equal(ageText(0.2), 'just now');
  assert.equal(ageText(180), '3 h ago');
  assert.equal(ageText(60 * 72), '3 d ago');
});

test('baseline needs 7 prior days; the latest value is excluded; none until then', () => {
  assert.equal(baselineOf(daily([48, 50, 47, 49, 51, 48]), NOW), null, 'only 5 prior days');
  const vals = [48, 50, 47, 49, 51, 48, 50, 46, 52, 49, 49];
  const b = baselineOf(daily(vals), NOW);
  assert.ok(b);
  assert.equal(b.n, 10);
  assert.ok(b.low < b.median && b.median < b.high);
  // a huge latest value does not move its own baseline
  const b2 = baselineOf(daily([...vals.slice(0, -1), 500]), NOW);
  assert.equal(b2.median, b.median);
  assert.equal(baselineOf(undefined, NOW), null);
});

test('status: building without a baseline, within / above / below with one, none without a value', () => {
  const b = { low: 40, high: 56, median: 48, n: 10 };
  assert.equal(statusOf(48, b), 'within');
  assert.equal(statusOf(60, b), 'above');
  assert.equal(statusOf(30, b), 'below');
  assert.equal(statusOf(48, null), 'building');
  assert.equal(statusOf(null, b), 'none');
});

test('trend text is computed from the baseline, and absent without one', () => {
  const b = { low: 40, high: 56, median: 50, n: 10 };
  assert.equal(trendText(54, b, METRICS.hrv), 'About 8% above your usual (50 ms).');
  assert.equal(trendText(45, b, METRICS.hrv), 'About 10% below your usual (50 ms).');
  assert.equal(trendText(50, b, METRICS.hrv), 'About the same as your usual (50 ms).');
  assert.equal(trendText(54, null, METRICS.hrv), null);
});

test('ranges: instant metrics offer day only with enough spread; daily metrics need enough days', () => {
  const hr = Array.from({ length: 50 }, (_, i) => ({ t: NOW - 4 * HOUR + i * 5 * 60_000, v: 60 }));
  assert.deepEqual(availableRanges(METRICS.heartRate, hr, NOW), ['day']);
  assert.deepEqual(availableRanges(METRICS.heartRate, hr.slice(0, 3), NOW), []);
  assert.deepEqual(availableRanges(METRICS.hrv, daily([1, 2]), NOW), []);
  assert.deepEqual(availableRanges(METRICS.hrv, daily([1, 2, 3, 4]), NOW), ['week']);
  assert.deepEqual(availableRanges(METRICS.hrv, daily(Array.from({ length: 12 }, () => 5)), NOW), ['week', 'month']);
  assert.equal(windowOf(daily([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 'week', NOW).length, 8, 'now and the 7 days before it');
});

test('line geometry breaks at gaps: no line across missing time, lone points kept', () => {
  const s = [
    { t: 0, v: 60 }, { t: 5 * 60_000, v: 62 }, { t: 10 * 60_000, v: 61 },
    { t: 3 * HOUR, v: 70 },
    { t: 5 * HOUR, v: 65 }, { t: 5 * HOUR + 5 * 60_000, v: 66 },
  ];
  const g = buildLine(s, { t0: 0, t1: 6 * HOUR, w: 300, h: 100 }, 30 * 60_000, null);
  assert.equal(g.segments.length, 2, 'two connected runs');
  assert.equal(g.singles.length, 1, 'the lone reading is a dot, not a line');
  assert.equal(g.points.length, 6);
  assert.ok(g.points.every((p) => p.x >= 0 && p.x <= 300 && p.y >= 0 && p.y <= 100));
  assert.equal(g.band, null);
});

test('line geometry: baseline band is inside the chart; flat data does not divide by zero', () => {
  const flat = buildLine([{ t: 0, v: 50 }, { t: 10, v: 50 }], { t0: 0, t1: 10, w: 100, h: 50 }, 100, { low: 45, high: 55, median: 50, n: 9 });
  assert.ok(flat.band && flat.band.y1 < flat.band.y2);
  const f2 = buildLine([{ t: 0, v: 50 }, { t: 10, v: 50 }], { t0: 0, t1: 10, w: 100, h: 50 }, 100, null);
  assert.ok(f2.points.every((p) => Number.isFinite(p.y)));
  assert.deepEqual(buildLine([], { t0: 0, t1: 10, w: 100, h: 50 }, 5).points, []);
});

test('bars: a slot with no sample has no bar (unknown is not zero)', () => {
  const s = [{ t: 0, v: 100 }, { t: 2 * HOUR, v: 50 }];
  const { bars, slots } = buildBars(s, { t0: 0, t1: 4 * HOUR, w: 400, h: 100 }, HOUR);
  assert.equal(slots, 4);
  assert.equal(bars.length, 2);
  assert.ok(bars[0].h > bars[1].h);
});

test('nearestByX picks the closest item', () => {
  assert.equal(nearestByX([{ x: 0 }, { x: 10 }, { x: 20 }], 13), 1);
  assert.equal(nearestByX([], 5), -1);
});

test('demo data is flagged, deterministic, has no device, and never zero-fills', () => {
  const a = getWearableData(NOW);
  const b = buildDemoData(NOW);
  assert.equal(a.isDemo, true);
  assert.equal(a.device, null);
  assert.deepEqual(a.series.hrv, b.series.hrv, 'deterministic');
  const days = a.series.hrv.map((s) => Math.round((NOW - s.t) / DAY));
  assert.ok(days.length < 30, 'missing days are absent, not filled');
  const hr = a.series.heartRate;
  assert.ok(hr.length > 200);
  let maxGap = 0;
  for (let i = 1; i < hr.length; i++) maxGap = Math.max(maxGap, hr[i].t - hr[i - 1].t);
  assert.ok(maxGap > 30 * 60_000, 'the demo contains a real gap so the gap handling is exercised');
  assert.ok(baselineOf(a.series.hrv, NOW), 'enough history for a baseline');
});

test('summaryOf: status only for daily metrics with a baseline; heart rate and steps get none; freshness from the sample time', async () => {
  const { summaryOf, hasGap, minMax } = await import('../src/services/wearableModel.ts');
  const d = getWearableData(NOW);
  const hrv = summaryOf(d, 'hrv', NOW);
  assert.ok(hrv.baseline);
  assert.ok(['within', 'above', 'below'].includes(hrv.status));
  assert.equal(summaryOf(d, 'heartRate', NOW).status, 'none');
  assert.equal(summaryOf(d, 'steps', NOW).status, 'none');
  assert.equal(summaryOf(d, 'heartRate', NOW).freshness.state, 'fresh');
  const none = summaryOf({ ...d, series: {} }, 'hrv', NOW);
  assert.equal(none.latest, null);
  assert.equal(none.status, 'none');
  assert.equal(none.freshness.state, 'none');
  assert.equal(hasGap(d.series.heartRate, 30 * 60_000), true);
  assert.deepEqual(minMax([{ t: 0, v: 2 }, { t: 1, v: 4 }]), { min: 2, max: 4, mean: 3 });
  assert.equal(minMax([]), null);
});

test('usual gauge: the usual range is the middle third; zone says below / within / above, never good or bad', async () => {
  const { usualGauge, stressBand } = await import('../src/services/wearableModel.ts');
  const b = { low: 40, high: 56, median: 48, n: 10 };
  const mid = usualGauge(48, b);
  assert.ok(Math.abs(mid.fraction - 0.5) < 1e-9);
  assert.ok(Math.abs(mid.usualFrom - 1 / 3) < 1e-9 && Math.abs(mid.usualTo - 2 / 3) < 1e-9);
  assert.equal(mid.zone, 'within');
  assert.equal(usualGauge(70, b).zone, 'above');
  assert.equal(usualGauge(20, b).zone, 'below');
  assert.equal(usualGauge(1000, b).fraction, 1, 'clamped');
  assert.equal(usualGauge(-1000, b).fraction, 0);
  assert.equal(stressBand(10).label, 'Rest');
  assert.equal(stressBand(25).label, 'Rest');
  assert.equal(stressBand(26).label, 'Low');
  assert.equal(stressBand(60).label, 'Medium');
  assert.equal(stressBand(99).label, 'High');
});
