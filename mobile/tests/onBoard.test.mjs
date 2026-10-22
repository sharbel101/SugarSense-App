// Run: npm run test:onboard  - carbs / insulin on board after a save: newest forecast wins, unknown is never 0.
process.env.TZ = 'Asia/Beirut';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseForecastResponse } from '../src/api/forecastContract.ts';
import { applyForecastResponse, deriveForecastView, INITIAL_FORECAST_STATE, reduceForecast } from '../src/services/forecastState.ts';
import { formatCarbsOnBoard, formatInsulinOnBoard } from '../src/services/forecastView.ts';
import { deserializeLastKnown, EMPTY_LAST_KNOWN, markEntrySaved, mergeOnBoard, serializeLastKnown } from '../src/services/lastKnown.ts';
import { buildMealEvent, buildNoInsulinEvent, resolveEventTime } from '../src/services/events.ts';

const T = Date.parse('2026-10-21T18:00:00Z');
const iso = (m) => new Date(T + m * 60_000).toISOString();

/** A forecast for the SAME glucose reading (anchor T) built at `genMin` minutes after T. */
function forecast(genMin, avail) {
  const points = [];
  for (let i = 1; i <= 36; i++) {
    const m = i * 5;
    points.push({ minutes: m, time: iso(m), baseline: m > 120 ? null : 130, adjusted: 130, low: 110, high: 150, extension: m > 120 });
  }
  return {
    status: 'ok',
    anchor: { measuredAt: iso(0), glucoseMgdl: 130, ageMinutes: 2 },
    generatedAt: iso(genMin), horizonMin: 180, stepMin: 5, intervalLevel: 0.8, points,
    mealAware: {
      changedForecast: true, counterfactual: false, excludedMealIds: [], events: [],
      availability: { mealsUsed: 0, mealsRangeOnly: 0, mealsNotUsed: 0, insulin: 'none_recorded', insulinDosesUsed: 0, insulinDosesRangeOnly: 0, insulinOnBoardUnits: null, carbsOnBoardGrams: null, therapySettings: 'available', ...avail },
    },
    models: { baseline: 'g', eventLayer: 'l' }, saved: true, notes: ['n'], disclaimer: 'Not medical advice.',
  };
}
const A = () => parseForecastResponse(forecast(1, { carbsOnBoardGrams: 0, insulinOnBoardUnits: null }));
const B = () => parseForecastResponse(forecast(3, { mealsUsed: 1, carbsOnBoardGrams: 28, insulin: 'confirmed_none', insulinOnBoardUnits: 0 }));
const lkOf = (f) => {
  const a = f.mealAware.availability;
  return { insulinUnits: a.insulinOnBoardUnits, insulin: a.insulin, carbsGrams: a.carbsOnBoardGrams, generatedAt: f.generatedAt };
};

test('last known: forecast A (no meal) then B (meal logged), SAME glucose anchor: B wins', () => {
  assert.equal(A().anchor.measuredAt, B().anchor.measuredAt, 'same reading');
  let lk = mergeOnBoard(EMPTY_LAST_KNOWN, lkOf(A()));
  assert.equal(lk.onBoard.carbsGrams, 0);
  lk = mergeOnBoard(lk, lkOf(B()));
  assert.equal(lk.onBoard.carbsGrams, 28, 'B carbs on board, not the stale pre-meal 0');
  assert.equal(lk.onBoard.insulinUnits, 0);
  assert.equal(lk.onBoard.insulin, 'confirmed_none');
  assert.equal(formatCarbsOnBoard({ carbsOnBoardGrams: lk.onBoard.carbsGrams }).value, '28 g');
  assert.equal(formatInsulinOnBoard({ insulinOnBoardUnits: lk.onBoard.insulinUnits, insulin: lk.onBoard.insulin }).value, '0.0 U');
});

test('last known: a strictly OLDER forecast never replaces a newer one; the same generatedAt does', () => {
  const lk = mergeOnBoard(EMPTY_LAST_KNOWN, lkOf(B()));
  assert.equal(mergeOnBoard(lk, lkOf(A())), lk, 'older loses');
  const same = mergeOnBoard(lk, { ...lkOf(B()), carbsGrams: 30 });
  assert.equal(same.onBoard.carbsGrams, 30);
});

test('after a save the remembered amounts are marked out of date until a newer forecast lands', () => {
  let lk = mergeOnBoard(EMPTY_LAST_KNOWN, lkOf(A()));
  lk = markEntrySaved(lk);
  assert.equal(lk.newEntrySinceForecast, true);
  lk = mergeOnBoard(lk, lkOf(B()));
  assert.equal(lk.newEntrySinceForecast, false);
  assert.equal(JSON.parse(serializeLastKnown(markEntrySaved(lk))).newEntrySinceForecast, undefined, 'the flag is not saved to disk');
});

