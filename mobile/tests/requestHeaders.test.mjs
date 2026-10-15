// Run: npm run test:headers  (node --test --experimental-strip-types; the modules under test are pure)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchGlucoseFrom } from '../src/api/glucoseContract.ts';
import { ngrokBypassHeaders } from '../src/api/requestHeaders.ts';

test('sends the ngrok bypass header only for ngrok base URLs', () => {
  const want = { 'ngrok-skip-browser-warning': 'true' };
  assert.deepEqual(ngrokBypassHeaders('https://entitle-evacuate-removed.ngrok-free.dev'), want);
  assert.deepEqual(ngrokBypassHeaders('https://abc123.ngrok.io'), want);
  assert.deepEqual(ngrokBypassHeaders('https://abc123.ngrok.app/'), want);
});

test('adds nothing for same-origin, localhost, LAN or an ordinary host', () => {
  assert.deepEqual(ngrokBypassHeaders(''), {});
  assert.deepEqual(ngrokBypassHeaders('http://localhost:3000'), {});
  assert.deepEqual(ngrokBypassHeaders('http://192.168.10.30:3000'), {});
  assert.deepEqual(ngrokBypassHeaders('https://api.sugarsense.example'), {});
});

test('glucose client forwards extra headers, keeps Accept, and still sends no credentials', async () => {
  let seen;
  const impl = async (url, init) => {
    seen = { url, init };
    return { ok: false, status: 500, json: async () => ({}) };
  };
  await fetchGlucoseFrom('https://x.ngrok-free.dev', undefined, impl, ngrokBypassHeaders('https://x.ngrok-free.dev'));
  assert.equal(seen.url, 'https://x.ngrok-free.dev/glucose');
  assert.equal(seen.init.headers.Accept, 'application/json');
  assert.equal(seen.init.headers['ngrok-skip-browser-warning'], 'true');
  assert.equal('Authorization' in seen.init.headers, false);
});

test('glucose client sends only Accept when no extra headers are given', async () => {
  let seen;
  await fetchGlucoseFrom('', undefined, async (url, init) => {
    seen = init;
    return { ok: false, status: 500, json: async () => ({}) };
  });
  assert.deepEqual(Object.keys(seen.headers), ['Accept']);
});
