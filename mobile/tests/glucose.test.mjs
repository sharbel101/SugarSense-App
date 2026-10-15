// Run: npm run test:glucose  (node --test --experimental-strip-types; the modules under test are pure)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchGlucoseFrom, parseGlucoseResponse } from '../src/api/glucoseContract.ts';
import {
  deriveGlucoseView,
  formatAge,
  INITIAL_GLUCOSE_STATE,
  reduceGlucose,
  STALE_MINUTES,
} from '../src/services/glucoseState.ts';
import { buildGlucoseChart } from '../src/services/glucoseChart.ts';
import { summariseRisk } from '../src/services/glucoseRisk.ts';

const T0 = Date.parse('2026-10-15T10:00:00Z');
const iso = (offsetMin) => new Date(T0 + offsetMin * 60000).toISOString();

function okBody(over = {}) {
  const history = [];
  for (let m = -60; m < 0; m += 5) history.push({ time: iso(m), value: 120 + m / 10 });
  const predictions = [];
  for (let m = 5; m <= 120; m += 5) predictions.push({ time: iso(m), value: 130 + m / 4 });
  return {
    status: 'ok',
    glucoseMgdl: 126,
    measuredAt: iso(0),
    ageMinutes: 3,
    history,
    predictions,
    forecastAvailable: true,
    forecastUnavailableReason: null,
    low: { alert: false, alreadyLow: false, headline: null },
    high: { alert: false, alreadyHigh: false, headline: null },
    ranges: [
      { minutes: 15, low: 118, high: 138, forecast: 128 },
      { minutes: 30, low: 112, high: 146, forecast: 130 },
      { minutes: 45, low: 105, high: 156, forecast: 133 },
    ],
    rangesAreShadow: true,
    modelVersion: 'v1',
    generatedAt: iso(0),
    ...over,
  };
}

const okResponse = (over) => ({ kind: 'response', response: parseGlucoseResponse(okBody(over)) });

// ---- contract / shape check -------------------------------------------------------------------

test('parse: valid ok body keeps values and counts', () => {
  const r = parseGlucoseResponse(okBody());
  assert.equal(r.status, 'ok');
  assert.equal(r.glucoseMgdl, 126);
  assert.equal(r.predictions.length, 24);
  assert.equal(r.ranges.length, 3);
  assert.equal(r.rangesAreShadow, true);
});

test('parse: stale and unavailable carry no glucose field', () => {
  const s = parseGlucoseResponse({ status: 'stale', reason: 'old', lastMeasuredAt: iso(-30), glucoseMgdl: 100 });
  assert.equal(s.status, 'stale');
  assert.equal('glucoseMgdl' in s, false);
  const u = parseGlucoseResponse({ status: 'unavailable', reason: 'down', glucoseMgdl: 100 });
  assert.equal(u.status, 'unavailable');
  assert.equal('glucoseMgdl' in u, false);
});

test('parse: rejects drift instead of repairing it', () => {
  assert.equal(parseGlucoseResponse(null), null);
  assert.equal(parseGlucoseResponse({ status: 'weird' }), null);
  assert.equal(parseGlucoseResponse(okBody({ glucoseMgdl: 15 })), null);
  assert.equal(parseGlucoseResponse(okBody({ glucoseMgdl: 700 })), null);
  assert.equal(parseGlucoseResponse(okBody({ glucoseMgdl: '126' })), null);
  assert.equal(parseGlucoseResponse(okBody({ measuredAt: 'yesterday' })), null);
  assert.equal(parseGlucoseResponse(okBody({ history: undefined })), null);
  assert.equal(parseGlucoseResponse(okBody({ ageMinutes: -1 })), null);
});

test('parse: forecastAvailable with no points is reported unavailable, with no band', () => {
  const r = parseGlucoseResponse(okBody({ predictions: [] }));
  assert.equal(r.forecastAvailable, false);
  assert.equal(r.ranges, null);
});

