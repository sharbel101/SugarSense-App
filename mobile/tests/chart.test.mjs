// Run: npm run test:chart  (pure modules)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { monotonePath, polylinePath } from '../src/services/chartPath.ts';
import { buildHistoryChart, HISTORY_PAD_X } from '../src/services/glucoseChart.ts';
import { parseGlucoseResponse } from '../src/api/glucoseContract.ts';

const T0 = Date.parse('2026-10-18T00:00:00Z');
const iso = (m) => new Date(T0 + m * 60000).toISOString();

function data(over = {}) {
  const history = [];
  for (let m = -60; m < 0; m += 5) history.push({ time: iso(m), value: 180 + Math.round(10 * Math.sin(m / 9)) });
  return parseGlucoseResponse({
    status: 'ok', glucoseMgdl: 190, measuredAt: iso(0), ageMinutes: 2, history, predictions: [], forecastAvailable: false,
    forecastUnavailableReason: null, low: { alert: false, alreadyLow: false, headline: null }, high: { alert: false, alreadyHigh: false, headline: null },
    ranges: null, rangesAreShadow: true, modelVersion: 'v', generatedAt: iso(0), trendMgdlPerMin: 0.4, ...over,
  });
}

test('history chart spreads the readings over the whole width, latest at the right edge', () => {
  const m = buildHistoryChart(data());
  assert.equal(m.actual[0].x, HISTORY_PAD_X);
  assert.equal(m.actual[m.actual.length - 1].x, m.viewBoxWidth - HISTORY_PAD_X, 'a little room so the dot is not clipped');
  assert.equal(m.nowX, m.viewBoxWidth - HISTORY_PAD_X);
  assert.ok(m.actual.every((p, i) => i === 0 || p.x > m.actual[i - 1].x), 'x strictly increasing');
  assert.deepEqual(m.xTicks.map((t) => t.label), ['-60m', 'Latest']);
});

test('one scrub point per reading with minutes-ago (negative) and real values; nothing invented', () => {
  const d = data();
  const m = buildHistoryChart(d);
  assert.equal(m.scrubPoints.length, d.history.length + 1);
  assert.equal(m.scrubPoints[m.scrubPoints.length - 1].minutesAhead, 0);
  assert.equal(m.scrubPoints[m.scrubPoints.length - 1].value, 190);
  assert.equal(m.scrubPoints[0].minutesAhead, -60);
  assert.deepEqual(m.scrubPoints.map((p) => p.value).slice(0, d.history.length), d.history.map((p) => p.value));
});

test('with no history only the latest point exists (no line is invented)', () => {
  const m = buildHistoryChart(data({ history: [] }));
  assert.equal(m.scrubPoints.length, 1);
});

test('y domain contains every reading', () => {
  const m = buildHistoryChart(data({ glucoseMgdl: 320 }));
  for (const p of m.actual) assert.ok(p.y >= 0 && p.y <= m.viewBoxHeight);
});

test('monotone path passes through every point and never overshoots', () => {
  const pts = [{ x: 0, y: 100 }, { x: 10, y: 100 }, { x: 20, y: 40 }, { x: 30, y: 45 }, { x: 40, y: 200 }];
  const d = monotonePath(pts);
  assert.match(d, /^M0 100 C/);
  assert.equal((d.match(/C/g) ?? []).length, pts.length - 1);
  assert.ok(d.endsWith('40 200'));
  // every control point's y stays within the y-range of the segment it belongs to
  const nums = [...d.matchAll(/C([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+)/g)].map((m) => m.slice(1).map(Number));
  nums.forEach((seg, i) => {
    const lo = Math.min(pts[i].y, pts[i + 1].y);
    const hi = Math.max(pts[i].y, pts[i + 1].y);
    assert.ok(seg[1] >= lo - 0.01 && seg[1] <= hi + 0.01, `segment ${i} c1y`);
    assert.ok(seg[3] >= lo - 0.01 && seg[3] <= hi + 0.01, `segment ${i} c2y`);
  });
});

test('short or non-increasing input falls back to straight lines', () => {
  assert.equal(monotonePath([{ x: 0, y: 1 }, { x: 5, y: 2 }]), 'M0 1 L5 2');
  assert.match(monotonePath([{ x: 0, y: 1 }, { x: 5, y: 2 }, { x: 5, y: 3 }]), /^M0 1 L5 2 L5 3$/);
  assert.equal(polylinePath([]), '');
});
