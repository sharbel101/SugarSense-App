import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recentAfterRefresh, recentWhileRefreshing } from '../src/services/recentState.ts';

const OLD = { kind: 'ok', meals: [{ id: 'old' }], insulin: [] };
const NEW = { kind: 'ok', meals: [{ id: 'old' }, { id: 'new' }], insulin: [{ id: 'dose' }] };

test('while refreshing: a list already on screen stays; with none yet it says loading', () => {
  assert.equal(recentWhileRefreshing(OLD), OLD, 'no flash of "Loading..." over an existing list');
  assert.deepEqual(recentWhileRefreshing({ kind: 'idle' }), { kind: 'loading' });
  assert.deepEqual(recentWhileRefreshing({ kind: 'unavailable' }), { kind: 'loading' });
  assert.deepEqual(recentWhileRefreshing({ kind: 'loading' }), { kind: 'loading' });
});

test('after a good answer the new list replaces the old one (the fix: new entries appear)', () => {
  assert.equal(recentAfterRefresh(OLD, NEW), NEW);
  assert.equal(recentAfterRefresh({ kind: 'loading' }, NEW), NEW);
});

test('after a failed answer the last good list is kept; with none, it is "unavailable"', () => {
  assert.equal(recentAfterRefresh(OLD, { kind: 'unavailable' }), OLD);
  assert.deepEqual(recentAfterRefresh({ kind: 'loading' }, { kind: 'unavailable' }), { kind: 'unavailable' });
  assert.deepEqual(recentAfterRefresh({ kind: 'idle' }, { kind: 'unavailable' }), { kind: 'unavailable' });
});
