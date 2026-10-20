import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEMO_SNAPSHOT, formatActivity, formatSleep, formatSteps, formatValue, getWearableView } from '../src/services/wearableDemo.ts';

test('today the wearable view is flagged demo and NOT connected (no fake device)', () => {
  const v = getWearableView();
  assert.equal(v.isDemo, true);
  assert.deepEqual(v.connection, { state: 'not_connected' });
  assert.equal(v.snapshot, DEMO_SNAPSHOT);
  assert.equal(DEMO_SNAPSHOT.measuredAt, null, 'demo values carry no measurement time');
});

test('formatting: known values, and unknown shown as a dash (never 0)', () => {
  assert.equal(formatSleep(440), '7 h 20 min');
  assert.equal(formatSleep(420), '7 h');
  assert.equal(formatSleep(null), '-');
  assert.equal(formatSteps(6420), '6,420');
  assert.equal(formatSteps(null), '-');
  assert.equal(formatActivity('moderate'), 'Moderate');
  assert.equal(formatActivity(null), '-');
  assert.equal(formatValue(72), '72');
  assert.equal(formatValue(null), '-');
  assert.equal(formatValue(97.4), '97');
});
