// Run: npm run test:garmin  (TZ is pinned to Lebanon so the DST test is meaningful on any machine)
process.env.TZ = 'Asia/Beirut';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchHistory, fetchLatest, fetchStatus, garminErrorText, parseLatest } from '../src/api/garminContract.ts';
import { buildWearableFromGarmin, syncNotice } from '../src/services/garminAdapter.ts';
import { loadGarmin } from '../src/services/garminLoad.ts';
import { formatTime12 } from '../src/services/clock12.ts';
import { freshnessOf, summaryOf } from '../src/services/wearableModel.ts';

const NOW = Date.parse('2026-10-21T12:00:00Z');
const iso = (offsetMin) => new Date(NOW + offsetMin * 60000).toISOString();

const entry = (value, over = {}) => ({ value, unit: 'bpm', kind: 'instant', origin: 'raw_sensor', measured_at: iso(-4), ts_semantics: 'instant', fetched_at: iso(-1), age_seconds: 240, fetched_age_seconds: 60, quality: 'available', ...over });
const latestBody = (metrics = { heart_rate: entry(72) }, over = {}) => ({ source: 'garmin', generated_at: iso(0), last_successful_fetch_at: iso(-2), metrics, data_freshness: 'fresh', missing_metrics: [], warnings: [], ...over });
const statusBody = (over = {}) => ({ polling: { enabled: true, state: 'normal', paused_reason: null }, last_successful_poll_at: iso(-2), groups: { fast: { last_successful_fetch_at: iso(-2), last_measurement_at: iso(-4), stale: false } }, data_stale: false, ...over });

function res(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
/** A fake fetch that answers from a queue (or a function) and records every call. */
function fake(answers) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const a = typeof answers === 'function' ? answers(url, calls.length) : answers[Math.min(calls.length - 1, answers.length - 1)];
    if (a instanceof Error) throw a;
    return a;
  };
  return { impl, calls };
}
const cfg = (f, over = {}) => ({ baseUrl: 'https://h.test/api/garmin/v1', token: 'tok', fetchImpl: f.impl, sleep: async () => {}, ...over });

test('client: success sends the token header and parses latest; absent metrics stay absent', async () => {
  const f = fake([res(latestBody({ heart_rate: entry(72) }, { missing_metrics: ['stress_level'] }))]);
  const r = await fetchLatest(cfg(f, { extraHeaders: { 'ngrok-skip-browser-warning': '1' } }));
  assert.equal(r.ok, true);
  assert.equal(r.data.metrics.heart_rate.value, 72);
  assert.equal(r.data.metrics.stress_level, undefined, 'a missing metric is absent, never 0');
  assert.deepEqual(r.data.missingMetrics, ['stress_level']);
  assert.equal(f.calls[0].init.headers['x-app-token'], 'tok');
  assert.equal(f.calls[0].init.headers['ngrok-skip-browser-warning'], '1');
  assert.equal(f.calls[0].url, 'https://h.test/api/garmin/v1/metrics/latest');
});

test('client: 401 maps to unauthorized and is NOT retried', async () => {
  const f = fake([res({ error: { code: 'unauthorized', message: 'x' } }, 401)]);
  const r = await fetchLatest(cfg(f));
  assert.deepEqual([r.ok, r.error, r.status], [false, 'unauthorized', 401]);
  assert.equal(f.calls.length, 1);
  assert.match(garminErrorText('unauthorized'), /not authorised/);
});

test('client: 503 is retried once then reported; a 503 followed by 200 succeeds', async () => {
  const f = fake([res({ error: { code: 'storage_unavailable', message: 'x' } }, 503)]);
  const r = await fetchLatest(cfg(f));
  assert.deepEqual([r.ok, r.error, r.code], [false, 'unavailable', 'storage_unavailable']);
  assert.equal(f.calls.length, 2, 'exactly one retry');
  const g = fake([res({}, 503), res(latestBody())]);
  assert.equal((await fetchLatest(cfg(g))).ok, true);
  assert.equal(g.calls.length, 2);
});

test('client: 429 is rate_limited without a retry; 500 is a server error', async () => {
  const f = fake([res({}, 429)]);
  assert.equal((await fetchLatest(cfg(f))).error, 'rate_limited');
  assert.equal(f.calls.length, 1);
  assert.equal((await fetchLatest(cfg(fake([res({}, 500)])))).error, 'server');
});

test('client: a network error is retried once, then reported as network', async () => {
  const f = fake([new TypeError('failed')]);
  const r = await fetchLatest(cfg(f));
  assert.equal(r.error, 'network');
  assert.equal(f.calls.length, 2);
});

