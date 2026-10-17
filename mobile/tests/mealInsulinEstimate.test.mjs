// Run: npm run test:estimate  (pure module)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateMealInsulin, MAX_ESTIMATE_UNITS, segmentAt } from '../src/services/mealInsulinEstimate.ts';

const at = (h, m = 0) => {
  const d = new Date(2026, 9, 17, h, m, 0, 0);
  return d;
};
const ratio = (...segs) => ({ status: 'set', icrSegments: segs.map(([startMinute, gramsPerUnit]) => ({ startMinute, gramsPerUnit })) });
const est = (over = {}) => estimateMealInsulin({ carbsG: 30, ratio: ratio([0, 3.75]), mealTime: at(12), latestGlucoseMgdl: 150, ...over });

test('the saved ratio is applied to the confirmed carbs (4 units per 15 g saved as 3.75 g per unit -> 30 g = 8 units)', () => {
  const r = est();
  assert.equal(r.kind, 'ok');
  assert.equal(r.units, 8);
  assert.equal(r.unitsText, '8');
  assert.equal(r.explanation, '30 g carbs ÷ 3.75 g per unit = 8 units');
});

test('different ratio and carbs: nothing is hardcoded', () => {
  const r = est({ carbsG: 45, ratio: ratio([0, 10]) });
  assert.equal(r.units, 4.5);
  assert.equal(r.explanation, '45 g carbs ÷ 10 g per unit = 4.5 units');
  assert.equal(est({ carbsG: 10, ratio: ratio([0, 10]) }).explanation, '10 g carbs ÷ 10 g per unit = 1 unit');
  assert.equal(est({ carbsG: 67.5, ratio: ratio([0, 12]) }).unitsText, '5.6');
});

test('time-of-day segments: the one in force at the meal time (local clock) is used', () => {
  const r = ratio([0, 12], [360, 8], [1080, 10]);
  assert.equal(est({ ratio: r, carbsG: 40, mealTime: at(5, 59) }).gramsPerUnit, 12);
  assert.equal(est({ ratio: r, carbsG: 40, mealTime: at(6, 0) }).gramsPerUnit, 8);
  assert.equal(est({ ratio: r, carbsG: 40, mealTime: at(12) }).units, 5);
  assert.equal(est({ ratio: r, carbsG: 40, mealTime: at(23, 59) }).gramsPerUnit, 10);
  assert.equal(est({ ratio: r, carbsG: 40, mealTime: at(12) }).segmentFrom, '06:00');
  assert.equal(segmentAt([{ startMinute: 60, gramsPerUnit: 5 }], 30), null, 'no segment before the first start');
});

test('missing, unreadable or invalid ratio is never replaced by a default', () => {
  assert.equal(est({ ratio: null }).kind, 'ratio_unavailable');
  assert.equal(est({ ratio: { status: 'not_set', icrSegments: [] } }).kind, 'ratio_not_set');
  assert.equal(est({ ratio: { status: 'set', icrSegments: [] } }).kind, 'ratio_not_set');
  assert.equal(est({ ratio: ratio([0, 0]) }).kind, 'ratio_invalid');
  assert.equal(est({ ratio: ratio([0, -4]) }).kind, 'ratio_invalid');
  assert.equal(est({ ratio: ratio([60, 10]), mealTime: at(0, 30) }).kind, 'ratio_invalid');
});

test('no carbs / nonsense carbs give no estimate', () => {
  assert.equal(est({ carbsG: 0 }).kind, 'no_carbs');
  assert.equal(est({ carbsG: -5 }).kind, 'no_carbs');
  assert.equal(est({ carbsG: Number.NaN }).kind, 'no_carbs');
});

test('a low glucose withholds the estimate; unknown glucose does not', () => {
  const low = est({ latestGlucoseMgdl: 62 });
  assert.equal(low.kind, 'low_glucose');
  assert.equal(low.glucoseMgdl, 62);
  assert.equal(est({ latestGlucoseMgdl: 70 }).kind, 'ok');
  assert.equal(est({ latestGlucoseMgdl: null }).kind, 'ok');
});

test('an estimate above the sanity ceiling is refused, not shown', () => {
  const r = est({ carbsG: 400, ratio: ratio([0, 5]) });
  assert.equal(r.kind, 'too_high');
  assert.ok(r.units > MAX_ESTIMATE_UNITS);
});

test('the estimate never reads a forecast, IOB or correction: its inputs are exactly carbs, ratio, time and low-glucose check', () => {
  const r1 = est({ carbsG: 50, ratio: ratio([0, 10]) });
  const r2 = estimateMealInsulin({ carbsG: 50, ratio: ratio([0, 10]), mealTime: at(12), latestGlucoseMgdl: 250, extra: { iob: 9, forecast: 400 } });
  assert.equal(r1.units, r2.units, 'a high glucose, IOB or forecast does not change the result');
});
