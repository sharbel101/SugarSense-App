// Run: npm run test:forecast  (pure modules only)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchForecastFrom, parseForecastResponse } from '../src/api/forecastContract.ts';
import { parseGlucoseResponse } from '../src/api/glucoseContract.ts';
import { buildForecastChart, describeForecastForScreenReader } from '../src/services/forecastChart.ts';
import {
  applyForecastResponse,
  deriveForecastView,
  INITIAL_FORECAST_STATE,
  KEEP_MINUTES,
  reduceForecast,
} from '../src/services/forecastState.ts';
import { forecastPrompts, formatCarbsOnBoard, formatInsulinOnBoard, savedMessage } from '../src/services/forecastView.ts';
import { buildGlucoseChart } from '../src/services/glucoseChart.ts';

const T0 = Date.parse('2026-10-16T10:00:00Z');
const iso = (m) => new Date(T0 + m * 60000).toISOString();

function availability(over = {}) {
  return {
    mealsUsed: 0, mealsRangeOnly: 0, mealsNotUsed: 0, insulin: 'none_recorded', insulinDosesUsed: 0, insulinDosesRangeOnly: 0,
    insulinOnBoardUnits: null, carbsOnBoardGrams: null, therapySettings: 'available', ...over,
  };
}

function okBody(over = {}) {
  const points = [];
  for (let i = 1; i <= 36; i++) {
    const m = i * 5;
    const ext = m > 120;
    points.push({
      minutes: m, time: iso(m), baseline: ext ? null : 130 + m / 4, adjusted: 130 + m / 4 + (m > 30 ? 12 : 0),
      low: 110 + m / 4 - m / 6, high: 150 + m / 4 + m / 4, extension: ext,
    });
  }
  return {
    status: 'ok',
    anchor: { measuredAt: iso(0), glucoseMgdl: 130, ageMinutes: 2 },
    generatedAt: iso(1), horizonMin: 180, stepMin: 5, intervalLevel: 0.8, points,
    mealAware: { changedForecast: true, counterfactual: false, excludedMealIds: [], availability: availability(), events: [] },
    models: { baseline: 'gru-v1', eventLayer: 'layer-v1' }, saved: true, notes: ['a note'], disclaimer: 'Not medical advice.',
    ...over,
  };
}

function glucoseOk() {
  const history = [];
  for (let m = -60; m < 0; m += 5) history.push({ time: iso(m), value: 120 + m / 10 });
  return parseGlucoseResponse({
    status: 'ok', glucoseMgdl: 130, measuredAt: iso(0), ageMinutes: 2, history, predictions: [{ time: iso(5), value: 131 }],
    forecastAvailable: true, forecastUnavailableReason: null,
    low: { alert: false, alreadyLow: false, headline: null }, high: { alert: false, alreadyHigh: false, headline: null },
    ranges: null, rangesAreShadow: true, modelVersion: 'v', generatedAt: iso(0),
  });
}

// ----------------------------------------------------------------------------------- parser

test('parseForecastResponse accepts a real-looking sample and keeps null as null', () => {
  const f = parseForecastResponse(okBody());
  assert.equal(f.status, 'ok');
  assert.equal(f.points.length, 36);
  assert.equal(f.points[35].baseline, null);
  assert.equal(f.mealAware.availability.insulinOnBoardUnits, null);
  assert.equal(f.mealAware.availability.carbsOnBoardGrams, null);
});

test('parseForecastResponse rejects off-shape bodies whole', () => {
  assert.equal(parseForecastResponse(okBody({ points: undefined })), null);
  assert.equal(parseForecastResponse(okBody({ points: [] })), null);
  const badStep = okBody();
  badStep.points[3].minutes = 21;
  assert.equal(parseForecastResponse(badStep), null);
  const crossed = okBody();
  crossed.points[2].low = 300;
  assert.equal(parseForecastResponse(crossed), null);
  assert.equal(parseForecastResponse({ status: 'mystery' }), null);
  assert.equal(parseForecastResponse(null), null);
  assert.equal(parseForecastResponse(okBody({ stepMin: 10 })), null);
  const garbageBaseline = okBody();
  garbageBaseline.points[0].baseline = 'x';
  assert.equal(parseForecastResponse(garbageBaseline), null);
  const garbageIob = okBody();
  garbageIob.mealAware.availability.insulinOnBoardUnits = 'lots';
  assert.equal(parseForecastResponse(garbageIob), null);
});

test('parseForecastResponse: the non-ok variants', () => {
  assert.equal(parseForecastResponse({ status: 'stale', reason: 'old', lastMeasuredAt: iso(-60) }).status, 'stale');
  assert.equal(parseForecastResponse({ status: 'unavailable', reason: 'down' }).reason, 'down');
  const base = parseForecastResponse({
    status: 'baseline_unavailable', anchor: { measuredAt: iso(0), glucoseMgdl: 130, ageMinutes: 1 }, reason: 'model down', notes: [], disclaimer: 'd',
  });
  assert.equal(base.status, 'baseline_unavailable');
});

