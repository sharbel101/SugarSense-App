// Run: npm run test:pull  (node --test --experimental-strip-types; the module under test is pure)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PULL_IDLE,
  PULL_MAX,
  PULL_TRIGGER,
  pullEnd,
  pullMove,
  pullProgress,
  pullStart,
} from '../src/services/pullToRefresh.ts';

test('only arms when the list is at the top', () => {
  assert.equal(pullStart(0, 200).phase, 'pulling');
  // iOS rubber-band reports a negative scrollTop while overscrolled.
  assert.equal(pullStart(-12, 200).phase, 'pulling');
  assert.deepEqual(pullStart(1, 200), PULL_IDLE);
  assert.deepEqual(pullStart(340, 200), PULL_IDLE);
});

test('a pull past the threshold triggers on release', () => {
  let s = pullStart(0, 100);
  s = pullMove(s, 0, 100 + PULL_TRIGGER * 2 + 10); // damping is 0.5
  assert.ok(s.distance >= PULL_TRIGGER);
  const { next, trigger } = pullEnd(s);
  assert.equal(trigger, true);
  assert.deepEqual(next, PULL_IDLE);
});

test('a short pull does not trigger', () => {
  let s = pullStart(0, 100);
  s = pullMove(s, 0, 100 + 40); // 20 after damping
  assert.ok(s.distance < PULL_TRIGGER);
  assert.equal(pullEnd(s).trigger, false);
});

test('a plain tap (no movement) never triggers', () => {
  const s = pullStart(0, 100);
  assert.equal(pullEnd(s).trigger, false);
});

test('pull distance is damped and capped', () => {
  let s = pullStart(0, 0);
  s = pullMove(s, 0, 100);
  assert.equal(s.distance, 50);
  s = pullMove(s, 0, 10_000);
  assert.equal(s.distance, PULL_MAX);
});

test('scrolling away from the top disarms the gesture, even after a long drag', () => {
  let s = pullStart(0, 100);
  s = pullMove(s, 0, 400);
  s = pullMove(s, 25, 420); // list scrolled: this is a normal scroll now
  assert.deepEqual(s, PULL_IDLE);
  assert.equal(pullEnd(s).trigger, false);
});

test('moving back above the start reads as zero pull and can re-arm', () => {
  let s = pullStart(0, 300);
  s = pullMove(s, 0, 250);
  assert.equal(s.phase, 'pulling');
  assert.equal(s.distance, 0);
  s = pullMove(s, 0, 300 + PULL_TRIGGER * 2);
  assert.ok(s.distance >= PULL_TRIGGER);
});

test('a cancelled gesture never triggers', () => {
  let s = pullStart(0, 0);
  s = pullMove(s, 0, 1000);
  assert.equal(pullEnd(s, true).trigger, false);
});

test('progress runs 0..1 and clamps', () => {
  assert.equal(pullProgress(PULL_IDLE), 0);
  let s = pullStart(0, 0);
  assert.equal(pullProgress(s), 0);
  s = pullMove(s, 0, PULL_TRIGGER); // half the threshold after damping
  assert.equal(pullProgress(s), 0.5);
  s = pullMove(s, 0, 10_000);
  assert.equal(pullProgress(s), 1);
});

test('move before start is ignored', () => {
  assert.deepEqual(pullMove(PULL_IDLE, 0, 500), PULL_IDLE);
});