test('client: a hanging request times out (no retry) and is reported as timeout', async () => {
  const calls = [];
  const impl = (_url, init) => {
    calls.push(1);
    return new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))));
  };
  const r = await fetchLatest({ baseUrl: 'https://h.test', token: 't', fetchImpl: impl, timeoutMs: 20, sleep: async () => {} });
  assert.equal(r.error, 'timeout');
  assert.equal(calls.length, 1);
});

test('client: no token = not_configured without any request; an outer abort is reported as aborted', async () => {
  const f = fake([res(latestBody())]);
  assert.equal((await fetchLatest(cfg(f, { token: null }))).error, 'not_configured');
  assert.equal(f.calls.length, 0);
  const c = new AbortController();
  c.abort();
  assert.equal((await fetchLatest(cfg(fake([res(latestBody())])), c.signal)).error, 'aborted');
});

test('client: a malformed body is bad_body; bad entries are dropped, good ones kept', async () => {
  assert.equal((await fetchLatest(cfg(fake([res({ nope: 1 })])))).error, 'bad_body');
  const p = parseLatest(latestBody({ heart_rate: entry(72), broken: { value: 'x' }, neg: entry(5, { age_seconds: -1 }) }));
  assert.deepEqual(Object.keys(p.metrics), ['heart_rate']);
  assert.equal((await fetchStatus(cfg(fake([res(statusBody())])))).data.pollingState, 'normal');
});

test('history: follows next_cursor across pages, oldest first, and reports truncation at the page cap', async () => {
  const page = (n, more) => res({ count: 1, limit: 1, has_more: more, next_cursor: more ? `c${n}` : null, observations: [{ metric: 'heart_rate', value: 60 + n, unit: 'bpm', kind: 'instant', origin: 'raw_sensor', measured_at: iso(-100 + n) }] });
  const f = fake((url) => (url.includes('cursor=c2') ? page(3, false) : url.includes('cursor=c1') ? page(2, true) : page(1, true)));
  const r = await fetchHistory(cfg(f), { metrics: ['heart_rate'], from: iso(-200), to: iso(0) });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.observations.map((o) => o.value), [61, 62, 63]);
  assert.equal(r.data.truncated, false);
  assert.match(f.calls[0].url, /metrics=heart_rate&from=.*&to=.*&limit=500/);
  const g = fake(() => page(1, true));
  const t = await fetchHistory(cfg(g), { metrics: ['heart_rate'], from: iso(-200), to: iso(0), maxPages: 2 });
  assert.equal(t.data.truncated, true);
  assert.equal(g.calls.length, 2);
});

/* ------------------------------------------------------------------ adapter */

const obs = (metric, value, t, over = {}) => ({ metric, value, unit: null, kind: 'instant', origin: 'raw_sensor', measuredAt: new Date(t).toISOString(), details: null, ...over });
function snapshot(over = {}) {
  const latest = parseLatest(
    latestBody({
      heart_rate: entry(72),
      steps_day_cumulative: entry(5000, { unit: 'steps', kind: 'cumulative', measured_at: iso(-3) }),
      sleep_duration: entry(27000, { unit: 's', kind: 'daily_summary', origin: 'garmin_derived', measured_at: iso(-300) }),
      sleep_score: entry(81, { origin: 'garmin_derived', measured_at: iso(-300) }),
      sleep_stages: entry({ deep_sleep_seconds: 4800, light_sleep_seconds: 15000, rem_sleep_seconds: 5400, awake_seconds: 1800, awake_count: 3 }, { unit: null, origin: 'garmin_derived', measured_at: iso(-300) }),
      stress_level: entry(31, { origin: 'garmin_derived' }),
    }),
  );
  return { latest, status: parseStatus(), heartRate: [], stepsToday: [], stressBattery: [], daily: [], exercises: [], ...over };
}
function parseStatus() {
  return { pollingState: 'normal', pausedReason: null, groups: { fast: { lastSuccessfulFetchAt: iso(-2), lastMeasurementAt: iso(-4), stale: false } }, dataStale: false };
}

test('cumulative steps are never summed: one value per day (the last row), latest = the current total', () => {
  const day = Date.parse('2026-10-20T09:00:00');
  const rows = [1000, 3000, 6000].map((v, i) => obs('steps_day_cumulative', v, day + i * 3_600_000, { kind: 'cumulative' }));
  const d = buildWearableFromGarmin(snapshot({ daily: rows }), NOW);
  const steps = d.series.steps;
  assert.equal(steps.length, 2, 'yesterday (last row) and today (latest)');
  assert.equal(steps[0].v, 6000, 'not 10000');
  assert.equal(steps[steps.length - 1].v, 5000);
  assert.equal(summaryOf(d, 'steps', NOW).latest.v, 5000);
});

