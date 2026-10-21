// Run: npm run test:insights  (node --test --experimental-strip-types; the modules under test are pure)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchInsightsFrom, parseInsightsResponse, stripEvidenceTags, visibleInsights } from '../src/api/insightsContract.ts';
import { deriveInsightsView, INITIAL_INSIGHTS_STATE, reduceInsights } from '../src/services/insightsState.ts';

const NOTICE = 'These insights describe your recorded data. They are not medical advice.';

function raw(over = {}) {
  return {
    id: 'a1',
    category: 'episode_digest',
    headline: 'Time outside your range',
    trigger: 'evening',
    priority: 5.6,
    createdAt: '2026-10-21T18:00:00.000Z',
    expiresAt: '2026-10-22T18:00:00.000Z',
    observationStart: '2026-10-21T00:00:00.000Z',
    observationEnd: '2026-10-21T18:00:00.000Z',
    factsText: ['Today so far: 3 stay(s) above 180 mg/dL [E2] totalling about 185 minutes [E3].'],
    explanation: 'Glucose stayed above range three times.',
    limitations: ['Time without readings is unknown, not assumed in range.'],
    validation: 'valid',
    evidenceRefs: ['E2'],
    evidence: { coverage: 1, facts: [] },
    contentVersion: 1,
    ...over,
  };
}
const okBody = (insights = [raw()], over = {}) => ({ status: 'ok', generatedAt: '2026-10-21T18:00:00.000Z', count: insights.length, notice: NOTICE, insights, ...over });

function res(body, { status = 200, type = 'application/json' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n) => (n.toLowerCase() === 'content-type' ? type : null) },
    json: async () => {
      if (typeof body === 'string') return JSON.parse(body);
      return body;
    },
  };
}
const fetchOf = (r) => async () => r;

test('tag stripping removes [E2] and [E1, E3] and tidies spaces', () => {
  assert.equal(stripEvidenceTags('above 180 mg/dL [E2] totalling about 185 minutes [E3].'), 'above 180 mg/dL totalling about 185 minutes.');
  assert.equal(stripEvidenceTags('Both [E1, E3] agree'), 'Both agree');
  assert.equal(stripEvidenceTags('No tags'), 'No tags');
});

test('ok: several categories keep the received order, facts are stripped, nothing else is changed', () => {
  const p = parseInsightsResponse(
    okBody([raw({ id: 'x' }), raw({ id: 'y', category: 'meal_response', headline: 'After lunch', priority: 9 }), raw({ id: 'z', category: 'data_availability', headline: 'What the data allows' })]),
  );
  assert.equal(p.status, 'ok');
  assert.deepEqual(p.insights.map((i) => i.id), ['x', 'y', 'z']);
  assert.equal(p.insights[0].facts[0], 'Today so far: 3 stay(s) above 180 mg/dL totalling about 185 minutes.');
  assert.equal(p.notice, NOTICE);
  assert.equal(p.generatedAt, '2026-10-21T18:00:00.000Z');
});

test('an unknown category still parses from headline + facts', () => {
  const p = parseInsightsResponse(okBody([raw({ category: 'brand_new_thing' })]));
  assert.equal(p.insights.length, 1);
  assert.equal(p.insights[0].category, 'brand_new_thing');
});

test('explanation null stays null; validation fallback hides the explanation without an error', () => {
  const none = parseInsightsResponse(okBody([raw({ explanation: null })]));
  assert.equal(none.insights[0].explanation, null);
  const fb = parseInsightsResponse(okBody([raw({ validation: 'fallback', explanation: 'should not show' })]));
  assert.equal(fb.insights[0].explanation, null);
  assert.equal(fb.insights[0].validation, 'fallback');
});

test('an insight without factsText or headline is dropped; the others stay', () => {
  const p = parseInsightsResponse(okBody([raw({ id: '1', factsText: [] }), raw({ id: '2', factsText: undefined }), raw({ id: '3', headline: '' }), raw({ id: '4' })]));
  assert.deepEqual(p.insights.map((i) => i.id), ['4']);
});

test('unknown keys are ignored; missing limitations is fine', () => {
  const p = parseInsightsResponse(okBody([{ ...raw(), limitations: undefined, surprise: { a: 1 } }], { extra: true }));
  assert.deepEqual(p.insights[0].limitations, []);
  assert.equal('surprise' in p.insights[0], false);
});

test('long strings are capped', () => {
  const p = parseInsightsResponse(okBody([raw({ headline: 'h'.repeat(5000), factsText: ['f'.repeat(5000)] })]));
  assert.ok(p.insights[0].headline.length <= 200);
  assert.ok(p.insights[0].facts[0].length <= 1200);
});

test('empty: both reasons; an unknown reason falls back to not_generated_yet', () => {
  const a = parseInsightsResponse({ status: 'empty', reason: 'not_generated_yet', lastRunAt: null, insights: [], notice: NOTICE });
  assert.deepEqual([a.status, a.reason, a.lastRunAt], ['empty', 'not_generated_yet', null]);
  const b = parseInsightsResponse({ status: 'empty', reason: 'none_active', lastRunAt: '2026-10-21T08:00:00.000Z', insights: [], notice: NOTICE });
  assert.deepEqual([b.reason, b.lastRunAt], ['none_active', '2026-10-21T08:00:00.000Z']);
});