test('fetchForecastFrom: 404/503 = not_deployed, network = network, bad body = invalid_body', async () => {
  const mk = (status, body) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => body });
  assert.equal((await fetchForecastFrom('', undefined, mk(404, {}))).cause, 'not_deployed');
  assert.equal((await fetchForecastFrom('', undefined, mk(503, {}))).cause, 'not_deployed');
  assert.equal((await fetchForecastFrom('', undefined, mk(500, {}))).cause, 'bad_status');
  assert.equal((await fetchForecastFrom('', undefined, mk(200, { nope: 1 }))).cause, 'invalid_body');
  assert.equal((await fetchForecastFrom('', undefined, async () => { throw new Error('x'); })).cause, 'network');
  const ok = await fetchForecastFrom('', undefined, mk(200, okBody()));
  assert.equal(ok.kind, 'response');
});

// ------------------------------------------------------------------------------------ chart

test('buildForecastChart: extension split at +120, band from every point, baseline hidden when equal', () => {
  const g = glucoseOk();
  const equal = okBody();
  for (const p of equal.points) p.adjusted = p.baseline ?? p.adjusted;
  const model = buildForecastChart(g, parseForecastResponse(equal));
  assert.equal(model.hasBaselineLine, false);
  assert.deepEqual(model.baselineLine, []);
  assert.equal(model.hasExtension, true);
  // main line: now + 24 points (to +120); extension: join + 12 points
  assert.equal(model.predicted.length, 1 + 24);
  assert.equal(model.extension.length, 1 + 12);
  // band: now + 36 upper + 36 lower + now
  assert.equal(model.band.length, 1 + 36 + 36 + 1);
  const moved = buildForecastChart(g, parseForecastResponse(okBody()));
  assert.equal(moved.hasBaselineLine, true);
  assert.equal(moved.baselineLine.length, 1 + 24, 'baseline only where the server supplied it');
});

test('buildForecastChart: y domain contains every bound; x ticks include +3h; nothing invented', () => {
  const g = glucoseOk();
  const body = okBody();
  body.points[10].high = 410;
  body.points[20].low = 40;
  const f = parseForecastResponse(body);
  const m = buildForecastChart(g, f);
  assert.ok(m.yMaxMgdl >= 410 && m.yMinMgdl <= 40);
  assert.deepEqual(m.xTicks.map((t) => t.label).filter((l) => l.startsWith('+')), ['+1h', '+2h', '+3h']);
  assert.equal(m.scrubPoints.length, 36);
  assert.equal(m.scrubPoints[0].baseline, 130 + 5 / 4);
  assert.equal(m.scrubPoints[35].baseline, null);
  assert.ok(m.scrubPoints.every((p, i) => p.minutesAhead === (i + 1) * 5));
  // without /forecast the caller keeps buildGlucoseChart: it must still work and draw no extension
  const old = buildGlucoseChart(g);
  assert.equal(old.forecastPoints.length, 1);
});

test('buildForecastChart: markers inside the domain only, excluded events hidden', () => {
  const body = okBody();
  body.mealAware.events = [
    { id: 'm1', type: 'meal', time: iso(-30), role: 'used', reason: 'ok' },
    { id: 'i1', type: 'insulin', time: iso(-25), role: 'range_only', reason: 'x' },
    { id: 'old', type: 'meal', time: iso(-600), role: 'used', reason: 'ok' },
    { id: 'gone', type: 'meal', time: iso(-10), role: 'excluded', reason: 'x' },
  ];
  const m = buildForecastChart(glucoseOk(), parseForecastResponse(body));
  assert.deepEqual(m.markers.map((x) => x.id), ['m1', 'i1']);
});

test('screen-reader text mentions inclusion and the server range, never a made-up range', () => {
  const body = okBody();
  body.mealAware.availability = availability({ mealsUsed: 1, insulinDosesUsed: 1, insulin: 'logged', insulinOnBoardUnits: 2 });
  const t = describeForecastForScreenReader(parseForecastResponse(body));
  assert.match(t, /1 logged meal and 1 insulin dose/);
  assert.match(t, /predicted range \d+ to \d+/);
  assert.match(describeForecastForScreenReader(parseForecastResponse(okBody())), /No logged meals or insulin/);
});

// ------------------------------------------------------------------------------------ state

test('forecast state: ok -> keep <=10 min when a refresh fails, then drop to fallback', () => {
  const f = parseForecastResponse(okBody());
  let s = applyForecastResponse(INITIAL_FORECAST_STATE, f, 0);
  assert.equal(deriveForecastView(s, 1000).kind, 'ok');
  assert.equal(deriveForecastView(s, 1000).asOf, null);
  s = reduceForecast(s, { kind: 'error', cause: 'network' }, 2 * 60_000);
  const kept = deriveForecastView(s, 2 * 60_000);
  assert.equal(kept.kind, 'ok');
  assert.ok(kept.asOf, 'labelled as of');
  assert.equal(deriveForecastView(s, (KEEP_MINUTES + 1) * 60_000).kind, 'fallback');
});