test('parse: null risk stays null, never false; bad ranges dropped; null ranges stay null', () => {
  const r = parseGlucoseResponse(
    okBody({
      low: { alert: null },
      high: undefined,
      ranges: [
        { minutes: 15, low: 150, high: 100, forecast: 120 },
        { minutes: 20, low: 1, high: 2, forecast: 1 },
        { minutes: 30, low: 100, high: 120, forecast: 110 },
      ],
    }),
  );
  assert.equal(r.low.alert, null);
  assert.equal(r.high.alert, null);
  assert.deepEqual(
    r.ranges.map((x) => x.minutes),
    [30],
  );
  assert.equal(parseGlucoseResponse(okBody({ ranges: null })).ranges, null);
});

// ---- client -----------------------------------------------------------------------------------

const jsonRes = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('client: GET <base>/glucose, no auth header, parses ok', async () => {
  let seen;
  const out = await fetchGlucoseFrom('', undefined, async (url, init) => {
    seen = { url, init };
    return jsonRes(okBody());
  });
  assert.equal(seen.url, '/glucose');
  assert.equal(seen.init.method, 'GET');
  assert.equal('Authorization' in seen.init.headers, false);
  assert.equal(out.kind, 'response');
  assert.equal(out.response.status, 'ok');
});

test('client: failures become error outcomes, never numbers', async () => {
  const badJson = async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new Error('x');
    },
  });
  const cases = [
    [async () => jsonRes({}, 500), 'bad_status'],
    [badJson, 'invalid_body'],
    [async () => jsonRes({ nope: 1 }), 'invalid_body'],
    [
      async () => {
        throw new TypeError('network');
      },
      'network',
    ],
  ];
  for (const [impl, cause] of cases) {
    const out = await fetchGlucoseFrom('http://x', undefined, impl);
    assert.deepEqual(out, { kind: 'error', cause });
  }
});

test('client: abort is reported as aborted', async () => {
  const ac = new AbortController();
  const p = fetchGlucoseFrom(
    '',
    ac.signal,
    (_u, init) => new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(new Error('abort')))),
  );
  ac.abort();
  assert.deepEqual(await p, { kind: 'error', cause: 'aborted' });
});

// ---- state mapping ----------------------------------------------------------------------------

test('state: loading only before the first fetch', () => {
  assert.equal(deriveGlucoseView(INITIAL_GLUCOSE_STATE, T0).kind, 'loading');
  const s = reduceGlucose(INITIAL_GLUCOSE_STATE, { kind: 'error', cause: 'network' }, T0);
  assert.equal(deriveGlucoseView(s, T0).kind, 'unavailable');
});

test('state: ok shows the value; age = server age + elapsed, never fresher', () => {
  const s = reduceGlucose(INITIAL_GLUCOSE_STATE, okResponse(), T0);
  let v = deriveGlucoseView(s, T0);
  assert.equal(v.kind, 'ok');
  assert.equal(v.ageMinutes, 3);
  v = deriveGlucoseView(s, T0 + 4 * 60000 + 1000);
  assert.equal(v.ageMinutes, 3 + 5);
});

test('state: refresh failure keeps last good data (flagged) until it is too old', () => {
  let s = reduceGlucose(INITIAL_GLUCOSE_STATE, okResponse(), T0);
  s = reduceGlucose(s, { kind: 'error', cause: 'timeout' }, T0 + 60000);
  let v = deriveGlucoseView(s, T0 + 60000);
  assert.equal(v.kind, 'ok');
  assert.equal(v.refreshFailed, true);
  // age 3 + 17 = 20 -> still shown; 21 -> stale, no data
  v = deriveGlucoseView(s, T0 + (STALE_MINUTES - 3) * 60000);
  assert.equal(v.kind, 'ok');
  v = deriveGlucoseView(s, T0 + (STALE_MINUTES - 2) * 60000);
  assert.equal(v.kind, 'stale');
  assert.equal('data' in v, false);
  assert.equal(v.lastMeasuredAt, iso(0));
});

test('state: server stale drops numbers immediately; server unavailable keeps an in-date reading', () => {
  let s = reduceGlucose(INITIAL_GLUCOSE_STATE, okResponse(), T0);
  const staleS = reduceGlucose(
    s,
    { kind: 'response', response: { status: 'stale', reason: 'old', lastMeasuredAt: iso(-25) } },
    T0 + 1000,
  );
  const v = deriveGlucoseView(staleS, T0 + 1000);
  assert.equal(v.kind, 'stale');
  assert.equal(v.lastMeasuredAt, iso(-25));
  assert.equal(staleS.good, null);

  s = reduceGlucose(s, { kind: 'response', response: { status: 'unavailable', reason: 'down' } }, T0 + 1000);
  assert.equal(deriveGlucoseView(s, T0 + 1000).kind, 'ok');
});

