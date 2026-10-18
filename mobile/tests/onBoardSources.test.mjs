import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatAgo, insulinSourceRows, mealSourceRows } from '../src/services/onBoardSources.ts';

const NOW = Date.parse('2026-10-18T12:00:00Z');
const at = (minAgo) => new Date(NOW - minAgo * 60_000).toISOString();

const dose = (id, minAgo, over = {}) => ({
  id, administeredAt: at(minAgo), kind: 'bolus', insulinType: 'rapid', unitsTaken: 4, confirmation: 'confirmed', status: 'active', ...over,
});
const meal = (id, minAgo, over = {}) => ({
  id, label: null, eatenAt: at(minAgo), status: 'confirmed', carbs: { grams: 40, kind: 'user_entered' }, ...over,
});
const ev = (id, type, role) => ({ id, type, time: at(0), role, reason: 'x' });

test('formatAgo', () => {
  assert.equal(formatAgo(10_000), 'just now');
  assert.equal(formatAgo(35 * 60_000), '35 min ago');
  assert.equal(formatAgo(60 * 60_000), '1 h ago');
  assert.equal(formatAgo(200 * 60_000), '3 h 20 min ago');
  assert.equal(formatAgo(-5000), 'just now', 'never negative');
});

test('insulin rows: newest first, window applied, removed entries left out, amounts as logged', () => {
  const rows = insulinSourceRows(
    [dose('old', 800), dose('a', 90, { unitsTaken: 10 }), dose('b', 20, { kind: 'correction', unitsTaken: 2.5 }), dose('gone', 30, { status: 'cancelled' })],
    [],
    NOW,
  );
  assert.deepEqual(rows.map((r) => r.id), ['b', 'a'], 'cancelled and out-of-window entries are not listed');
  assert.equal(rows[0].title, '2.5 U');
  assert.equal(rows[0].detail, 'Correction · Rapid-acting');
  assert.equal(rows[0].ago, '20 min ago');
  assert.equal(rows[1].title, '10 U');
});

test('insulin rows: unknown amount is not 0; a confirmed 0 U says none was taken; uncertain is flagged', () => {
  const rows = insulinSourceRows(
    [dose('u', 10, { unitsTaken: null }), dose('z', 20, { unitsTaken: 0 }), dose('s', 30, { confirmation: 'uncertain', insulinType: null })],
    [],
    NOW,
  );
  assert.equal(rows[0].title, 'Amount unknown');
  assert.equal(rows[1].title, 'No insulin taken (you confirmed)');
  assert.equal(rows[2].detail, 'With a meal · amount or time approximate');
});

test('how the forecast used an entry comes from the server event list, nothing is guessed', () => {
  const events = [ev('a', 'insulin', 'used'), ev('b', 'insulin', 'range_only'), ev('c', 'insulin', 'not_used')];
  const rows = insulinSourceRows([dose('a', 10), dose('b', 20), dose('c', 30), dose('d', 40)], events, NOW);
  assert.deepEqual(rows.map((r) => [r.id, r.status, r.counted]), [
    ['a', 'Counted in your forecast', true],
    ['b', 'Only widens the range', false],
    ['c', 'Not used in the forecast', false],
    ['d', '', false],
  ]);
});

test('meal rows: grams, label and where the number came from; unknown carbs stay unknown', () => {
  const rows = mealSourceRows(
    [
      meal('m1', 100, { label: 'Pasta', carbs: { grams: 62.4, kind: 'estimated' } }),
      meal('m2', 30, { carbs: { grams: null, kind: 'missing' } }),
      meal('m3', 50, { carbs: { grams: 30, kind: 'user_corrected' } }),
      meal('m4', 20, { status: 'cancelled' }),
    ],
    [ev('m1', 'meal', 'used')],
    NOW,
  );
  assert.deepEqual(rows.map((r) => r.id), ['m2', 'm3', 'm1']);
  assert.equal(rows[0].title, 'Carbs unknown');
  assert.equal(rows[1].detail, 'Meal · estimate corrected by you');
  assert.equal(rows[2].title, '62 g carbs');
  assert.equal(rows[2].detail, 'Pasta · AI estimate');
  assert.equal(rows[2].status, 'Counted in your forecast');
});

test('entries slightly in the future (clock skew) are listed, far future ones are not', () => {
  const future = (min) => new Date(NOW + min * 60_000).toISOString();
  const rows = insulinSourceRows([dose('skew', 0, { administeredAt: future(2) }), dose('far', 0, { administeredAt: future(60) })], [], NOW);
  assert.deepEqual(rows.map((r) => r.id), ['skew']);
});
