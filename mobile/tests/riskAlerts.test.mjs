import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseForecastResponse } from '../src/api/forecastContract.ts';
import {
  deserializeAlertState,
  riskSummary,
  detectPredictedRisks,
  evaluateRisks,
  inAbout,
  INITIAL_ALERT_STATE,
  MIN_GAP_MS,
  serializeAlertState,
} from '../src/services/riskAlerts.ts';

const T0 = Date.parse('2026-10-18T12:00:00Z');
const iso = (m) => new Date(T0 + m * 60000).toISOString();

/** A forecast whose line is `line(minutes)`; `measured` shifts the reading time (a "new reading"). */
function forecast(line, { glucose = 120, measuredMin = 0, iob = 12.2, cob = 28 } = {}) {
  const points = [];
  for (let i = 1; i <= 36; i++) {
    const m = i * 5;
    const v = line(m);
    points.push({ minutes: m, time: iso(measuredMin + m), baseline: m > 120 ? null : v, adjusted: v, low: v - 40, high: v + 40, extension: m > 120, insulinOnBoardUnits: 1, carbsOnBoardGrams: 1 });
  }
  return parseForecastResponse({
    status: 'ok', anchor: { measuredAt: iso(measuredMin), glucoseMgdl: glucose, ageMinutes: 1 }, generatedAt: iso(measuredMin), horizonMin: 180, stepMin: 5, intervalLevel: 0.8, points,
    mealAware: {
      changedForecast: true, counterfactual: false, excludedMealIds: [],
      availability: { mealsUsed: 1, mealsRangeOnly: 0, mealsNotUsed: 0, insulin: 'logged', insulinDosesUsed: 1, insulinDosesRangeOnly: 0, insulinOnBoardUnits: iob, carbsOnBoardGrams: cob, therapySettings: 'available' },
      events: [],
    },
    models: { baseline: 'g', eventLayer: 'e' }, saved: true, notes: [], disclaimer: 'x',
  });
}

const flat = (v) => () => v;
const fallingToLow = (m) => 120 - m * 0.4; // 80 at +100 min (not below), 72 at +120, 48 at +180
const risingToHigh = (m) => 120 + m * 1; // 240 at +120 (not above), 245 at +125

test('low: first point strictly below 80 and the lowest point are found; exactly 80 is not low', () => {
  const r = detectPredictedRisks(forecast(fallingToLow)).low;
  assert.ok(r);
  assert.equal(r.firstMinutesAhead, 105, '120 - 0.4*105 = 78');
  assert.equal(r.firstAtMs, T0 + 105 * 60000);
  assert.equal(r.extremeMinutesAhead, 180);
  assert.equal(Math.round(r.extremeValue), 48);
  assert.equal(r.alreadyPast, false);
  assert.equal(detectPredictedRisks(forecast(flat(80))).low, null, 'exactly 80 is not below 80');
  assert.equal(detectPredictedRisks(forecast(flat(79.9))).low?.firstMinutesAhead, 5);
});

test('high: strictly above 240; exactly 240 is not high; the highest point is reported', () => {
  assert.equal(detectPredictedRisks(forecast(flat(240))).high, null);
  const r = detectPredictedRisks(forecast(risingToHigh)).high;
  assert.equal(r.firstMinutesAhead, 125);
  assert.equal(r.extremeMinutesAhead, 180);
  assert.equal(r.extremeValue, 300);
  assert.equal(detectPredictedRisks(forecast(risingToHigh)).low, null);
});

test('a forecast with neither: both null; one with both (down then up) reports both', () => {
  assert.deepEqual(detectPredictedRisks(forecast(flat(130))), { low: null, high: null });
  const both = detectPredictedRisks(forecast((m) => (m < 60 ? 70 : 250)));
  assert.ok(both.low && both.high);
  assert.equal(both.low.firstMinutesAhead, 5);
  assert.equal(both.high.firstMinutesAhead, 60);
});

test('the latest reading already past the threshold is flagged', () => {
  const r = detectPredictedRisks(forecast(flat(70), { glucose: 72 })).low;
  assert.equal(r.alreadyPast, true);
  assert.match(riskSummary(r).title, /^Reading 72 is below 80$/);
  assert.equal(detectPredictedRisks(forecast(flat(70), { glucose: 95 })).low.alreadyPast, false);
});

test('card text: what and when, the predicted value then and how soon, and the lowest / highest when it goes further', () => {
  const r = detectPredictedRisks(forecast(fallingToLow)).low;
  const t = riskSummary(r);
  assert.match(t.title, /^Low predicted at \d+:\d\d (AM|PM)$/);
  assert.equal(t.detail, 'About 78 mg/dL · in about 1 h 45 min', 'the value at the first crossing (120 - 0.4 * 105 = 78)');
  assert.match(t.extreme, /^Lowest about 48 mg\/dL at \d+:\d\d (AM|PM)$/);
  const high = riskSummary(detectPredictedRisks(forecast(risingToHigh)).high);
  assert.match(high.title, /^High predicted at/);
  assert.match(high.detail, /^About 245 mg\/dL · in about 2 h 5 min$/);
  assert.match(high.extreme, /^Highest about 300 mg\/dL at/);
  assert.ok(!/will be|you will|take /i.test(t.title + t.detail + t.extreme + high.title), 'no certainty or dosing words');
  assert.equal(inAbout(25), 'about 25 min');
  assert.equal(inAbout(170), 'about 2 h 50 min');
  assert.equal(inAbout(180), 'about 3 h');
  assert.equal(inAbout(3), 'about 5 min');
  assert.equal(inAbout(1), 'less than 5 min');
});