test('state: aborted outcomes change nothing; a later ok clears the problem', () => {
  let s = reduceGlucose(INITIAL_GLUCOSE_STATE, { kind: 'error', cause: 'network' }, T0);
  assert.equal(reduceGlucose(s, { kind: 'error', cause: 'aborted' }, T0), s);
  s = reduceGlucose(s, okResponse(), T0 + 1000);
  const v = deriveGlucoseView(s, T0 + 1000);
  assert.equal(v.kind, 'ok');
  assert.equal(v.refreshFailed, false);
});

test('formatAge', () => {
  assert.equal(formatAge(0), 'just now');
  assert.equal(formatAge(5), '5 min ago');
  assert.equal(formatAge(65), '1 h 5 min ago');
});

// ---- chart model ------------------------------------------------------------------------------

test('chart: x is real time, y is mg/dL, band only from ranges', () => {
  const data = parseGlucoseResponse(okBody());
  const c = buildGlucoseChart(data);
  // history 60 min before + 120 min forecast = 180 min span (first history point is at -60); latest at 1/3
  assert.ok(Math.abs(c.nowX - c.viewBoxWidth / 3) < 0.01);
  for (const line of [c.actual, c.predicted]) {
    for (let i = 1; i < line.length; i++) assert.ok(line[i].x >= line[i - 1].x);
  }
  // higher glucose is higher on screen (smaller y)
  const last = c.predicted[c.predicted.length - 1];
  assert.ok(last.y < c.actual[c.actual.length - 1].y);
  assert.equal(c.hasBand, true);
  // band closes at the latest reading and reaches +45 min
  assert.deepEqual(c.band[0], c.band[c.band.length - 1]);
  const maxBandX = Math.max(...c.band.map((p) => p.x));
  assert.ok(Math.abs(maxBandX - (c.nowX + (45 / 180) * c.viewBoxWidth)) < 0.01);
  // domain covers every value
  assert.ok(c.yMinMgdl <= 105 && c.yMaxMgdl >= 156);
  assert.deepEqual(
    c.xTicks.map((t) => t.label),
    ['-60m', 'Latest', '+60m', '+120m'],
  );
});

test('chart: no ranges -> no band; no forecast -> no predicted line, latest at the right edge', () => {
  const noRanges = buildGlucoseChart(parseGlucoseResponse(okBody({ ranges: null })));
  assert.equal(noRanges.band, undefined);
  assert.equal(noRanges.hasBand, false);
  assert.ok(noRanges.predicted.length > 0);

  const noForecast = buildGlucoseChart(parseGlucoseResponse(okBody({ forecastAvailable: false, predictions: [] })));
  assert.equal(noForecast.predicted.length, 0);
  assert.equal(noForecast.band, undefined);
  assert.ok(Math.abs(noForecast.nowX - noForecast.viewBoxWidth) < 0.01);
});

// ---- risk copy --------------------------------------------------------------------------------

test('risk: null is not reassurance; alert passes headline through; already is stated', () => {
  const nulls = summariseRisk(parseGlucoseResponse(okBody({ low: {}, high: {} })));
  assert.equal(nulls.alerting, false);
  assert.match(nulls.lines[0], /not supplied/);
  assert.doesNotMatch(nulls.lines.join(' '), /low risk|safe|normal/i);

  const alert = summariseRisk(
    parseGlucoseResponse(okBody({ low: { alert: true, alreadyLow: false, headline: 'Glucose may fall below 70 soon' } })),
  );
  assert.equal(alert.alerting, true);
  assert.equal(alert.lines[0], 'Glucose may fall below 70 soon');

  const already = summariseRisk(parseGlucoseResponse(okBody({ low: { alert: false, alreadyLow: true } })));
  assert.equal(already.alerting, true);
  assert.equal(already.lines[0], 'Glucose is already low.');
});
