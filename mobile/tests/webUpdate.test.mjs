// Run: npm run test:update  (node --test --experimental-strip-types; the module under test is pure at import)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bundlePathFromHtml, shouldReload, startWebUpdateWatcher } from '../src/services/webUpdate.ts';

const HTML = (name) =>
  `<!DOCTYPE html><html><head><title>SugarSense</title></head><body><div id="root"></div>` +
  `<script src="/_expo/static/js/web/${name}" defer></script></body></html>`;

test('reads the bundle path out of an exported index.html', () => {
  assert.equal(bundlePathFromHtml(HTML('index-a139bfca10d1148c4cdaac651b738052.js')),
    '/_expo/static/js/web/index-a139bfca10d1148c4cdaac651b738052.js');
});

test('returns null when the page has no exported bundle (dev server, error page)', () => {
  assert.equal(bundlePathFromHtml('<script src="/node_modules/expo/AppEntry.bundle?platform=web"></script>'), null);
  assert.equal(bundlePathFromHtml('<html>502 Bad Gateway</html>'), null);
  assert.equal(bundlePathFromHtml(''), null);
});

test('reloads when a different bundle is live', () => {
  assert.equal(shouldReload('/_expo/static/js/web/index-old.js', '/_expo/static/js/web/index-new.js', null), true);
});

test('does not reload when the bundle is the same', () => {
  const p = '/_expo/static/js/web/index-same.js';
  assert.equal(shouldReload(p, p, null), false);
});

test('never loops: no second reload for a target we already reloaded for', () => {
  const cur = '/_expo/static/js/web/index-old.js';
  const next = '/_expo/static/js/web/index-new.js';
  assert.equal(shouldReload(cur, next, next), false);
  // ...but a still-newer build later is picked up.
  assert.equal(shouldReload(cur, '/_expo/static/js/web/index-newer.js', next), true);
});

test('does nothing when either side is unknown', () => {
  assert.equal(shouldReload(null, '/_expo/static/js/web/index-new.js', null), false);
  assert.equal(shouldReload('/_expo/static/js/web/index-old.js', null, null), false);
});

test('the watcher is a harmless no-op outside a browser', () => {
  const stop = startWebUpdateWatcher();
  assert.equal(typeof stop, 'function');
  stop();
});