test('interval steps become bars (counts), and are not turned into a total', () => {
  const t0 = Date.parse('2026-10-21T08:00:00');
  const rows = [120, 80, 0, 45].map((v, i) => obs('steps_interval', v, t0 + i * 15 * 60_000, { kind: 'interval' }));
  const d = buildWearableFromGarmin(snapshot({ stepsToday: rows }), NOW);
  assert.deepEqual(d.stepBars.map((s) => s.v), [120, 80, 0, 45]);
  assert.equal(d.stepsSlotMs, 15 * 60_000);
  assert.equal(d.series.steps[d.series.steps.length - 1].v, 5000);
});

test('sleep: seconds become minutes, stages are read, score kept; vendor-derived values are flagged', () => {
  const d = buildWearableFromGarmin(snapshot(), NOW);
  assert.equal(d.series.sleep[0].v, 450);
  assert.deepEqual(d.lastNight, { totalMin: 450, deepMin: 80, remMin: 90, lightMin: 250, awakeMin: 30 });
  assert.equal(d.sleepScore, 81);
  assert.equal(d.derived.sleep, true);
  assert.equal(d.derived.stress, true);
  assert.equal(d.derived.heartRate, false, 'raw sensor value is not "calculated by Garmin"');
  assert.equal(d.isDemo, false);
  assert.equal(d.series.skinTemp, undefined, 'unsupported metric stays absent');
  assert.equal(d.series.battery, undefined);
});

test('exercise sessions are read tolerantly (missing fields are fine)', () => {
  const ex = [
    obs('exercise_session', 1800, NOW - 3_600_000, { kind: 'event', details: { type: 'running', distance_m: 5200, avg_hr: 148 } }),
    obs('exercise_session', 600, NOW - 7_200_000, { kind: 'event' }),
    obs('exercise_session', 0, NOW - 9_000_000, { kind: 'event' }),
  ];
  const d = buildWearableFromGarmin(snapshot({ exercises: ex }), NOW);
  assert.equal(d.exercises.length, 2);
  assert.deepEqual([d.exercises[0].type, d.exercises[0].durationMin, d.exercises[0].distanceM, d.exercises[0].avgHr], ['running', 30, 5200, 148]);
  assert.deepEqual([d.exercises[1].type, d.exercises[1].distanceM], [null, null]);
});

test('sleep stages are absent (not guessed) when any stage is missing', () => {
  const s = snapshot();
  s.latest.metrics.sleep_stages.value = { deep_sleep_seconds: 4800 };
  assert.equal(buildWearableFromGarmin(s, NOW).lastNight, null);
});

/* ------------------------------------------------------------------- states */

test('stale data with a RECENT successful fetch says "Waiting for your watch to sync"', () => {
  const s = snapshot();
  s.latest.metrics.heart_rate.quality = 'stale';
  s.latest.metrics.heart_rate.ageSeconds = 3 * 3600;
  const n = syncNotice(s.latest, s.status, NOW);
  assert.deepEqual([n.kind, n.text], ['waiting', 'Waiting for your watch to sync']);
});

test('an OLD successful fetch, or a polling state other than normal, says "Garmin data is not updating"', () => {
  const s = snapshot();
  s.status.groups.fast.lastSuccessfulFetchAt = iso(-90);
  const old = syncNotice(s.latest, s.status, NOW);
  assert.deepEqual([old.kind, old.text], ['not_updating', 'Garmin data is not updating']);
  assert.match(old.reason, /last successful update 1 h ago/);
  const p = snapshot();
  p.status.pollingState = 'circuit_breaker_open';
  const paused = syncNotice(p.latest, p.status, NOW);
  assert.equal(paused.kind, 'not_updating');
  assert.match(paused.reason, /circuit breaker open/);
  const q = snapshot();
  q.status.pollingState = 'paused';
  q.status.pausedReason = 'login_required';
  assert.match(syncNotice(q.latest, q.status, NOW).reason, /login required/);
});

test('fresh data, or an unchanged value with a recent fetch, shows no notice; no data shows none either', () => {
  const s = snapshot();
  assert.equal(syncNotice(s.latest, s.status, NOW), null);
  const none = parseLatest(latestBody({}, { data_freshness: 'no_data', last_successful_fetch_at: null, missing_metrics: ['heart_rate'] }));
  assert.equal(syncNotice(none, null, NOW), null);
  const d = buildWearableFromGarmin({ ...snapshot(), latest: none }, NOW);
  assert.deepEqual(Object.keys(d.series), [], 'nothing is invented when there is no data');
});

test('without /status the last successful fetch on /metrics/latest decides', () => {
  const s = snapshot();
  s.latest.lastSuccessfulFetchAt = iso(-200);
  assert.equal(syncNotice(s.latest, null, NOW).kind, 'not_updating');
});

