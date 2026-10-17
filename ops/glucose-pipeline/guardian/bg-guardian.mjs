#!/usr/bin/env node
// bg-guardian - watches the whole glucose collection pipeline and wakes a human/AI agent ONLY when the
// pipeline itself is at fault.
//
//   sensor -> primary phone -> Sinocare cloud -> iCan Reach (follower phone) -> AutoJs6 script
//          -> tunnels (cloudflared / ngrok) -> nginx -> bg_service -> bg.db -> forecast / backend / watch
//
// A sensor or primary-phone disconnect shows up as "the follower app's data stopped advancing". That is
// EXPECTED and benign for this tool: it is recorded (SENSOR_SIDE_GAP, info) but never wakes anyone.
// Everything else (a service down, a tunnel dead, the phone script polling but not delivering, the phone
// script gone while the path is healthy, disk nearly full, ngrok quota) opens an incident.
//
// Outputs (all under STATE_DIR, no secrets, no glucose values):
//   incidents/current.json   exists only while an incident is open; read by the agent (see RUNBOOK)
//   incidents/history.jsonl  one line per closed incident
//   status.json              latest facts + findings (always written)
//   incidents/ack            touch this file to acknowledge the open incident (stops reminders)
// Also serves  GET http://127.0.0.1:8002/agent/endpoints  (token auth) listing the currently reachable
// tunnel URLs, so the phone can re-discover a rotated quick-tunnel URL through the stable ngrok domain.
//
// Run: node bg-guardian.mjs          (systemd)    node --test guardian.test.mjs   (tests, no network)

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const CONFIG = {
  token: process.env.API_AUTH_TOKEN ?? '',
  bgBase: 'http://127.0.0.1:8000',
  backendBase: 'http://127.0.0.1:3000',
  forecastBase: 'http://127.0.0.1:8001',
  ngrokApi: 'http://127.0.0.1:4040/api/tunnels',
  stateDir: process.env.GUARDIAN_STATE_DIR ?? '/home/ubuntu/bg/guardian',
  tunnelLogs: ['/home/ubuntu/bg-cloudflared.log', '/home/ubuntu/cloudflared.log'],
  criticalUnits: ['bg', 'forecast', 'sugarsense-backend', 'nginx', 'bg-ngrok-tunnel', 'bg-cloudflared'],
  softUnits: ['collector-monitor', 'forecast-push'],
  checkMs: 30_000,
  tunnelProbeMs: 60_000,
  ngrokPublicProbeMs: 60 * 60_000,
  serverPort: 8002,
  reminderMs: 60 * 60_000,
  maxReminders: 3,
  diskWarnFreePct: 10,
  ngrokMonthlyLimit: 20_000,
  pushPython: '/opt/forecast-push/venv/bin/python3',
};

