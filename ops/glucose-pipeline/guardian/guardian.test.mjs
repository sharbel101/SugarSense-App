import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { classify, advance, renderPush, lastTunnelUrl, makeEndpointServer, safeEqual } from './bg-guardian.mjs';

const MIN = 60_000;
const T0 = 1_800_000_000_000;

// a healthy baseline; each test overrides what it needs
const healthy = (over = {}) => ({
  now: T0,
  units: { bg: 'active', forecast: 'active', 'sugarsense-backend': 'active', nginx: 'active', 'bg-ngrok-tunnel': 'active', 'bg-cloudflared': 'active', 'collector-monitor': 'active', 'forecast-push': 'active' },
  local: { backend: true, forecast: true },
  status: { ok: true, state: 'ok', collector_online: true, last_poll_age_s: 5, last_post_age_s: 60, reading_age_s: 120, battery_pct: 100, charging: true, recent_events: [] },
  tunnels: [{ name: 'quick:a', kind: 'quick', ok: true }, { name: 'ngrok', kind: 'ngrok', ok: true }],
  diskFreePct: 60, ngrokMonthCount: 1000,
  ...over,
});
const codes = (f) => classify(f).map((x) => x.code);
const find = (f, code) => classify(f).find((x) => x.code === code);

test('healthy pipeline -> no findings', () => assert.deepEqual(codes(healthy()), []));

test('sensor / primary-phone gap is info and NEVER wakes anyone', () => {
  const f = find(healthy({ status: { ok: true, state: 'app_frozen', collector_online: true, reading_age_s: 2400, battery_pct: 100, charging: true, recent_events: [] } }), 'SENSOR_SIDE_GAP');
  assert.ok(f); assert.equal(f.severity, 'info'); assert.equal(f.wake, false);
  const a = advance({ seen: {} }, [f], T0 + 60 * MIN);
  assert.equal(a.actions.length, 0); assert.equal(a.state.incident, null);
});

test('phone script reporting source_stale is also sensor-side, not a fault', () => {
  const f = healthy({ status: { ok: true, state: 'ok', collector_online: true, reading_age_s: 300, recent_events: [{ event: 'source_stale', t: T0 - 5 * MIN }] } });
  assert.ok(codes(f).includes('SENSOR_SIDE_GAP'));
  assert.ok(!codes(f).some((c) => find(f, c).wake));
});

test('phone online but scrape failing -> fault that wakes the agent after 10 min', () => {
  const f = find(healthy({ status: { ok: true, state: 'scrape_failing', collector_online: true, reading_age_s: 1500, recent_events: [] } }), 'COLLECTOR_SCRAPE_FAILING');
  assert.equal(f.severity, 'fault'); assert.equal(f.wake, true); assert.equal(f.needMs, 10 * MIN);
});

test('scrape_failed events with an old reading also count as scrape failing', () => {
  const f = healthy({ status: { ok: true, state: 'app_frozen', collector_online: true, reading_age_s: 1200, recent_events: [{ event: 'scrape_failed', t: T0 - 3 * MIN }] } });
  assert.ok(codes(f).includes('COLLECTOR_SCRAPE_FAILING'));
  assert.ok(!codes(f).includes('SENSOR_SIDE_GAP'));
});

test('phone offline while the path is healthy -> PHONE_OFFLINE (wakes after 15 min)', () => {
  const f = find(healthy({ status: { ok: true, state: 'phone_offline', collector_online: false, reading_age_s: 5000 } }), 'PHONE_OFFLINE');
  assert.equal(f.wake, true); assert.equal(f.needMs, 15 * MIN);
});

test('phone offline BECAUSE the tunnels are dead is blamed on the tunnels, not the phone', () => {
  const f = healthy({ status: { ok: true, state: 'phone_offline', collector_online: false, reading_age_s: 5000 }, tunnels: [{ name: 'quick:a', kind: 'quick', ok: false }, { name: 'ngrok', kind: 'ngrok', ok: false }] });
  assert.ok(codes(f).includes('ALL_TUNNELS_DOWN'));
  assert.ok(!codes(f).includes('PHONE_OFFLINE'));
});

test('quick tunnel down but ngrok up -> warning that still wakes (after 10 min)', () => {
  const f = find(healthy({ tunnels: [{ name: 'quick:a', kind: 'quick', ok: false }, { name: 'ngrok', kind: 'ngrok', ok: true }] }), 'QUICK_TUNNELS_DOWN');
  assert.equal(f.severity, 'warn'); assert.equal(f.wake, true);
});

test('one of two quick tunnels down -> low-key warning, no wake', () => {
  const f = healthy({ tunnels: [{ name: 'quick:a', kind: 'quick', ok: true }, { name: 'quick:b', kind: 'quick', ok: false }, { name: 'ngrok', kind: 'ngrok', ok: true }] });
  const x = find(f, 'TUNNEL_DOWN:quick:b'); assert.ok(x); assert.equal(x.wake, false);
});

test('critical service down -> fault + wake; soft service down -> no wake', () => {
  const a = find(healthy({ units: { ...healthy().units, bg: 'failed' } }), 'SERVICE_DOWN:bg');
  assert.equal(a.severity, 'fault'); assert.equal(a.wake, true);
  const b = find(healthy({ units: { ...healthy().units, 'forecast-push': 'inactive' } }), 'SERVICE_DOWN:forecast-push');
  assert.equal(b.wake, false);
});

test('bg_service unreachable and local health failures wake the agent', () => {
  assert.ok(find(healthy({ status: { ok: false } }), 'BG_API_UNREACHABLE').wake);
  assert.ok(find(healthy({ local: { backend: false, forecast: true } }), 'LOCAL_ENDPOINT_DOWN:backend').wake);
});

