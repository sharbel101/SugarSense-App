import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCaptureStore } from '../src/services/captureStore.ts';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
const tick = () => new Promise((r) => setImmediate(r));

test('begin calls the runner synchronously (the camera must open inside the tap) and shows "opening"', () => {
  let calledSync = false;
  const store = createCaptureStore(() => {
    calledSync = true;
    return deferred().promise;
  });
  store.begin('camera', { returnTab: 'Predict', returnOnCancel: true });
  assert.equal(calledSync, true);
  const s = store.getState();
  assert.equal(s.phase, 'opening');
  assert.equal(s.returnTab, 'Predict');
  assert.equal(s.returnOnCancel, true);
  assert.equal(s.outcome, null);
});

test('a photo outcome is delivered once, then gone; the phase returns to idle', async () => {
  const d = deferred();
  const store = createCaptureStore((source, markProcessing) => {
    assert.equal(source, 'camera');
    markProcessing();
    return d.promise;
  });
  store.begin('camera');
  assert.equal(store.getState().phase, 'processing');
  d.resolve({ kind: 'photo', photo: { uri: 'p' } });
  await tick();
  assert.equal(store.getState().phase, 'idle');
  assert.deepEqual(store.consume(), { kind: 'photo', photo: { uri: 'p' } });
  assert.equal(store.consume(), null, 'second consume gets nothing');
});

test('cancelled and problems: problem is kept for the screen, a later normal result clears it', async () => {
  const outcomes = [{ kind: 'blocked' }, { kind: 'cancelled' }];
  const store = createCaptureStore(() => Promise.resolve(outcomes.shift()));
  store.begin('camera');
  await tick();
  assert.equal(store.getState().problem, 'blocked');
  assert.deepEqual(store.consume(), { kind: 'blocked' });
  assert.equal(store.getState().problem, 'blocked', 'consuming does not hide the reason');
  store.begin('camera');
  assert.equal(store.getState().problem, null, 'a new attempt clears the old reason');
  await tick();
  assert.deepEqual(store.consume(), { kind: 'cancelled' });
  assert.equal(store.getState().problem, null);
});

test('a runner that throws, or rejects, ends as "failed" - never stuck opening', async () => {
  const thrower = createCaptureStore(() => {
    throw new Error('boom');
  });
  thrower.begin('camera');
  assert.equal(thrower.getState().phase, 'idle');
  assert.deepEqual(thrower.consume(), { kind: 'failed' });

  const rejecter = createCaptureStore(() => Promise.reject(new Error('nope')));
  rejecter.begin('gallery');
  await tick();
  assert.equal(rejecter.getState().problem, 'failed');
  assert.deepEqual(rejecter.consume(), { kind: 'failed' });
});

test('a newer attempt wins: the older attempt finishing late is ignored', async () => {
  const first = deferred();
  const second = deferred();
  const queue = [first, second];
  const store = createCaptureStore(() => queue.shift().promise);
  store.begin('camera');
  store.begin('camera');
  second.resolve({ kind: 'photo', photo: { uri: 'new' } });
  await tick();
  first.resolve({ kind: 'photo', photo: { uri: 'old' } });
  await tick();
  assert.deepEqual(store.consume(), { kind: 'photo', photo: { uri: 'new' } });
  assert.equal(store.consume(), null);
});

test('subscribers are told about every change and can unsubscribe', async () => {
  const store = createCaptureStore(() => Promise.resolve({ kind: 'cancelled' }));
  let calls = 0;
  const off = store.subscribe(() => {
    calls += 1;
  });
  store.begin('camera');
  await tick();
  assert.ok(calls >= 2, 'opening + result');
  off();
  const before = calls;
  store.begin('camera');
  await tick();
  assert.equal(calls, before, 'no calls after unsubscribe');
});