// ---------------------------------------------------------------------------------------------------
// Pure classification: facts -> findings. No I/O, fully unit-tested.
// finding = { code, severity: 'info'|'warn'|'fault', needMs, wake, msg }
//   needMs = how long the condition must persist before it counts (debounce)
//   wake   = whether an active finding should wake the agent / notify the user
// ---------------------------------------------------------------------------------------------------
export function classify(f) {
  const out = [];
  const add = (code, severity, needMs, wake, msg) => out.push({ code, severity, needMs, wake, msg });

  for (const [unit, st] of Object.entries(f.units ?? {})) {
    if (CONFIG.criticalUnits.includes(unit) && st !== 'active') {
      add(`SERVICE_DOWN:${unit}`, 'fault', 60_000, true, `systemd unit ${unit} is ${st}`);
    } else if (CONFIG.softUnits.includes(unit) && st !== 'active') {
      add(`SERVICE_DOWN:${unit}`, 'warn', 5 * 60_000, false, `systemd unit ${unit} is ${st}`);
    }
  }
  for (const [name, ok] of Object.entries(f.local ?? {})) {
    if (!ok) add(`LOCAL_ENDPOINT_DOWN:${name}`, 'fault', 90_000, true, `${name} did not answer its health check`);
  }

  // public path: quick tunnels carry the phone, ngrok carries the watch + the rendezvous
  const quick = (f.tunnels ?? []).filter((t) => t.kind === 'quick');
  const ngrok = (f.tunnels ?? []).find((t) => t.kind === 'ngrok');
  const quickOk = quick.some((t) => t.ok);
  const ngrokOk = ngrok ? ngrok.ok : true;
  let pathDead = false;
  if (!quickOk && quick.length > 0 && !ngrokOk) {
    pathDead = true;
    add('ALL_TUNNELS_DOWN', 'fault', 2 * 60_000, true, 'no public tunnel is reachable: the phone and the watch cannot reach the VM');
  } else {
    if (quick.length > 0 && !quickOk) add('QUICK_TUNNELS_DOWN', 'warn', 10 * 60_000, true, 'no cloudflared quick tunnel is reachable (phone is on the ngrok fallback if it noticed)');
    else for (const t of quick) if (!t.ok) add(`TUNNEL_DOWN:${t.name}`, 'warn', 30 * 60_000, false, `tunnel ${t.name} is unreachable (another path still works)`);
    if (ngrok && !ngrok.ok) add('NGROK_DOWN', 'warn', 10 * 60_000, true, 'ngrok tunnel is unreachable: the watch and Expo Go lose their API');
  }

  const s = f.status;
  if (!s || s.ok === false) {
    add('BG_API_UNREACHABLE', 'fault', 60_000, true, 'bg_service /agent/status did not answer locally');
  } else {
    const events = s.recent_events ?? [];
    const recent = (name, withinMs) => events.some((e) => e.event === name && f.now - e.t <= withinMs);
    const readingAge = s.reading_age_s ?? Infinity;
    if (s.state === 'scrape_failing' || (s.collector_online && recent('scrape_failed', 15 * 60_000) && readingAge > 900)) {
      add('COLLECTOR_SCRAPE_FAILING', 'fault', 10 * 60_000, true, 'phone script is online but cannot read or deliver a reading (iCan Reach UI, login or popup?)');
    } else if (s.state === 'app_frozen' || s.state === 'frozen' || (s.collector_online && recent('source_stale', 20 * 60_000))) {
      add('SENSOR_SIDE_GAP', 'info', 15 * 60_000, false, 'iCan Reach data is not advancing: sensor / primary phone / Sinocare cloud side (expected, not a pipeline fault)');
    }
    if (s.collector_online === false && !pathDead && quickOk) {
      add('PHONE_OFFLINE', 'fault', 15 * 60_000, true, 'phone script stopped polling while the public path is healthy: phone off, script stopped or Wi-Fi lost (agent: check adb, restart script)');
    }
    if (s.battery_pct != null && s.battery_pct <= 20 && s.charging === false) {
      add('PHONE_BATTERY_LOW', 'warn', 0, false, `collector phone battery ${s.battery_pct}% and not charging`);
    }
  }

  if (f.diskFreePct != null && f.diskFreePct < CONFIG.diskWarnFreePct) {
    add('DISK_LOW', 'warn', 10 * 60_000, true, `root disk only ${f.diskFreePct.toFixed(1)}% free`);
  }
  if (f.ngrokMonthCount != null) {
    const pct = (100 * f.ngrokMonthCount) / CONFIG.ngrokMonthlyLimit;
    if (pct >= 90) add('NGROK_QUOTA_90', 'fault', 0, true, `ngrok free quota ~${pct.toFixed(0)}% used this month: past 100% the watch API goes dark`);
    else if (pct >= 70) add('NGROK_QUOTA_70', 'warn', 0, false, `ngrok free quota ~${pct.toFixed(0)}% used this month`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Incident manager (pure: state in, state out). seen = {code: firstSeenMs}.
// ---------------------------------------------------------------------------------------------------
export function advance(state, findings, now) {
  const next = { seen: {}, pushed: { ...(state.pushed ?? {}) }, incident: state.incident ?? null };
  const actions = [];
  for (const f of findings) next.seen[f.code] = state.seen?.[f.code] ?? now;
  const active = findings.filter((f) => now - next.seen[f.code] >= f.needMs);
  const sig = (arr) => arr.map((f) => f.code).sort().join('|');
  const openable = active.filter((f) => f.severity !== 'info');

  if (openable.length > 0) {
    const wake = openable.some((f) => f.wake);
    const worst = openable.some((f) => f.severity === 'fault') ? 'fault' : 'warn';
    if (!next.incident) {
      next.incident = {
        id: `inc-${new Date(now).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`,
        opened_at: now, wake_agent: wake, severity: worst, codes: openable.map((f) => f.code),
        notified: 0, last_notified_at: 0,
      };
      actions.push({ type: 'open' });
    }
    const inc = next.incident;
    inc.updated_at = now;
    inc.severity = worst;
    inc.wake_agent = wake;
    inc.codes = openable.map((f) => f.code);
    inc.findings = openable.map(({ code, severity, msg }) => ({ code, severity, msg, since: next.seen[code] }));
    // notify: first time a wake-worthy incident exists, then reminders (unless acknowledged)
    if (wake && !inc.acknowledged) {
      if (inc.notified === 0) actions.push({ type: 'notify', first: true });
      else if (inc.notified <= CONFIG.maxReminders && now - inc.last_notified_at >= CONFIG.reminderMs) actions.push({ type: 'notify', first: false });
    }
    if (actions.some((a) => a.type === 'notify')) { inc.notified += 1; inc.last_notified_at = now; }
  } else if (next.incident) {
    actions.push({ type: 'close', incident: { ...next.incident, closed_at: now, duration_s: Math.round((now - next.incident.opened_at) / 1000) } });
    next.incident = null;
  }
  return { state: next, active, actions };
}

export function renderPush(inc, first) {
  const top = (inc.findings ?? [])[0];
  const title = first ? 'Glucose pipeline fault' : 'Still: glucose pipeline fault';
  const body = `${top ? top.msg : inc.codes.join(', ')}. An AI agent has been asked to investigate (${inc.id}).`;
  return { title, body };
}

// ---------------------------------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------------------------------
const log = (m) => console.log(`[guardian] ${m}`);
const sh = (cmd, args, timeout = 8000) => new Promise((res) => execFile(cmd, args, { timeout }, (e, so) => res({ ok: !e, out: String(so ?? '').trim() })));
async function getJson(url, headers = {}, timeoutMs = 8000) {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return { ok: false, code: r.status };
    return { ok: true, code: r.status, json: await r.json().catch(() => null) };
  } catch (e) { return { ok: false, code: 0 }; }
}
const authHeaders = () => ({ Authorization: CONFIG.token });

export function lastTunnelUrl(text) {
  const m = String(text).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g);
  return m ? m[m.length - 1] : null;
}
function readQuickUrls() {
  const urls = [];
  for (const f of CONFIG.tunnelLogs) {
    try { const u = lastTunnelUrl(fs.readFileSync(f, 'utf8').slice(-200_000)); if (u && !urls.includes(u)) urls.push(u); } catch { /* log not there */ }
  }
  return urls;
}
const writeJsonAtomic = (p, obj) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p + '.tmp', JSON.stringify(obj, null, 2)); fs.renameSync(p + '.tmp', p); };
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };

export function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// GET /agent/endpoints -> { endpoints: [reachable quick-tunnel urls], fallback, generatedAt }
export function makeEndpointServer(getPublished, token) {
  return http.createServer((req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method !== 'GET' || req.url.split('?')[0] !== '/agent/endpoints') return send(404, { detail: 'not found' });
    if (!token || !safeEqual(req.headers.authorization ?? '', token)) return send(401, { detail: 'unauthorized' });
    send(200, getPublished());
  });
}

// ---------------------------------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------------------------------
async function main() {
  if (!CONFIG.token) { log('API_AUTH_TOKEN not set'); process.exit(1); }
  const S = CONFIG.stateDir;
  fs.mkdirSync(path.join(S, 'incidents'), { recursive: true });
  let state = readJson(path.join(S, 'state.json'), { seen: {}, pushed: {}, incident: null });
  const mem = { tunnels: {}, ngrokBase: null, published: { endpoints: [], fallback: null, generatedAt: null }, ngrokMonth: readJson(path.join(S, 'ngrok_month.json'), { month: '', count: 0, lastSeen: 0, startedAt: '' }) };
  const probeAt = {};

  const srv = makeEndpointServer(() => mem.published, CONFIG.token);
  srv.on('error', (e) => log(`endpoint server error: ${e.code}`));
  srv.listen(CONFIG.serverPort, '127.0.0.1', () => log(`endpoint server on 127.0.0.1:${CONFIG.serverPort}`));

  const probe = async (name, kind, url, everyMs) => {
    const now = Date.now();
    const t = mem.tunnels[name] ?? (mem.tunnels[name] = { name, kind, url, ok: true, fails: 0, lastProbe: 0 });
    t.url = url;
    if (now - t.lastProbe < everyMs) return t;
    t.lastProbe = now;
    const r = await getJson(`${url}/agent/status`, { ...authHeaders(), 'ngrok-skip-browser-warning': '1' }, 10_000);
    t.fails = r.ok ? 0 : t.fails + 1;
    t.ok = t.fails < 3;     // need 3 consecutive failures before a tunnel is called down
    t.lastOkAt = r.ok ? now : t.lastOkAt;
    return t;
  };

  const cycle = async () => {
    const now = Date.now();
    const units = {};
    for (const u of [...CONFIG.criticalUnits, ...CONFIG.softUnits]) units[u] = (await sh('systemctl', ['is-active', u])).out || 'unknown';

    const [status, backend, forecast] = await Promise.all([
      getJson(`${CONFIG.bgBase}/agent/status`, authHeaders()),
      getJson(`${CONFIG.backendBase}/health`),
      getJson(`${CONFIG.forecastBase}/healthz`),
    ]);
    const local = { backend: backend.ok, forecast: forecast.ok };

    // tunnels
    const tunnels = [];
    for (const u of readQuickUrls()) tunnels.push(await probe(`quick:${u.slice(8, 20)}`, 'quick', u, CONFIG.tunnelProbeMs));
    let ngrokMonthCount = null;
    const ng = await getJson(CONFIG.ngrokApi, {}, 4000);
    const ngTunnel = ng.ok ? (ng.json?.tunnels ?? []).find((t) => String(t.public_url).startsWith('https://')) : null;
    if (ngTunnel) {
      mem.ngrokBase = ngTunnel.public_url;
      const t = mem.tunnels.ngrok ?? (mem.tunnels.ngrok = { name: 'ngrok', kind: 'ngrok', url: mem.ngrokBase, ok: true, fails: 0, lastProbe: 0 });
      t.url = mem.ngrokBase; t.fails = 0; t.ok = true;      // local agent API says the endpoint is online
      if (now - (mem.ngrokPublicAt ?? 0) >= CONFIG.ngrokPublicProbeMs) {   // rare real probe (costs 1 of 20k monthly requests)
        mem.ngrokPublicAt = now;
        const r = await getJson(`${mem.ngrokBase}/agent/status`, { ...authHeaders(), 'ngrok-skip-browser-warning': '1' }, 10_000);
        t.ok = r.ok;
      }
      // month-to-date request counter (ngrok's counter resets whenever the agent restarts)
      const c = ngTunnel.metrics?.http?.count ?? 0;
      const month = new Date(now).toISOString().slice(0, 7);
      const m = mem.ngrokMonth;
      if (m.month !== month) { m.month = month; m.count = 0; m.lastSeen = c; }
      m.count += c >= m.lastSeen ? c - m.lastSeen : c;
      m.lastSeen = c;
      writeJsonAtomic(path.join(S, 'ngrok_month.json'), m);
      ngrokMonthCount = m.count;
    } else {
      const t = mem.tunnels.ngrok ?? (mem.tunnels.ngrok = { name: 'ngrok', kind: 'ngrok', url: mem.ngrokBase, ok: false, fails: 0, lastProbe: 0 });
      t.fails += 1; t.ok = t.fails < 3;
    }
    tunnels.push(mem.tunnels.ngrok);

    // publish only tunnels that currently work
    mem.published = { endpoints: tunnels.filter((t) => t.kind === 'quick' && t.ok).map((t) => t.url), fallback: mem.ngrokBase, generatedAt: new Date(now).toISOString() };

    let diskFreePct = null;
    try { const st = fs.statfsSync('/'); diskFreePct = (100 * st.bavail) / st.blocks; } catch { /* ignore */ }

    const facts = { now, units, local, status: status.ok ? { ok: true, ...status.json } : { ok: false }, tunnels, diskFreePct, ngrokMonthCount };
    const findings = classify(facts);

    // acknowledge
    const ackPath = path.join(S, 'incidents', 'ack');
    const adv = advance(state, findings, now);
    state = adv.state;
    if (state.incident && fs.existsSync(ackPath)) state.incident.acknowledged = true;

    for (const a of adv.actions) {
      if (a.type === 'open') log(`incident opened: ${state.incident.codes.join(', ')}`);
      if (a.type === 'notify') {
        const { title, body } = renderPush(state.incident, a.first);
        const r = await sh(CONFIG.pushPython, ['-c', "import sys; sys.path.insert(0,'/opt/forecast-push'); import collector_monitor as m; print(m.send_push(sys.argv[1], sys.argv[2], True, tag='pipeline'))", title, body], 30_000);
        log(`notify (${a.first ? 'first' : 'reminder'}) -> push ok=${r.ok} subscribers=${r.out}`);
      }
      if (a.type === 'close') {
        fs.appendFileSync(path.join(S, 'incidents', 'history.jsonl'), JSON.stringify(a.incident) + '\n');
        try { fs.unlinkSync(ackPath); } catch { /* none */ }
        log(`incident closed after ${a.incident.duration_s}s`);
        if (a.incident.notified > 0) await sh(CONFIG.pushPython, ['-c', "import sys; sys.path.insert(0,'/opt/forecast-push'); import collector_monitor as m; m.send_push(sys.argv[1], sys.argv[2], False, tag='pipeline')", 'Glucose pipeline recovered', `${a.incident.codes.join(', ')} cleared after ${Math.round(a.incident.duration_s / 60)} min.`], 30_000);
      }
    }
    if (state.incident) writeJsonAtomic(path.join(S, 'incidents', 'current.json'), state.incident);
    else { try { fs.unlinkSync(path.join(S, 'incidents', 'current.json')); } catch { /* none */ } }
    writeJsonAtomic(path.join(S, 'state.json'), state);
    writeJsonAtomic(path.join(S, 'status.json'), { at: new Date(now).toISOString(), units, local, tunnels: tunnels.map(({ name, kind, ok, fails }) => ({ name, kind, ok, fails })), collector: facts.status, diskFreePct, ngrokMonthCount, findings, incident: state.incident });
  };

  log(`started; check every ${CONFIG.checkMs / 1000}s`);
  for (;;) {
    try { await cycle(); } catch (e) { log(`cycle error: ${e?.message ?? e}`); }
    await new Promise((r) => setTimeout(r, CONFIG.checkMs));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