test('ages use the server clock: a phone clock 2 h behind does not make fresh data look old or new', () => {
  const phoneNow = NOW - 2 * 3_600_000;
  const d = buildWearableFromGarmin(snapshot(), phoneNow);
  const serverNow = phoneNow + d.clockOffsetMs;
  assert.equal(serverNow, NOW);
  const f = freshnessOf(d.series.heartRate[d.series.heartRate.length - 1].t, serverNow, 'instant');
  assert.equal(f.state, 'fresh');
  assert.match(f.text, /^Measured .* \(4 min ago\)$/);
});

test('loader: latest + status every time; history only when missing or older than 5 minutes', async () => {
  const urls = [];
  const f = fake((url) => {
    urls.push(url);
    if (url.includes('/metrics/latest')) return res(latestBody());
    if (url.includes('/status')) return res(statusBody());
    return res({ count: 0, limit: 500, has_more: false, next_cursor: null, observations: [] });
  });
  const first = await loadGarmin(cfg(f), NOW, null);
  assert.equal(first.ok, true);
  const historyCalls = urls.filter((u) => u.includes('/metrics/history')).length;
  assert.equal(historyCalls, 5);
  urls.length = 0;
  const prev = { history: { heartRate: [], stepsToday: [], stressBattery: [], daily: [], exercises: [] }, at: NOW };
  await loadGarmin(cfg(f), NOW + 60_000, prev);
  assert.equal(urls.filter((u) => u.includes('/metrics/history')).length, 0, 'no history reload within 5 minutes');
  assert.equal(urls.length, 2);
  urls.length = 0;
  await loadGarmin(cfg(f), NOW + 6 * 60_000, prev);
  assert.equal(urls.filter((u) => u.includes('/metrics/history')).length, 5);
});

test('loader: a failed /metrics/latest is a typed error, never data', async () => {
  const f = fake((url) => (url.includes('/metrics/latest') ? res({}, 401) : res(statusBody())));
  const r = await loadGarmin(cfg(f), NOW, { history: { heartRate: [], stepsToday: [], stressBattery: [], daily: [], exercises: [] }, at: NOW });
  assert.deepEqual([r.ok, r.error], [false, 'unauthorized']);
});

/* ------------------------------------------------------------ UTC -> local (DST) */

test('UTC to local around the Lebanon DST change (clocks go back at 00:00 on 25 Oct 2026)', () => {
  // Before the change Beirut is UTC+3, after it UTC+2: 20:30Z and 21:30Z are the same wall-clock time.
  assert.equal(formatTime12(new Date('2026-10-24T20:30:00Z')), '11:30 PM');
  assert.equal(formatTime12(new Date('2026-10-24T21:30:00Z')), '11:30 PM');
  assert.equal(formatTime12(new Date('2026-10-25T05:00:00Z')), '7:00 AM');
  // The hour that repeats stays two distinct instants (ordering is by the UTC value, not the local text).
  assert.ok(Date.parse('2026-10-24T21:30:00Z') > Date.parse('2026-10-24T20:30:00Z'));
});

test('daily values are one per LOCAL day across the DST change', () => {
  const rows = [
    obs('hrv_overnight_avg', 50, Date.parse('2026-10-24T04:00:00Z'), { kind: 'daily_summary' }),
    obs('hrv_overnight_avg', 52, Date.parse('2026-10-25T04:00:00Z'), { kind: 'daily_summary' }),
    obs('hrv_overnight_avg', 54, Date.parse('2026-10-26T04:00:00Z'), { kind: 'daily_summary' }),
  ];
  const now = Date.parse('2026-10-26T12:00:00Z');
  const s = snapshot({ daily: rows });
  s.latest.generatedAt = new Date(now).toISOString();
  s.latest.metrics = {};
  const d = buildWearableFromGarmin(s, now);
  assert.deepEqual(d.series.hrv.map((x) => x.v), [50, 52, 54]);
});

/* ------------------------------------------------------------- refresh limit */

test('refresh gate: one call per 6 minutes after a good refresh; 1 minute after a failed one', async () => {
  const { refreshGate, REFRESH_MIN_MS } = await import('../src/services/garminLoad.ts');
  assert.deepEqual(refreshGate(null, NOW), { allowed: true, waitMs: 0 });
  assert.equal(REFRESH_MIN_MS, 6 * 60_000);
  const ok = { at: NOW, ok: true };
  assert.equal(refreshGate(ok, NOW + 5 * 60_000 + 59_000).allowed, false);
  assert.equal(refreshGate(ok, NOW + 60_000).waitMs, 5 * 60_000);
  assert.equal(refreshGate(ok, NOW + 6 * 60_000).allowed, true);
  const bad = { at: NOW, ok: false };
  assert.equal(refreshGate(bad, NOW + 30_000).allowed, false);
  assert.equal(refreshGate(bad, NOW + 60_000).allowed, true);
});