test('disk low and ngrok quota thresholds', () => {
  assert.ok(find(healthy({ diskFreePct: 4 }), 'DISK_LOW').wake);
  assert.equal(find(healthy({ ngrokMonthCount: 14500 }), 'NGROK_QUOTA_70').wake, false);
  assert.equal(find(healthy({ ngrokMonthCount: 18500 }), 'NGROK_QUOTA_90').wake, true);
});

test('battery low and not charging warns (no wake); charging does not', () => {
  const f = find(healthy({ status: { ok: true, state: 'ok', collector_online: true, reading_age_s: 60, battery_pct: 12, charging: false } }), 'PHONE_BATTERY_LOW');
  assert.ok(f); assert.equal(f.wake, false);
  assert.ok(!codes(healthy({ status: { ok: true, state: 'ok', collector_online: true, reading_age_s: 60, battery_pct: 12, charging: true } })).includes('PHONE_BATTERY_LOW'));
});

// ---- incident lifecycle ----------------------------------------------------------------------------
test('debounce: a finding does not become an incident before needMs', () => {
  const f = [{ code: 'X', severity: 'fault', needMs: 10 * MIN, wake: true, msg: 'x' }];
  let r = advance({ seen: {} }, f, T0);
  assert.equal(r.actions.length, 0); assert.equal(r.state.incident, null);
  r = advance(r.state, f, T0 + 9 * MIN); assert.equal(r.actions.length, 0);
  r = advance(r.state, f, T0 + 10 * MIN);
  assert.deepEqual(r.actions.map((a) => a.type), ['open', 'notify']);
  assert.equal(r.state.incident.wake_agent, true);
});

test('notify once, remind hourly (max 3), stop when acknowledged, close on recovery', () => {
  const f = [{ code: 'X', severity: 'fault', needMs: 0, wake: true, msg: 'boom' }];
  let r = advance({ seen: {} }, f, T0);
  assert.deepEqual(r.actions.map((a) => a.type), ['open', 'notify']);
  r = advance(r.state, f, T0 + 30 * MIN); assert.equal(r.actions.length, 0);
  r = advance(r.state, f, T0 + 61 * MIN); assert.deepEqual(r.actions.map((a) => a.type), ['notify']);
  r.state.incident.acknowledged = true;
  r = advance(r.state, f, T0 + 130 * MIN); assert.equal(r.actions.length, 0);
  r = advance(r.state, [], T0 + 140 * MIN);
  assert.equal(r.actions[0].type, 'close'); assert.equal(r.state.incident, null);
  assert.equal(r.actions[0].incident.duration_s, 140 * 60);
});

test('reminders cap at maxReminders', () => {
  const f = [{ code: 'X', severity: 'fault', needMs: 0, wake: true, msg: 'm' }];
  let r = advance({ seen: {} }, f, T0); let n = 1;
  for (let i = 1; i <= 8; i++) { r = advance(r.state, f, T0 + i * 61 * MIN); n += r.actions.filter((a) => a.type === 'notify').length; }
  assert.equal(n, 4);   // 1 first + 3 reminders
});

test('warn-only incident without wake opens but never notifies', () => {
  const f = [{ code: 'W', severity: 'warn', needMs: 0, wake: false, msg: 'w' }];
  const r = advance({ seen: {} }, f, T0);
  assert.deepEqual(r.actions.map((a) => a.type), ['open']);
  assert.equal(r.state.incident.wake_agent, false);
});

test('a flap shorter than needMs resets the debounce clock', () => {
  const f = [{ code: 'X', severity: 'fault', needMs: 10 * MIN, wake: true, msg: 'x' }];
  let r = advance({ seen: {} }, f, T0);
  r = advance(r.state, [], T0 + 5 * MIN);
  r = advance(r.state, f, T0 + 6 * MIN);
  r = advance(r.state, f, T0 + 12 * MIN);       // only 6 min since it came back
  assert.equal(r.actions.length, 0);
});

test('push text contains no glucose number and names the incident', () => {
  const p = renderPush({ id: 'inc-1', codes: ['SERVICE_DOWN:bg'], findings: [{ msg: 'systemd unit bg is failed' }] }, true);
  assert.match(p.body, /inc-1/); assert.doesNotMatch(p.body, /mg\/dL|\d{3}/);
});

// ---- helpers + endpoint server ----------------------------------------------------------------------
test('lastTunnelUrl picks the most recent trycloudflare URL', () => {
  const log = 'x https://old-one-aaa.trycloudflare.com y\nz https://new-two-bbb.trycloudflare.com\n';
  assert.equal(lastTunnelUrl(log), 'https://new-two-bbb.trycloudflare.com');
  assert.equal(lastTunnelUrl('nothing here'), null);
});

test('endpoint server: 401 without token, 200 with, 404 elsewhere, GET only', async () => {
  const published = { endpoints: ['https://a-b.trycloudflare.com'], fallback: 'https://x.ngrok-free.dev', generatedAt: 'now' };
  const srv = makeEndpointServer(() => published, 'secret-token');
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const get = (p, headers = {}, method = 'GET') => new Promise((res) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => res({ code: r.statusCode, body: b })); });
    req.end();
  });
  assert.equal((await get('/agent/endpoints')).code, 401);
  assert.equal((await get('/agent/endpoints', { authorization: 'wrong' })).code, 401);
  const ok = await get('/agent/endpoints', { authorization: 'secret-token' });
  assert.equal(ok.code, 200); assert.deepEqual(JSON.parse(ok.body), published);
  assert.equal((await get('/other', { authorization: 'secret-token' })).code, 404);
  assert.equal((await get('/agent/endpoints', { authorization: 'secret-token' }, 'POST')).code, 404);
  srv.close();
});

test('safeEqual is length-safe', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', ''), true);
});