test('wrong status or non-object body is not recognised', () => {
  assert.equal(parseInsightsResponse({ status: 'weird' }), null);
  assert.equal(parseInsightsResponse('<html>'), null);
  assert.equal(parseInsightsResponse(null), null);
  assert.equal(parseInsightsResponse({ status: 'ok' }), null);
});

test('fetch: ok and empty', async () => {
  const ok = await fetchInsightsFrom('', undefined, fetchOf(res(okBody())));
  assert.equal(ok.kind, 'ok');
  const empty = await fetchInsightsFrom('', undefined, fetchOf(res({ status: 'empty', reason: 'none_active', lastRunAt: null, insights: [] })));
  assert.equal(empty.kind, 'empty');
});

test('fetch: limit is echoed in the URL and the headers are passed through', async () => {
  let seen;
  await fetchInsightsFrom('https://x.test', undefined, async (url, init) => {
    seen = { url, init };
    return res(okBody());
  }, { 'X-App-Token': 't' });
  assert.equal(seen.url, 'https://x.test/insights?limit=5');
  assert.equal(seen.init.headers['X-App-Token'], 't');
  assert.equal(seen.init.headers.Accept, 'application/json');
});

test('fetch: 503, 404, a 200 HTML page, invalid JSON and an unknown status are all unavailable', async () => {
  assert.equal((await fetchInsightsFrom('', undefined, fetchOf(res({ status: 'unavailable', reason: 'x' }, { status: 503 })))).kind, 'unavailable');
  assert.equal((await fetchInsightsFrom('', undefined, fetchOf(res('nope', { status: 404 })))).kind, 'unavailable');
  assert.equal((await fetchInsightsFrom('', undefined, fetchOf(res('<!doctype html>', { type: 'text/html' })))).kind, 'unavailable');
  assert.equal((await fetchInsightsFrom('', undefined, fetchOf(res('{not json')))).kind, 'unavailable');
  assert.equal((await fetchInsightsFrom('', undefined, fetchOf(res({ status: 'surprise' })))).kind, 'unavailable');
  assert.equal((await fetchInsightsFrom('', undefined, fetchOf(res({ status: 'unavailable', reason: 'x' })))).kind, 'unavailable');
});

test('fetch: a network failure is an error, never a throw; an abort is reported as aborted', async () => {
  const net = await fetchInsightsFrom('', undefined, async () => {
    throw new TypeError('failed');
  });
  assert.deepEqual(net, { kind: 'error', cause: 'network' });
  const c = new AbortController();
  c.abort();
  const ab = await fetchInsightsFrom('', c.signal, async (_u, init) => {
    if (init.signal.aborted) throw new Error('aborted');
    return res(okBody());
  });
  assert.deepEqual(ab, { kind: 'error', cause: 'aborted' });
});

test('expired insights are hidden on the device, order kept', () => {
  const now = Date.parse('2026-10-22T00:00:00Z');
  const p = parseInsightsResponse(
    okBody([raw({ id: 'old', expiresAt: '2026-10-21T20:00:00.000Z' }), raw({ id: 'new', expiresAt: '2026-10-22T06:00:00.000Z' }), raw({ id: 'none', expiresAt: null })]),
  );
  assert.deepEqual(visibleInsights(p.insights, now).map((i) => i.id), ['new', 'none']);
});

test('state: loading until the first fetch settles; failures with nothing cached are unavailable / offline', () => {
  assert.equal(deriveInsightsView(INITIAL_INSIGHTS_STATE, 0).kind, 'loading');
  assert.equal(deriveInsightsView(reduceInsights(INITIAL_INSIGHTS_STATE, { kind: 'unavailable' }, 1), 1).kind, 'unavailable');
  assert.equal(deriveInsightsView(reduceInsights(INITIAL_INSIGHTS_STATE, { kind: 'error', cause: 'network' }, 1), 1).kind, 'offline');
  assert.equal(reduceInsights(INITIAL_INSIGHTS_STATE, { kind: 'error', cause: 'aborted' }, 1), INITIAL_INSIGHTS_STATE);
});

test('state: a failed refresh keeps the last good insights and flags it', () => {
  const ok = parseInsightsResponse(okBody());
  const s1 = reduceInsights(INITIAL_INSIGHTS_STATE, { kind: 'ok', response: ok }, 1000);
  const s2 = reduceInsights(s1, { kind: 'error', cause: 'timeout' }, 2000);
  const v = deriveInsightsView(s2, Date.parse('2026-10-21T19:00:00Z'));
  assert.equal(v.kind, 'ok');
  assert.equal(v.refreshFailed, true);
  assert.equal(v.insights.length, 1);
  const s3 = reduceInsights(s2, { kind: 'ok', response: ok }, 3000);
  assert.equal(deriveInsightsView(s3, Date.parse('2026-10-21T19:00:00Z')).refreshFailed, false);
});

test('state: when every cached insight has expired the view is the "none active" empty state', () => {
  const ok = parseInsightsResponse(okBody([raw({ expiresAt: '2026-10-21T19:00:00.000Z' })]));
  const s = reduceInsights(INITIAL_INSIGHTS_STATE, { kind: 'ok', response: ok }, 1);
  const v = deriveInsightsView(s, Date.parse('2026-10-21T20:00:00Z'));
  assert.deepEqual([v.kind, v.reason], ['empty', 'none_active']);
});
