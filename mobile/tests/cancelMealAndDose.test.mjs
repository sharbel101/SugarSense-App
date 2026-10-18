import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cancelMealAndDose } from '../src/services/cancelMealAndDose.ts';

const mealRec = (over = {}) => ({ event: { kind: 'meal', id: 'local-meal-1', carbsG: 40 }, status: 'saved', serverId: 'srv-meal', ...over });
const doseRec = (over = {}) => ({ event: { kind: 'insulin', id: 'local-dose-1', mealId: 'srv-meal', unitsAdministered: 4 }, status: 'saved', serverId: 'srv-dose', ...over });
const mealView = (over = {}) => ({ id: 'srv-meal', status: 'confirmed', revision: 2, ...over });
const doseView = (over = {}) => ({ id: 'srv-dose', status: 'active', revision: 3, mealId: 'srv-meal', ...over });

function deps(over = {}) {
  const calls = [];
  const d = {
    records: [mealRec(), doseRec()],
    recentMeals: [mealView()],
    recentInsulin: [doseView()],
    editMeal: async (id, patch) => (calls.push(['meal', id, patch]), { result: 'updated' }),
    editInsulin: async (id, patch) => (calls.push(['dose', id, patch]), { result: 'updated' }),
    discard: (id) => calls.push(['discard', id]),
    ...over,
  };
  return { d, calls };
}

test('removes the dose FIRST, then the meal, each with the revision the server last reported', async () => {
  const { d, calls } = deps();
  const out = await cancelMealAndDose('srv-meal', d);
  assert.deepEqual(out, { kind: 'done' });
  assert.deepEqual(calls, [
    ['dose', 'srv-dose', { status: 'cancelled', expectedRevision: 3 }],
    ['meal', 'srv-meal', { status: 'cancelled', expectedRevision: 2 }],
  ]);
});

test('a meal with no dose: only the meal is removed', async () => {
  const { d, calls } = deps({ records: [mealRec()], recentInsulin: [] });
  assert.deepEqual(await cancelMealAndDose('srv-meal', d), { kind: 'done' });
  assert.deepEqual(calls.map((c) => c[0]), ['meal']);
});

test('entries the server never received are dropped from the queue, nothing is sent for them', async () => {
  const records = [
    mealRec({ status: 'pending', serverId: null }),
    doseRec({ status: 'pending', serverId: null, event: { kind: 'insulin', id: 'local-dose-1', mealId: 'local-meal-1' } }),
  ];
  const { d, calls } = deps({ records, recentMeals: [], recentInsulin: [] });
  assert.deepEqual(await cancelMealAndDose('local-meal-1', d), { kind: 'done' });
  assert.deepEqual(calls, [['discard', 'local-dose-1'], ['discard', 'local-meal-1']]);
});

test('a saved meal with a dose still queued: the dose is dropped, the meal is cancelled on the server', async () => {
  const records = [mealRec(), doseRec({ status: 'pending', serverId: null, event: { kind: 'insulin', id: 'local-dose-1', mealId: 'local-meal-1' } })];
  const { d, calls } = deps({ records, recentInsulin: [] });
  assert.deepEqual(await cancelMealAndDose('srv-meal', d), { kind: 'done' });
  assert.deepEqual(calls.map((c) => c[0]), ['discard', 'meal'], 'the dose never acts alone');
});

test('a dose recorded from elsewhere (not in this queue) is removed too, before the meal', async () => {
  const { d, calls } = deps({ records: [mealRec()], recentInsulin: [doseView({ id: 'other-dose', revision: 1 })] });
  assert.deepEqual(await cancelMealAndDose('srv-meal', d), { kind: 'done' });
  assert.deepEqual(calls, [
    ['dose', 'other-dose', { status: 'cancelled', expectedRevision: 1 }],
    ['meal', 'srv-meal', { status: 'cancelled', expectedRevision: 2 }],
  ]);
});

test('conflict on the dose stops everything: the meal is NOT removed (the dose would be left alone)', async () => {
  const { d, calls } = deps({ editInsulin: async (id, p) => (calls.push(['dose', id, p]), { result: 'conflict' }) });
  assert.deepEqual(await cancelMealAndDose('srv-meal', d), { kind: 'conflict' });
  assert.deepEqual(calls.map((c) => c[0]), ['dose']);
});

test('a failing dose removal reports it and leaves the meal alone; a failing meal removal reports the meal', async () => {
  const a = deps({ editInsulin: async () => ({ result: 'server_unavailable' }) });
  assert.deepEqual(await cancelMealAndDose('srv-meal', a.d), { kind: 'failed', step: 'dose' });
  assert.equal(a.calls.length, 0);

  const b = deps({ editMeal: async () => ({ result: 'network_error' }) });
  assert.deepEqual(await cancelMealAndDose('srv-meal', b.d), { kind: 'failed', step: 'meal' });
});

test('"unchanged" (already removed, an offline retry) counts as success; a revision the app does not know is omitted', async () => {
  const { d, calls } = deps({
    recentMeals: [],
    recentInsulin: [doseView({ status: 'cancelled' })],
    editMeal: async (id, p) => (calls.push(['meal', id, p]), { result: 'unchanged' }),
  });
  assert.deepEqual(await cancelMealAndDose('srv-meal', d), { kind: 'done' });
  assert.deepEqual(calls, [['meal', 'srv-meal', { status: 'cancelled' }]], 'an already-removed dose is skipped; no revision is invented');
});