test('forecast state: not_deployed and failures -> fallback; stale drops numbers; aborted is ignored', () => {
  const f = parseForecastResponse(okBody());
  let s = applyForecastResponse(INITIAL_FORECAST_STATE, f, 0);
  assert.equal(reduceForecast(s, { kind: 'error', cause: 'aborted' }, 5), s);
  const nd = reduceForecast(s, { kind: 'error', cause: 'not_deployed' }, 10);
  assert.equal(deriveForecastView(nd, 20).kind, 'fallback');
  const stale = reduceForecast(s, { kind: 'response', response: { status: 'stale', reason: 'old', lastMeasuredAt: null } }, 10);
  assert.equal(deriveForecastView(stale, 20).kind, 'stale');
  assert.equal(deriveForecastView(INITIAL_FORECAST_STATE, 0).kind, 'loading');
  assert.equal(deriveForecastView(reduceForecast(INITIAL_FORECAST_STATE, { kind: 'error', cause: 'network' }, 0), 1).kind, 'fallback');
});

test('applyForecast (from an event save) replaces the held forecast immediately', () => {
  const a = parseForecastResponse(okBody());
  const b = parseForecastResponse(okBody({ generatedAt: iso(9) }));
  let s = applyForecastResponse(INITIAL_FORECAST_STATE, a, 0);
  s = applyForecastResponse(s, b, 5);
  assert.equal(deriveForecastView(s, 6).data.generatedAt, iso(9));
});

// ------------------------------------------------------------------------------ IOB/COB text

test('IOB/COB formatting: null is unknown, never 0; 0 only when confirmed none', () => {
  assert.equal(formatInsulinOnBoard(availability()).value, 'unknown');
  assert.equal(formatInsulinOnBoard(availability({ insulinOnBoardUnits: 2.34, insulin: 'logged' })).value, '2.3 U');
  assert.equal(formatInsulinOnBoard(availability({ insulinOnBoardUnits: 0, insulin: 'confirmed_none' })).value, '0.0 U');
  assert.equal(formatInsulinOnBoard(availability({ insulinOnBoardUnits: 0, insulin: 'none_recorded' })).value, 'unknown');
  assert.equal(formatInsulinOnBoard(availability({ insulin: 'logged', insulinOnBoardUnits: 1 })).caption, 'from the doses you logged');
  assert.equal(formatInsulinOnBoard(availability({ insulin: 'confirmed_none', insulinOnBoardUnits: 0 })).caption, 'none taken (you confirmed)');
  assert.equal(formatInsulinOnBoard(availability()).caption, 'no insulin logged recently');
  assert.equal(formatCarbsOnBoard(availability()).value, 'none logged');
  assert.equal(formatCarbsOnBoard(availability({ carbsOnBoardGrams: 18.4 })).value, '18 g');
});

// ---------------------------------------------------------------------------------- prompts

test('forecastPrompts: each banner condition, in priority order, none when nothing applies', () => {
  const none = parseForecastResponse(okBody());
  assert.deepEqual(forecastPrompts(none), []);

  const all = okBody();
  all.mealAware.availability = availability({ therapySettings: 'unavailable', mealsNotUsed: 1, mealsRangeOnly: 1 });
  all.mealAware.events = [
    { id: 'm1', type: 'meal', time: iso(-20), role: 'range_only', reason: 'insulin_not_recorded' },
    { id: 'i1', type: 'insulin', time: iso(-10), role: 'range_only', reason: 'dose_without_recorded_meal' },
    { id: 'i2', type: 'insulin', time: iso(-9), role: 'range_only', reason: 'insulin_link_ambiguous' },
  ];
  const prompts = forecastPrompts(parseForecastResponse(all));
  assert.deepEqual(prompts.map((p) => p.kind), ['set_ratio', 'meal_without_insulin', 'dose_without_meal', 'dose_ambiguous']);
  assert.equal(prompts[1].eventId, 'm1');
  assert.equal(prompts[2].eventId, 'i1');

  const ratioOnly = okBody();
  ratioOnly.mealAware.availability = availability({ therapySettings: 'unavailable' });
  assert.deepEqual(forecastPrompts(parseForecastResponse(ratioOnly)), [], 'no banner when nothing is logged');

  const confirmedNone = okBody();
  confirmedNone.mealAware.availability = availability({ mealsUsed: 1, insulin: 'confirmed_none', insulinOnBoardUnits: 0 });
  assert.deepEqual(forecastPrompts(parseForecastResponse(confirmedNone)), []);
});

test('savedMessage never claims an update without a returned forecast', () => {
  assert.equal(savedMessage(true), 'Saved. Forecast updated.');
  assert.equal(savedMessage(false), 'Saved. The forecast will update on the next reading.');
});
