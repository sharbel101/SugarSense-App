// Run: npm run test:spike
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  deserializeMissedMeal, detectMealSpike, dismissMissedMeal, evaluateMissedMeal, INITIAL_MISSED_MEAL_STATE, isDismissed, MISSED_MEAL_GAP_MS, serializeMissedMeal, spikeSummary,
} from '../src/services/mealSpike.ts';

const NOW = Date.parse('2026-10-21T18:00:00Z');
const MIN = 60_000;
const at = (m) => new Date(NOW + m * MIN).toISOString();
/** 5-minute readings: [minutesAgo, value] pairs, newest last. */
const series = (pairs) => pairs.map(([ago, v]) => ({ time: at(-ago), value: v }));

const SPIKE = series([[50, 95], [45, 98], [40, 110], [35, 125], [30, 140], [25, 152], [20, 160], [15, 166], [10, 170], [5, 172], [0, 174]]);

test('a fast rise with no meal logged is a possible missed meal, with the numbers from the readings', () => {
  const s = detectMealSpike(SPIKE, [], NOW);
  assert.ok(s);
  assert.equal(s.fromMgdl, 95);
  assert.equal(s.toMgdl, 174);
  assert.equal(s.riseMgdl, 79);
  assert.equal(s.minutes, 50);
  assert.equal(s.stillRising, true);
  assert.equal(spikeSummary(s), 'Glucose rose 79 mg/dL in about 50 min (95 to 174) and no meal is logged around then.');
});

test('a meal logged around the rise (before, during or after it started) explains it', () => {
  assert.equal(detectMealSpike(SPIKE, [NOW - 30 * MIN], NOW), null, 'during');
  assert.equal(detectMealSpike(SPIKE, [NOW - 100 * MIN], NOW), null, 'within 2 h before the rise began');
  assert.equal(detectMealSpike(SPIKE, [NOW - 5 * MIN], NOW), null, 'logged after the rise began');
  assert.ok(detectMealSpike(SPIKE, [NOW - 4 * 60 * MIN], NOW), 'a meal 4 h earlier does not explain it');
});

test("rise thresholds: small, too slow, and already-back-down rises are not asked about", () => {
  const slow = series([[50, 100], [40, 110], [30, 118], [20, 126], [10, 134], [0, 142]]); // 42 in 50 min = 0.84/min but 42 >= 40: counts
  assert.ok(detectMealSpike(slow, [], NOW), 'sanity: this one qualifies');
  const drift = series([[70, 100], [60, 108], [50, 116], [40, 124], [30, 132], [20, 140], [10, 144], [0, 146]]); // 46 over 70 min: 0.66/min but >75? 70 ok
  assert.ok(detectMealSpike(drift, [], NOW));
  const small = series([[40, 100], [30, 110], [20, 120], [10, 128], [0, 135]]);
  assert.equal(detectMealSpike(small, [], NOW), null, 'only 35 mg/dL');
  const flatSlow = series([[75, 100], [60, 105], [45, 112], [30, 121], [15, 130], [0, 140]]); // 40 in 75 min = 0.53/min: qualifies at the edge
  assert.ok(detectMealSpike(flatSlow, [], NOW));
  const tooSlow = series([[75, 100], [60, 104], [45, 110], [30, 118], [15, 126], [0, 139]]); // 39
  assert.equal(detectMealSpike(tooSlow, [], NOW), null);
  const down = series([[50, 95], [40, 120], [30, 150], [20, 140], [10, 125], [0, 108]]);
  assert.equal(detectMealSpike(down, [], NOW), null, 'back near the starting level');
});

test('old readings, too few readings, or a peak that is not recent say nothing', () => {
  assert.equal(detectMealSpike(series([[30, 95], [25, 140]]), [], NOW), null, 'too few readings');
  const old = SPIKE.map((r) => ({ ...r, time: new Date(Date.parse(r.time) - 40 * MIN).toISOString() }));
  assert.equal(detectMealSpike(old, [], NOW), null, 'latest reading 40 minutes old');
  const earlier = series([[170, 95], [160, 100], [150, 140], [140, 150], [130, 152], [60, 150], [30, 152], [0, 151]]);
  assert.equal(detectMealSpike(earlier, [], NOW), null, 'the rise was hours ago');
});

test('notification: once, then quiet for 3 hours; "not a meal" silences it; no spike never notifies', () => {
  const s = detectMealSpike(SPIKE, [], NOW);
  const a = evaluateMissedMeal(INITIAL_MISSED_MEAL_STATE, s, NOW);
  assert.equal(a.notify, true);
  const b = evaluateMissedMeal(a.state, s, NOW + 10 * MIN);
  assert.equal(b.notify, false, 'already told');
  const c = evaluateMissedMeal(a.state, s, NOW + MISSED_MEAL_GAP_MS + MIN);
  assert.equal(c.notify, true, 'after the gap');
  assert.equal(evaluateMissedMeal(INITIAL_MISSED_MEAL_STATE, null, NOW).notify, false);
  const d = dismissMissedMeal(INITIAL_MISSED_MEAL_STATE, NOW);
  assert.equal(isDismissed(d, NOW + MIN), true);
  assert.equal(evaluateMissedMeal(d, s, NOW + MIN).notify, false);
  assert.equal(isDismissed(d, NOW + 4 * 60 * MIN), false);
});

test('state survives a round trip; garbage gives the empty state', () => {
  const st = { lastNotifiedAtMs: 123, dismissedUntilMs: 456 };
  assert.deepEqual(deserializeMissedMeal(serializeMissedMeal(st)), st);
  assert.deepEqual(deserializeMissedMeal('{nope'), INITIAL_MISSED_MEAL_STATE);
  assert.deepEqual(deserializeMissedMeal(null), INITIAL_MISSED_MEAL_STATE);
});

test('last known: round trip, newer wins over older, garbage or implausible glucose gives nothing', async () => {
  const { deserializeLastKnown, serializeLastKnown, mergeGlucose, mergeOnBoard, EMPTY_LAST_KNOWN } = await import('../src/services/lastKnown.ts');
  const lk = { glucose: { mgdl: 120, measuredAt: '2026-10-21T18:00:00.000Z' }, onBoard: { insulinUnits: 0.8, insulin: 'logged', carbsGrams: null, generatedAt: '2026-10-21T18:00:00.000Z' } };
  assert.deepEqual(deserializeLastKnown(serializeLastKnown(lk)), lk);
  assert.equal(deserializeLastKnown('{x').glucose, null);
  assert.deepEqual(deserializeLastKnown(null), EMPTY_LAST_KNOWN);
  assert.equal(deserializeLastKnown(JSON.stringify({ glucose: { mgdl: 5, measuredAt: '2026-10-21T18:00:00Z' } })).glucose, null, 'implausible glucose is dropped');
  const newer = mergeGlucose(lk, { mgdl: 140, measuredAt: '2026-10-21T18:05:00.000Z' });
  assert.equal(newer.glucose.mgdl, 140);
  assert.equal(mergeGlucose(newer, { mgdl: 99, measuredAt: '2026-10-21T17:00:00.000Z' }), newer, 'an older reading never replaces a newer one');
  assert.equal(mergeOnBoard(lk, { insulinUnits: 0, insulin: 'none_recorded', carbsGrams: null, generatedAt: '2026-10-21T17:00:00.000Z' }), lk);
  assert.equal(lk.onBoard.carbsGrams, null, 'unknown stays null, never 0');
});
