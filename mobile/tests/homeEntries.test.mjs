import assert from 'node:assert/strict';
import { test } from 'node:test';
import { insulinRows, mealRows } from '../src/services/homeEntries.ts';

const T = (m) => new Date(Date.parse('2026-10-20T12:00:00Z') + m * 60000).toISOString();
const sm = (id, m, g, over = {}) => ({ id, label: null, eatenAt: T(m), status: 'confirmed', carbs: { grams: g, kind: 'user_entered' }, ...over });
const si = (id, m, u, over = {}) => ({ id, administeredAt: T(m), kind: 'bolus', unitsTaken: u, confirmation: 'confirmed', status: 'active', ...over });
const rm = (id, m, g, over = {}) => ({ event: { kind: 'meal', id, label: 'Pasta', carbsG: g, occurredAtUtc: T(m) }, status: 'pending', serverId: null, ...over });
const ri = (id, m, u, over = {}) => ({ event: { kind: 'insulin', id, insulinKind: 'correction', unitsAdministered: u, occurredAtUtc: T(m) }, status: 'pending', serverId: null, ...over });

test('an entry just typed shows at once, marked as sending, newest first', () => {
  const rows = mealRows([sm('a', -60, 40)], [rm('local', -1, 45)]);
  assert.deepEqual(rows.map((r) => [r.key, r.amount, r.state]), [['local', '45 g', 'sending'], ['a', '40 g', 'saved']]);
  const doses = insulinRows([si('d', -90, 10)], [ri('ld', 0, 4.25)]);
  assert.deepEqual(doses.map((r) => [r.amount, r.title, r.state]), [['4.3 U', 'Correction', 'sending'], ['10 U', 'With a meal', 'saved']]);
});

test('once the server has it, it is listed once (the server copy), never twice', () => {
  const rows = mealRows([sm('srv', -2, 45)], [rm('local', -2, 45, { status: 'saved', serverId: 'srv' })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, 'srv');
  assert.equal(insulinRows([si('sd', 0, 4)], [ri('ld', 0, 4, { status: 'saved', serverId: 'sd' })]).length, 1);
});

test('a saved-but-not-yet-listed entry still shows (the list refresh may lag), a refused one says so, cancelled ones vanish', () => {
  const saved = mealRows([], [rm('local', 0, 30, { status: 'saved', serverId: 'srv' })]);
  assert.equal(saved[0].state, 'saved');
  assert.equal(mealRows([], [rm('x', 0, 30, { status: 'failed' })])[0].state, 'failed');
  assert.equal(mealRows([sm('c', 0, 30, { status: 'cancelled' })], []).length, 0);
  assert.equal(insulinRows([si('c', 0, 3, { status: 'cancelled' })], []).length, 0);
});

test('unknown stays unknown and "none taken" is not a number', () => {
  assert.equal(mealRows([sm('u', 0, null)], [])[0].amount, '? g');
  assert.equal(insulinRows([si('n', 0, 0)], [])[0].amount, 'None');
  assert.equal(insulinRows([si('q', 0, null)], [])[0].amount, '? U');
});