test('an old saved copy (field named asOf) is still read, and then replaced by a newer forecast', () => {
  const old = JSON.stringify({ glucose: null, onBoard: { insulinUnits: null, insulin: 'none_recorded', carbsGrams: 0, asOf: iso(1) } });
  const lk = deserializeLastKnown(old);
  assert.equal(lk.onBoard.generatedAt, iso(1));
  assert.equal(mergeOnBoard(lk, lkOf(B())).onBoard.carbsGrams, 28);
});

test('forecast state: a poll that started before a save and landed after it does not replace the newer forecast', () => {
  let s = reduceForecast(INITIAL_FORECAST_STATE, { kind: 'response', response: A() }, 1000);
  s = applyForecastResponse(s, B(), 2000); // the save response
  assert.equal(deriveForecastView(s, 2000).data.mealAware.availability.carbsOnBoardGrams, 28);
  s = reduceForecast(s, { kind: 'response', response: A() }, 3000); // late, older poll
  assert.equal(deriveForecastView(s, 3000).data.mealAware.availability.carbsOnBoardGrams, 28, 'still the newer answer');
  assert.equal(deriveForecastView(s, 3000).data.generatedAt, iso(3));
});

test('meal then dose: three saves applied in order end on the last response, even if a copy of the middle one lands late', () => {
  const m = parseForecastResponse(forecast(3, { mealsUsed: 1, carbsOnBoardGrams: 28 }));
  const none = parseForecastResponse(forecast(4, { mealsUsed: 1, carbsOnBoardGrams: 27, insulin: 'confirmed_none', insulinOnBoardUnits: 0 }));
  const dose = parseForecastResponse(forecast(5, { mealsUsed: 1, carbsOnBoardGrams: 26, insulin: 'logged', insulinOnBoardUnits: 3.2, insulinDosesUsed: 1 }));
  let s = INITIAL_FORECAST_STATE;
  for (const f of [m, none, dose]) s = applyForecastResponse(s, f, 1000);
  s = applyForecastResponse(s, none, 2000);
  const a = deriveForecastView(s, 2000).data.mealAware.availability;
  assert.deepEqual([a.carbsOnBoardGrams, a.insulinOnBoardUnits, a.insulin], [26, 3.2, 'logged']);
});

test('stale / baseline_unavailable are never turned into 0 g: unknown stays unknown', () => {
  const s = reduceForecast(INITIAL_FORECAST_STATE, { kind: 'response', response: B() }, 1000);
  const stale = parseForecastResponse({ status: 'stale', reason: 'old' });
  const base = parseForecastResponse({ status: 'baseline_unavailable', anchor: { measuredAt: iso(0), glucoseMgdl: 130, ageMinutes: 2 }, reason: 'r', notes: [], disclaimer: 'd' });
  assert.equal(deriveForecastView(applyForecastResponse(s, stale, 2000), 2000).kind, 'stale', 'drops the held numbers');
  const view = deriveForecastView(applyForecastResponse(s, base, 2000), 2000);
  assert.equal(view.kind, 'baseline_unavailable');
  assert.equal('mealAware' in view.data, false, 'no on-board numbers exist on such a response');
  assert.deepEqual(formatCarbsOnBoard({ carbsOnBoardGrams: null }), { label: 'Carbs on board', value: 'none logged', caption: 'from your entries', known: false });
  assert.equal(formatInsulinOnBoard({ insulinOnBoardUnits: 0, insulin: 'none_recorded' }).value, 'unknown', 'a 0 U with nothing logged is unknown');
  assert.equal(formatCarbsOnBoard({ carbsOnBoardGrams: 0 }).value, '0 g', 'a real 0 from the server is shown as 0');
});

test('time picker: 30 min ago is sent as exactly 30 minutes before the moment of saving; the 0 U entry has the meal time', () => {
  const now = new Date('2026-10-21T18:30:00.000Z');
  const r = resolveEventTime({ mode: 'minutesAgo', minutes: 30 }, now);
  assert.equal(r.utcIso, '2026-10-21T18:00:00.000Z');
  assert.equal(resolveEventTime({ mode: 'minutesAgo', minutes: 0 }, now).utcIso, now.toISOString(), 'Now is the default chip');
  const none = buildNoInsulinEvent('i', { occurredAtUtc: r.utcIso, utcOffsetMin: r.utcOffsetMin, mealId: null });
  assert.equal(none.occurredAtUtc, r.utcIso, 'the 0 U entry is at the meal time');
  assert.equal(none.unitsAdministered, 0);
});