test('no second line when the line only just crosses (the lowest is the same point or within 3 mg/dL)', () => {
  const r = detectPredictedRisks(forecast(flat(70))).low;
  const t = riskSummary(r);
  assert.equal(t.detail, 'About 70 mg/dL · in about 5 min');
  assert.equal(t.extreme, '');
});

test('a new risk raises ONE notification; the same risk on the next readings stays quiet', () => {
  const a = evaluateRisks(INITIAL_ALERT_STATE, forecast(fallingToLow, { measuredMin: 0 }), T0);
  assert.equal(a.notifications.length, 1);
  assert.equal(a.notifications[0].type, 'predicted');
  assert.equal(a.notifications[0].title, 'Low blood sugar predicted');
  assert.equal(a.notifications[0].tag, 'sugarsense-risk-low');
  assert.equal(a.state.low.active, true);
  const b = evaluateRisks(a.state, forecast(fallingToLow, { measuredMin: 5 }), T0 + 5 * 60000);
  assert.equal(b.notifications.length, 0, 'same episode, new reading: nothing new to say');
  assert.equal(b.state.low.active, true);
});

test('the same reading is never evaluated twice (a 60 s poll returns the same forecast)', () => {
  const f = forecast(fallingToLow);
  const a = evaluateRisks(INITIAL_ALERT_STATE, f, T0);
  const again = evaluateRisks(a.state, f, T0 + 60000);
  assert.equal(again.notifications.length, 0);
  assert.equal(again.state, a.state);
});

test('when a NEW reading takes the risk out of the forecast: one "cleared" notification, naming the reading', () => {
  const a = evaluateRisks(INITIAL_ALERT_STATE, forecast(fallingToLow, { measuredMin: 0 }), T0);
  const cleared = evaluateRisks(a.state, forecast(flat(120), { measuredMin: 5, glucose: 112 }), T0 + 5 * 60000);
  assert.equal(cleared.notifications.length, 1);
  const n = cleared.notifications[0];
  assert.equal(n.type, 'cleared');
  assert.equal(n.title, 'Low risk cleared');
  assert.equal(n.tag, 'sugarsense-risk-low', 'replaces the "predicted" notification');
  assert.match(n.body, /As of the new reading at \d+:\d\d (AM|PM) \(112 mg\/dL\), your forecast no longer goes below 80 mg\/dL/);
  assert.equal(cleared.state.low.active, false);
  const after = evaluateRisks(cleared.state, forecast(flat(120), { measuredMin: 10 }), T0 + 10 * 60000);
  assert.equal(after.notifications.length, 0, 'nothing more once it is cleared');
});

test('low and high are separate: each raises and clears on its own', () => {
  const both = evaluateRisks(INITIAL_ALERT_STATE, forecast((m) => (m < 60 ? 70 : 250)), T0);
  assert.deepEqual(both.notifications.map((n) => n.title).sort(), ['High blood sugar predicted', 'Low blood sugar predicted']);
  const onlyHigh = evaluateRisks(both.state, forecast(flat(250), { measuredMin: 5 }), T0 + 5 * 60000);
  assert.deepEqual(onlyHigh.notifications.map((n) => n.title), ['Low risk cleared']);
  assert.equal(onlyHigh.state.high.active, true);
});

test('alarm budget: a line hovering at the threshold cannot raise "predicted" twice within 30 minutes; the quiet episode is not "cleared" either', () => {
  let r = evaluateRisks(INITIAL_ALERT_STATE, forecast(flat(70), { measuredMin: 0 }), T0);
  assert.equal(r.notifications.length, 1);
  r = evaluateRisks(r.state, forecast(flat(120), { measuredMin: 5 }), T0 + 5 * 60000);
  assert.equal(r.notifications[0].type, 'cleared');
  r = evaluateRisks(r.state, forecast(flat(70), { measuredMin: 10 }), T0 + 10 * 60000);
  assert.equal(r.notifications.length, 0, 'inside the 30 minute gap: active on the card, but silent');
  assert.equal(r.state.low.active, true);
  r = evaluateRisks(r.state, forecast(flat(120), { measuredMin: 15 }), T0 + 15 * 60000);
  assert.equal(r.notifications.length, 0, 'a silent episode gets no "cleared" notification');
  r = evaluateRisks(r.state, forecast(flat(70), { measuredMin: 20 }), T0 + 20 * 60000 + MIN_GAP_MS);
  assert.equal(r.notifications.length, 1, 'after the gap a new risk is announced again');
});

test('persistence round-trips; anything unreadable gives the empty state (never a made-up "active")', () => {
  const a = evaluateRisks(INITIAL_ALERT_STATE, forecast(flat(70)), T0);
  assert.deepEqual(deserializeAlertState(serializeAlertState(a.state)), a.state);
  for (const bad of [null, '', 'not json', '{}', JSON.stringify({ low: { active: 'yes' }, high: {}, lastMeasuredAt: null })]) {
    assert.deepEqual(deserializeAlertState(bad), INITIAL_ALERT_STATE);
  }
});
