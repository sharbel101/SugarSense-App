import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseForecastResponse } from '../src/api/forecastContract.ts';
import { parseGlucoseResponse } from '../src/api/glucoseContract.ts';
import { buildOnBoardChart, describeOnBoardChart, nearestOnBoardPoint } from '../src/services/onBoardChart.ts';

const T0 = Date.parse('2026-10-18T12:00:00Z');
const iso = (m) => new Date(T0 + m * 60000).toISOString();

const availability = (over = {}) => ({
  mealsUsed: 1, mealsRangeOnly: 0, mealsNotUsed: 0, insulin: 'logged', insulinDosesUsed: 1, insulinDosesRangeOnly: 0,
  insulinOnBoardUnits: 12, carbsOnBoardGrams: 40, therapySettings: 'available', ...over,
});

function forecastBody({ iob = (m) => 12 * Math.exp(-m / 60), cob = (m) => 40 * Math.exp(-m / 45), av = {} } = {}) {
  const points = [];
  for (let i = 1; i <= 36; i++) {
    const m = i * 5;
    const p = { minutes: m, time: iso(m), baseline: m > 120 ? null : 130, adjusted: 130 - m / 6, low: 100 - m / 6, high: 160 - m / 6, extension: m > 120 };
    const a = iob(m);
    const b = cob(m);
    if (a !== undefined) p.insulinOnBoardUnits = a;
    if (b !== undefined) p.carbsOnBoardGrams = b;
    points.push(p);
  }
  return {
    status: 'ok', anchor: { measuredAt: iso(0), glucoseMgdl: 130, ageMinutes: 2 }, generatedAt: iso(1), horizonMin: 180, stepMin: 5, intervalLevel: 0.8, points,
    mealAware: { changedForecast: true, counterfactual: false, excludedMealIds: [], availability: availability(av), events: [] },
    models: { baseline: 'gru-v1', eventLayer: 'layer-v1' }, saved: true, notes: [], disclaimer: 'Not medical advice.',
  };
}

function glucose() {
  const history = [];
  for (let m = -60; m < 0; m += 5) history.push({ time: iso(m), value: 120 + m / 10 });
  return parseGlucoseResponse({
    status: 'ok', glucoseMgdl: 130, measuredAt: iso(0), ageMinutes: 2, history, predictions: [],
    forecastAvailable: true, forecastUnavailableReason: null,
    low: { alert: false, alreadyLow: false, headline: null }, high: { alert: false, alreadyHigh: false, headline: null },
    ranges: null, rangesAreShadow: true, modelVersion: 'v', generatedAt: iso(0), trendMgdlPerMin: null,
  });
}

const build = (opts) => buildOnBoardChart(glucose(), parseForecastResponse(forecastBody(opts)));

test('contract: per-point insulin / carbs on board are parsed; a server that omits them gives null; garbage rejects the answer', () => {
  const ok = parseForecastResponse(forecastBody());
  assert.ok(ok.points[0].insulinOnBoardUnits > 0);
  const omitted = parseForecastResponse(forecastBody({ iob: () => undefined, cob: () => undefined }));
  assert.equal(omitted.points[0].insulinOnBoardUnits, null);
  assert.equal(omitted.points[0].carbsOnBoardGrams, null);
  const nulls = parseForecastResponse(forecastBody({ iob: () => null, cob: () => null }));
  assert.equal(nulls.points[5].carbsOnBoardGrams, null);
  assert.equal(parseForecastResponse(forecastBody({ iob: () => 'lots' })), null);
});

test('both curves start at the chip values and fall; each uses its own scale (starts at the top)', () => {
  const m = build();
  assert.equal(m.hasInsulin, true);
  assert.equal(m.hasCarbs, true);
  assert.equal(m.insulinNow, 12);
  assert.equal(m.carbsNow, 40);
  assert.equal(m.insulinMax, 12, 'scale = the largest value, here the starting value');
  assert.equal(m.insulin.length, 37, 'now + 36 points');
  assert.ok(m.insulin[0].y < m.insulin[10].y && m.insulin[10].y < m.insulin[36].y, 'y grows downward as the amount falls');
  assert.equal(m.insulin[0].y, m.carbs[0].y, 'both start at the top of their own scale');
  assert.ok(m.insulinEnd < 1 && m.carbsEnd < 1, 'they end near zero after 3 hours');
  assert.equal(m.endMinutes, 180);
});

test('blood sugar: measured line ends at the latest reading, the dotted line starts there; its axis comes from glucose only', () => {
  const m = build();
  const lastActual = m.glucoseActual[m.glucoseActual.length - 1];
  assert.deepEqual(m.glucosePredicted[0], lastActual);
  assert.equal(m.glucosePredicted.length, 37);
  assert.equal(m.nowX, lastActual.x);
  assert.ok(m.yTicks.every((t) => t.frac > 0 && t.frac < 1));
  assert.ok(m.xTicks.some((t) => t.label === 'Latest') && m.xTicks.some((t) => t.label === '+3h'));
});

test('unknown is a gap, not zero: no insulin curve when the server sent none; the other curve is unaffected', () => {
  const m = build({ iob: () => null, av: { insulinOnBoardUnits: null, insulin: 'none_recorded' } });
  assert.equal(m.hasInsulin, false);
  assert.deepEqual(m.insulin, []);
  assert.equal(m.insulinMax, null);
  assert.equal(m.hasCarbs, true);
  assert.match(describeOnBoardChart(m), /nothing logged recently, so the amount is unknown/);
});

test('a curve that is all zeros is not drawn (nothing on board), and a single known value is not a curve', () => {
  const zero = build({ iob: () => 0, av: { insulinOnBoardUnits: 0, insulin: 'confirmed_none' } });
  assert.equal(zero.hasInsulin, false);
  const single = build({ cob: (m) => (m === 5 ? 3 : null), av: { carbsOnBoardGrams: null } });
  assert.equal(single.hasCarbs, false);
});

test('partial values: points the server did not give are skipped, never filled in', () => {
  const m = build({ iob: (mm) => (mm <= 60 ? 10 - mm / 10 : null) });
  assert.equal(m.hasInsulin, true);
  assert.equal(m.insulin.length, 13, 'now + the 12 points up to +60 min');
  assert.equal(m.scrubPoints[20].insulin, null, 'the readout says nothing for an unknown point');
});

test('readout points: now first (chip values), then every 5 minutes; nearest point by x', () => {
  const m = build();
  assert.equal(m.scrubPoints.length, 37);
  assert.deepEqual([m.scrubPoints[0].minutesAhead, m.scrubPoints[1].minutesAhead, m.scrubPoints[36].minutesAhead], [0, 5, 180]);
  assert.equal(m.scrubPoints[0].glucose, 130);
  assert.equal(m.scrubPoints[0].insulin, 12);
  const mid = m.scrubPoints[18];
  assert.equal(nearestOnBoardPoint(m.scrubPoints, mid.x + 0.2).minutesAhead, mid.minutesAhead);
  assert.equal(nearestOnBoardPoint([], 5), null);
});

test('text alternative describes the trend in words', () => {
  const t = describeOnBoardChart(build());
  assert.match(t, /Insulin on board falls from 12\.0 to 0\.\d units over the next 3 hours/);
  assert.match(t, /Carbs on board fall from 40 to \d grams/);
  assert.match(t, /dotted predicted line/);
});
