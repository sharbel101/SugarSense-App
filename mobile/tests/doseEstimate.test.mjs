// Run: npm run test:dose  (pure module)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateDose } from '../src/services/doseEstimate.ts';

const at = (h, m = 0) => new Date(2026, 9, 18, h, m, 0, 0);
const therapy = (icr = [[0, 10]], isf = [[0, 50]]) => ({
  status: 'set',
  icrSegments: icr.map(([startMinute, gramsPerUnit]) => ({ startMinute, gramsPerUnit })),
  isfSegments: isf.map(([startMinute, mgdlPerUnit]) => ({ startMinute, mgdlPerUnit })),
});
const glucose = (mgdl = 205, ageMinutes = 3, trendMgdlPerMin = 0.3) => ({ mgdl, ageMinutes, trendMgdlPerMin });
const est = (over = {}) =>
  estimateDose({ carbsG: 40, therapy: therapy(), targetMgdl: 120, glucose: glucose(), iobUnits: null, mealTime: at(12), now: at(12), ...over });

test('meal dose = carbs / ICR (the 4 units per 15 g example, saved as 3.75 g/U, gives 8 units for 30 g)', () => {
  const r = est({ carbsG: 30, therapy: therapy([[0, 3.75]]), targetMgdl: null });
  assert.equal(r.kind, 'ok');
  assert.equal(r.meal.units, 8);
  assert.equal(r.meal.explanation, '30 g ÷ 3.75 g per unit');
});

test('combined = meal + correction - IOB, built from the ROUNDED terms so the shown arithmetic adds up', () => {
  const r = est({ carbsG: 40, therapy: therapy([[0, 3.3]], [[0, 70]]), glucose: glucose(205), targetMgdl: 120, iobUnits: 3.04 });
  assert.equal(r.kind, 'ok');
  assert.equal(r.meal.units, 12.1); // 40 / 3.3 = 12.12
  assert.equal(r.correction.kind, 'included');
  assert.equal(r.correction.units, 1.2); // 85 / 70 = 1.214
  assert.equal(r.iob.units, 3);
  assert.equal(r.combined.units, 10.3); // 12.1 + 1.2 - 3.0, not 12.12 + 1.21 - 3.04
  assert.equal(r.combined.explanation, '12.1 + 1.2 − 3 = 10.3 units');
});

test('no correction at or below target; correction explains itself', () => {
  const below = est({ glucose: glucose(110) });
  assert.equal(below.correction.kind, 'none_needed');
  assert.equal(below.combined.units, below.meal.units);
  assert.equal(est({ glucose: glucose(120) }).correction.kind, 'none_needed');
  const r = est({ glucose: glucose(170), targetMgdl: 120, therapy: therapy([[0, 10]], [[0, 50]]) });
  assert.equal(r.correction.units, 1);
  assert.match(r.correction.explanation, /\(170 − 120\) ÷ 50 mg\/dL per unit/);
});

test('missing target, ISF, or glucose: the correction is excluded with a reason, never defaulted', () => {
  assert.equal(est({ targetMgdl: null }).correction.reason, 'no_target');
  assert.equal(est({ therapy: therapy([[0, 10]], []) }).correction.reason, 'no_isf');
  assert.equal(est({ glucose: null }).correction.reason, 'no_glucose');
  assert.equal(est({ glucose: glucose(205, 25) }).correction.reason, 'stale_glucose');
  // the meal dose is still given
  assert.equal(est({ targetMgdl: null }).combined.units, 4);
});

test('IOB: subtracted when known; unknown is stated, not silently 0; never below 0 total', () => {
  assert.equal(est({ iobUnits: null }).iob.kind, 'unknown');
  const sub = est({ iobUnits: 1.5, glucose: glucose(100) });
  assert.equal(sub.iob.kind, 'subtracted');
  assert.equal(sub.combined.units, 2.5);
  const big = est({ iobUnits: 9, glucose: glucose(100) });
  assert.equal(big.combined.units, 0);
  assert.ok(big.notes.some((n) => /more than this meal/.test(n)));
});

test('a low glucose withholds everything; a stale low reading does not block', () => {
  const low = est({ glucose: glucose(62) });
  assert.equal(low.kind, 'low_glucose');
  assert.equal(est({ glucose: glucose(62, 40) }).kind, 'ok');
});

test('time-of-day segments: ICR by the MEAL time, ISF by NOW', () => {
  const t = therapy([[0, 12], [360, 8]], [[0, 60], [720, 40]]);
  const r = est({ therapy: t, carbsG: 48, mealTime: at(7), now: at(13), glucose: glucose(200), targetMgdl: 120 });
  assert.equal(r.meal.gramsPerUnit, 8);
  assert.equal(r.meal.units, 6);
  assert.equal(r.correction.units, 2); // 80 / 40
});

test('settings problems: not set, unreadable, invalid ratio, no carbs', () => {
  assert.equal(est({ therapy: null }).kind, 'ratio_unavailable');
  assert.equal(est({ therapy: { status: 'not_set', icrSegments: [], isfSegments: [] } }).kind, 'ratio_not_set');
  assert.equal(est({ therapy: therapy([[0, 0]]) }).kind, 'ratio_invalid');
  assert.equal(est({ carbsG: 0 }).kind, 'no_carbs');
});

test('over the sanity ceiling is refused', () => {
  assert.equal(est({ carbsG: 400, therapy: therapy([[0, 5]]) }).kind, 'too_high');
});

test('trend and forecast never change the units; a fast fall only adds a note', () => {
  const steady = est({ glucose: glucose(205, 3, 0.2) });
  const falling = est({ glucose: glucose(205, 3, -3) });
  assert.equal(steady.combined.units, falling.combined.units);
  assert.ok(falling.notes.some((n) => /falling quickly/.test(n)));
  assert.equal(steady.notes.length, 0);
});
