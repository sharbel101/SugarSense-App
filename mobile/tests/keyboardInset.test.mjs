// Run: npm run test:keyboard  (pure module)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { webKeyboardInset } from '../src/services/keyboardInset.ts';

test('keyboard covering the bottom of the layout viewport is the inset (iOS Safari)', () => {
  assert.equal(webKeyboardInset(812, 520, 0), 292);
  // the page was scrolled up by Safari to show the field: offsetTop counts as space above, not covered
  assert.equal(webKeyboardInset(812, 520, 100), 192);
});

test('no keyboard, or only browser chrome, gives 0', () => {
  assert.equal(webKeyboardInset(812, 812, 0), 0);
  assert.equal(webKeyboardInset(812, 760, 0), 0, 'a 52 px URL bar is not a keyboard');
});

test('nonsense input gives 0 rather than NaN', () => {
  assert.equal(webKeyboardInset(Number.NaN, 500, 0), 0);
  assert.equal(webKeyboardInset(800, undefined, 0), 0);
});
