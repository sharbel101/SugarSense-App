"auto";

// ---------------------------------------------------------------------------
// glucose_sync.js v3 - reads iCan Reach's on-screen glucose and pushes it to
// bg_service. ONE long-lived loop holding a partial wake lock (survives Doze).
// Auto-restarted on boot by the AutoJs6 BOOT task registered by setup_loop.js.
//
// v3 hardening over v1 (2026-09-07):
//   * every HTTP call has a hard connect/read timeout (v1 could block forever)
//   * endpoint FAILOVER: primary tunnel(s) -> ngrok static domain. While on the
//     ngrok fallback it polls slowly (ngrok free = 20k requests/month) and
//     retries the primary every few minutes. It also asks the fallback for the
//     current tunnel list (GET /agent/endpoints) so a rotated quick-tunnel URL
//     heals itself without anybody editing this phone.
//   * readings that could not be delivered are queued and flushed (ts is the
//     reading's own time, the server stores by ts, so late delivery is exact)
//   * reports WHY it failed to POST /agent/report (rate limited) and its battery
//     / charging state on every poll, so outages are diagnosable server-side
//   * one recovery retry (back, home, relaunch) when the reading is not found
// ---------------------------------------------------------------------------

var AGENT_VERSION = "v3.3-2026-10-21";
var FAIL_LOG_PATH = "/sdcard/Download/glucose_fail.log";

var DEFAULT_PRIMARY = "";  // set "endpoint" in glucose_config.json on the phone (quick-tunnel URL kept out of the public repo)
var DEFAULT_FALLBACK = "https://entitle-evacuate-removed.ngrok-free.dev";
var CONFIG_PATH = "/sdcard/Download/glucose_config.json";
var STATE_PATH = "/sdcard/Download/glucose_endpoints.json";
var LOCK_PATH = "/sdcard/Download/glucose_sync.lock";
var ICAN_PKG = "com.sinocare.cgm.follow.ce";
var GLUCOSE_MIN = 20;
var GLUCOSE_MAX = 600;

var SYNC_PERIOD_MS = 180 * 1000;       // CGM grid (readings land every 3 min)
var INTERVAL_MS = SYNC_PERIOD_MS;      // lock staleness check

var POLL_MS = 12 * 1000;               // fetch-flag poll on a primary tunnel
var FALLBACK_POLL_MS = 60 * 1000;      // ...and on the ngrok fallback (request quota)
var PRIMARY_RETRY_MS = 5 * 60 * 1000;  // while on fallback, try the primary this often
var DISCOVERY_MS = 10 * 60 * 1000;     // while on fallback, refresh the tunnel list this often
var SAFETY_SCRAPE_MS = 6 * 60 * 1000;  // scrape anyway if none this recent
var HTTP_TIMEOUT_MS = 10 * 1000;
var MAX_PENDING = 40;
var REPORT_MIN_GAP_MS = 5 * 60 * 1000; // per event type
var STALE_REPORT_AGE_MIN = 15;         // report "iCan Reach data is N min old" from here on
// iCan Reach only fetches fresh data when its list is pulled down, so every scrape drags the screen down
// and waits for the refresh to finish before reading. Disable/tune in glucose_config.json:
//   "pullToRefresh": false      "refreshWaitSeconds": 5
var PULL_TO_REFRESH = true;
var REFRESH_WAIT_MS = 5 * 1000;

// --- single-instance guard (lock file) --------------------------------------
var MY_ID = Date.now() + "-" + Math.floor(Math.random() * 1e6);
function lockHeldByOther() {
    try {
        if (!files.exists(LOCK_PATH)) return false;
        var p = files.read(LOCK_PATH).split("|");
        if (p[0] === MY_ID) return false;
        return (Date.now() - parseInt(p[1], 10)) < (2 * INTERVAL_MS + 60000);
    } catch (e) { return false; }
}
function refreshLock() {
    try { files.write(LOCK_PATH, MY_ID + "|" + Date.now()); } catch (e) {}
}

// --- keep the CPU alive across Doze -----------------------------------------
var wakeLock = null;
function acquireWakeLock() {
    try {
        var pm = context.getSystemService(context.POWER_SERVICE);
        wakeLock = pm.newWakeLock(1 /* PARTIAL_WAKE_LOCK */, "glucoguard:sync");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire();
        log("wake lock acquired");
    } catch (e) {
        log("wake lock failed (continuing anyway): " + e);
    }
}
function releaseWakeLock() {
    try { if (wakeLock != null && wakeLock.isHeld()) wakeLock.release(); } catch (e) {}
}
try { events.on("exit", releaseWakeLock); } catch (e) {}

// --- config + endpoint list ---------------------------------------------------
function baseOf(url) {
    return String(url || "").replace(/\/+$/, "").replace(/\/(bg|agent\/poll)$/, "");
}
function readJson(path) {
    try { if (files.exists(path)) return JSON.parse(files.read(path)); } catch (e) { log("read " + path + " failed: " + e); }
    return null;
}
function loadConfig() {
    var c = readJson(CONFIG_PATH) || {};
    if (c.pullToRefresh === false) PULL_TO_REFRESH = false;
    if (c.refreshWaitSeconds > 0 && c.refreshWaitSeconds <= 30) REFRESH_WAIT_MS = c.refreshWaitSeconds * 1000;
    var primaries = [];
    function addPrimary(u) {
        var b = baseOf(u);
        if (b && primaries.indexOf(b) < 0) primaries.push(b);
    }
    addPrimary(c.endpoint || DEFAULT_PRIMARY);
    if (c.endpoints && c.endpoints.length) for (var i = 0; i < c.endpoints.length; i++) addPrimary(c.endpoints[i]);
    var st = readJson(STATE_PATH);
    if (st && st.discovered && st.discovered.length) for (var j = 0; j < st.discovered.length; j++) addPrimary(st.discovered[j]);
    var fb = baseOf(c.fallback || DEFAULT_FALLBACK);
    var ep = [];
    for (var k = 0; k < primaries.length; k++) if (primaries[k] !== fb) ep.push({ base: primaries[k], fallback: false });
    ep.push({ base: fb, fallback: true });
    return { token: c.token || "", ep: ep };
}

var cfg = null;
var cur = 0;                 // index into cfg.ep of the endpoint that last worked
var lastPrimaryTry = 0;
var lastDiscovery = 0;
var pending = [];            // undelivered readings [{mgdl, ts}]

function onFallback() { return cfg.ep[cur] && cfg.ep[cur].fallback === true; }

// --- HTTP with hard timeouts --------------------------------------------------
function httpRequest(method, url, headers, bodyStr) {
    var conn = null;
    try {
        conn = new java.net.URL(url).openConnection();
        conn.setRequestMethod(method);
        conn.setConnectTimeout(HTTP_TIMEOUT_MS);
        conn.setReadTimeout(HTTP_TIMEOUT_MS);
        conn.setUseCaches(false);
        conn.setRequestProperty("Accept", "application/json");
        conn.setRequestProperty("ngrok-skip-browser-warning", "1");
        for (var k in headers) conn.setRequestProperty(k, headers[k]);
        if (bodyStr != null) {
            var bytes = new java.lang.String(bodyStr).getBytes("UTF-8");
            conn.setDoOutput(true);
            conn.setFixedLengthStreamingMode(bytes.length);
            var os = conn.getOutputStream();
            os.write(bytes);
            os.close();
        }
        var code = conn.getResponseCode();
        var stream = (code >= 400) ? conn.getErrorStream() : conn.getInputStream();
        var text = "";
        if (stream != null) {
            var sc = new java.util.Scanner(stream, "UTF-8").useDelimiter("\\A");
            text = sc.hasNext() ? String(sc.next()) : "";
            sc.close();
        }
        return { ok: code >= 200 && code < 300, code: code, body: text, err: null };
    } catch (e) {
        return { ok: false, code: 0, body: "", err: String(e) };
    } finally {
        try { if (conn != null) conn.disconnect(); } catch (e2) {}
    }
}

// An answer that proves the server was reached and rejected the REQUEST (auth,
// validation) - rotating to another endpoint cannot fix it, so don't.
function isDefinitive(r) {
    return r.code >= 400 && r.code < 500 && r.code !== 404 && r.code !== 408 && r.code !== 429;
}

function callApi(method, path, bodyObj) {
    var n = cfg.ep.length;
    var start = cur;
    if (onFallback() && Date.now() - lastPrimaryTry > PRIMARY_RETRY_MS) {
        start = 0;
        lastPrimaryTry = Date.now();
    }
    var headers = { "Authorization": cfg.token };
    var bodyStr = null;
    if (bodyObj !== undefined && bodyObj !== null) {
        bodyStr = JSON.stringify(bodyObj);
        headers["Content-Type"] = "application/json";
    }
    var last = { ok: false, code: 0, body: "", err: "no endpoints" };
    for (var i = 0; i < n; i++) {
        var idx = (start + i) % n;
        var r = httpRequest(method, cfg.ep[idx].base + path, headers, bodyStr);
        if (r.ok || isDefinitive(r)) {
            if (r.ok && idx !== cur) {
                log("endpoint switch: " + cfg.ep[cur].base + " -> " + cfg.ep[idx].base);
                var wasFallback = onFallback();
                cur = idx;
                if (onFallback() !== wasFallback) {
                    report("endpoint_switch", onFallback() ? "on FALLBACK " + cfg.ep[idx].base : "back on primary " + cfg.ep[idx].base);
                }
            }
            return r;
        }
        last = r;
        log("endpoint " + cfg.ep[idx].base + path + " failed (" + (r.err || r.code) + ")");
    }
    return last;
}

// --- failure reporting (best effort, rate limited per event) ------------------
var lastReport = {};
function report(event, detail) {
    try {
        var now = Date.now();
        if (lastReport[event] && now - lastReport[event] < REPORT_MIN_GAP_MS) return;
        lastReport[event] = now;
        var r = callApi("POST", "/agent/report", { event: event, detail: String(detail || "").substring(0, 380) });
        if (!r.ok) log("report failed (" + (r.err || r.code) + ")");
    } catch (e) {}
}

function batteryQuery() {
    try {
        var b = Math.round(device.getBattery());
        var c = device.isCharging() ? 1 : 0;
        if (b >= 0 && b <= 100) return "?b=" + b + "&c=" + c;
    } catch (e) {}
    return "";
}

// --- tunnel discovery (only while on the fallback) ----------------------------
function refreshEndpoints() {
    if (!onFallback() || Date.now() - lastDiscovery < DISCOVERY_MS) return;
    lastDiscovery = Date.now();
    var r = httpRequest("GET", cfg.ep[cur].base + "/agent/endpoints", { "Authorization": cfg.token }, null);
    if (!r.ok) { log("discovery: " + (r.err || r.code)); return; }
    try {
        var j = JSON.parse(r.body);
        if (j && j.endpoints && j.endpoints.length) {
            var found = [];
            for (var i = 0; i < j.endpoints.length; i++) {
                var b = baseOf(j.endpoints[i]);
                if (/^https:\/\//.test(b)) found.push(b);
            }
            files.write(STATE_PATH, JSON.stringify({ discovered: found, at: Date.now() }));
            var keepFallback = cfg.ep[cur].base;
            cfg = loadConfig();
            cur = cfg.ep.length - 1;
            for (var k = 0; k < cfg.ep.length; k++) if (cfg.ep[k].base === keepFallback) cur = k;
            log("discovery: tunnels now " + found.join(", "));
        }
    } catch (e) { log("discovery parse failed: " + e); }
}

// --- reading parse (unchanged from v1) ----------------------------------------
var ALERT_RE = /glucose level is|glucose alert|preset|high limit|low limit|above the|below the|out of range|urgent|\balert\b|\brate\b|mean glucose|time in range|highest|lowest|average/i;

function parseReading(descStr) {
    if (ALERT_RE.test(descStr)) return null;
    var lines = descStr.split("\n").map(function (s) { return s.trim(); })
                       .filter(function (s) { return s.length > 0; });
    var value = null;
    for (var k = 0; k < lines.length && value === null; k++) {
        var lower = lines[k].toLowerCase();
        if ((lower === "mg/dl" || lower === "mmol/l") && k > 0) {
            var n = parseFloat(lines[k - 1]);
            if (!isNaN(n) && n >= GLUCOSE_MIN && n <= GLUCOSE_MAX) value = n;
        }
        if (value === null && lines[k].length <= 15) {
            var m = lines[k].match(/(\d+(?:\.\d+)?)\s*mg\/dl/i);
            if (m) {
                var mv = parseFloat(m[1]);
                if (mv >= GLUCOSE_MIN && mv <= GLUCOSE_MAX) value = mv;
            }
        }
    }
    if (value === null) return null;
    var desc = descStr;
    var unit = /mmol\/l/i.test(desc) ? "mmol/L" : "mg/dL";
    var ageMinutes = null;
    var ageCoarse = false;     // "N hours ago" only says the hour: the true time is unknown (+-60 min)
    var whole = desc.toLowerCase();
    if (/just now|<\s*1\s*min|moments? ago/.test(whole)) {
        ageMinutes = 0;
    } else {
        var mm = whole.match(/(\d+)\s*(?:min|mins|minute|minutes)\b/);
        var hh = whole.match(/(\d+)\s*(?:h|hr|hrs|hour|hours)\b/);
        if (mm) ageMinutes = parseInt(mm[1], 10);
        else if (hh) { ageMinutes = parseInt(hh[1], 10) * 60; ageCoarse = true; }
    }
    return { value: value, unit: unit, ageMinutes: ageMinutes, ageCoarse: ageCoarse, raw: desc };
}

var DISMISS_RE = "(?i)^\\s*(I See|Remind me later|OK|Okay|Got it|I Know|I Understand|Understood|Confirm|Done|知道了|我知道了|确定|好的)\\s*$";

function clearAllDialogs() {
    var closed = 0;
    for (var i = 0; i < 12; i++) {
        var b = descMatches(DISMISS_RE).clickable(true).findOne(900);
        if (b == null) {
            b = descMatches(DISMISS_RE).clickable(true).findOne(1200);
            if (b == null) break;
        }
        b.click();
        closed++;
        sleep(1200);
    }
    return closed;
}

function readGlucose() {
    for (var attempt = 0; attempt < 12; attempt++) {
        var b = descMatches(DISMISS_RE).clickable(true).findOne(300);
        if (b != null) { b.click(); sleep(1200); }
        var candidates = descMatches("(?s).*mg/dL.*").find();
        for (var i = 0; i < candidates.length; i++) {
            var parsed = parseReading(candidates[i].desc());
            if (parsed) return parsed;
        }
        sleep(1000);
    }
    return null;
}

function snapToGrid(ts) {
    var d = new Date(ts);
    var sinceGrid = ((d.getMinutes() % 3) * 60 + d.getSeconds()) * 1000 + d.getMilliseconds();
    return sinceGrid > SYNC_PERIOD_MS / 2
        ? ts + (SYNC_PERIOD_MS - sinceGrid)
        : ts - sinceGrid;
}

// --- delivery (with queue) ----------------------------------------------------
function flushPending() {
    while (pending.length > 0) {
        var p = pending[0];
        var r = callApi("POST", "/bg", { mgdl: p.mgdl, ts: p.ts });
        if (r.ok || isDefinitive(r)) {
            if (!r.ok) log("queued reading rejected (" + r.code + "), dropping");
            pending.shift();
        } else {
            return false;
        }
    }
    return true;
}

function postReading(reading, fetchId) {
    var mgdl = reading.unit === "mmol/L" ? Math.round(reading.value * 18) : reading.value;
    var ts = Date.now();
    if (reading.ageMinutes !== null) ts -= reading.ageMinutes * 60000;
    ts = snapToGrid(ts);

    var body = { mgdl: mgdl, ts: ts };
    if (fetchId) body.id = fetchId;
    var r = callApi("POST", "/bg", body);
    if (r.ok) {
        log("sent ok (" + r.code + "): " + mgdl + " mg/dL" +
            (reading.ageMinutes !== null ? " / " + reading.ageMinutes + "m old" : "") +
            (onFallback() ? " [fallback]" : ""));
        flushPending();
        return true;
    }
    log("send failed (" + (r.err || r.code) + "): " + String(r.body).substring(0, 120));
    if (!isDefinitive(r)) {
        pending.push({ mgdl: mgdl, ts: ts });
        if (pending.length > MAX_PENDING) pending.shift();
        log("queued reading (" + pending.length + " pending)");
    } else {
        report("post_rejected", "HTTP " + r.code);
    }
    return false;
}

// --- one scrape ---------------------------------------------------------------
// Drag the list down from 29% to 71% of the screen height (the gesture that shows the app's
// "Refreshing in progress..." spinner), then wait for it to finish.
function pullToRefresh() {
    try {
        var x = device.width / 2;
        swipe(x, device.height * 0.29, x, device.height * 0.71, 450);
        log("pull-to-refresh, waiting " + (REFRESH_WAIT_MS / 1000) + "s");
    } catch (e) {
        log("pull-to-refresh failed (reading anyway): " + e);
    }
    sleep(REFRESH_WAIT_MS);
}

// What was on screen when the reading could not be found (small, only written on failure), so the next failure explains itself.
function dumpScreen(tag) {
    try {
        if (files.exists(FAIL_LOG_PATH) && files.read(FAIL_LOG_PATH).length > 200000) files.write(FAIL_LOG_PATH, "");
        var seen = [];
        var nodes = descMatches("(?s).+").find();
        for (var i = 0; i < nodes.length && seen.length < 30; i++) seen.push("d:" + String(nodes[i].desc()).replace(/\s+/g, " ").substring(0, 70));
        var tn = textMatches("(?s).+").find();
        for (var j = 0; j < tn.length && seen.length < 45; j++) seen.push("t:" + String(tn[j].text()).replace(/\s+/g, " ").substring(0, 70));
        files.append(FAIL_LOG_PATH, new Date().toISOString() + " " + tag + " pkg=" + currentPackage() + " screenOn=" + device.isScreenOn() + " nodes=" + JSON.stringify(seen) + "\n");
    } catch (e) {
        log("dumpScreen failed: " + e);
    }
}

function openAndRead() {
    app.launchPackage(ICAN_PKG);
    sleep(5000);
    var closed = clearAllDialogs();
    log(closed > 0 ? ("cleared " + closed + " dialog(s)") : "no dialog");
    sleep(closed > 0 ? 3000 : 1000);
    if (PULL_TO_REFRESH) {
        pullToRefresh();
        // the refresh can raise a fresh alert popup on top of the reading card
        var closed2 = clearAllDialogs();
        if (closed2 > 0) { log("cleared " + closed2 + " dialog(s) after refresh"); sleep(2000); }
    }
    return readGlucose();
}

function syncOnce(fetchId) {
    var wasAsleep = !device.isScreenOn();
    device.wakeUpIfNeeded();
    device.wakeUp();
    sleep(1500);
    if (wasAsleep) {
        swipe(device.width / 2, device.height * 0.9, device.width / 2, device.height * 0.1, 350);
        sleep(1500);
    }

    var reading = openAndRead();
    if (!reading) {
        // one recovery attempt: leave whatever page we are on, relaunch fresh
        log("glucose node not found - recovery retry");
        try { back(); sleep(600); back(); sleep(600); home(); sleep(1200); } catch (e) {}
        reading = openAndRead();
    }
    if (!reading) {
        // last resort: the pull-to-refresh itself can leave the card unreadable for a while, so read the app as it is, without pulling
        dumpScreen("retry-failed");
        log("glucose node not found after retry - reading without pull-to-refresh");
        try { app.launchPackage(ICAN_PKG); sleep(8000); clearAllDialogs(); } catch (e) {}
        reading = readGlucose();
        if (reading) log("read without pull-to-refresh worked");
    }
    if (!reading) {
        dumpScreen("final-failed");
        log("glucose node not found after retry");
        report("scrape_failed", "reading not found on screen after recovery retry");
        home();
        return false;
    }
    if (reading.ageMinutes !== null && reading.ageMinutes >= STALE_REPORT_AGE_MIN) {
        report("source_stale", "iCan Reach shows data " + reading.ageMinutes + " min old (sensor/primary phone side)");
    }
    if (reading.ageCoarse) {
        // An hour-level label ("1 hours ago") cannot give the reading's real time. Posting it would stamp the
        // same stale value at now-60min / now-120min: a made-up timestamp. The reading was already stored when
        // it was fresh, so skip it and let the server show the honest gap.
        log("age is hour-level (" + reading.ageMinutes + "m): not posting a guessed timestamp");
        home();
        return true;
    }
    postReading(reading, fetchId);
    home();
    return true;
}

// ask the backend whether a scrape is wanted right now
function pollForFetch() {
    var r = callApi("GET", "/agent/poll" + batteryQuery());
    if (r.ok) {
        try {
            var j = JSON.parse(r.body);
            if (j && j.fetch) return j.id || "";
        } catch (e) { log("poll parse error: " + e); }
        return null;
    }
    log("poll failed (" + (r.err || r.code) + ")");
    return null;
}

// --------------------------------------------------------------------- main ---
if (lockHeldByOther()) {
    log("another glucose_sync instance is active - exiting");
    exit();
}
refreshLock();
acquireWakeLock();
cfg = loadConfig();
if (!cfg.token) log("WARNING: no token in " + CONFIG_PATH);
log("glucose agent " + AGENT_VERSION + " started - endpoints: " + cfg.ep.map(function (e) { return e.base; }).join(", "));
report("started", AGENT_VERSION);

var lastScrape = 0;
while (true) {
    refreshLock();
    if (lockHeldByOther()) { log("lock lost to another instance - exiting"); exit(); }

    var reason = null, fetchId = null;
    var id = pollForFetch();
    if (id !== null) { reason = "fetch flag"; fetchId = id; }
    else if (Date.now() - lastScrape > SAFETY_SCRAPE_MS) { reason = "safety"; }

    if (reason !== null) {
        log("scrape (" + reason + (fetchId ? " id=" + fetchId.substring(0, 8) : "") + ")");
        try { syncOnce(fetchId); lastScrape = Date.now(); }
        catch (e) {
            log("cycle error (continuing): " + e);
            report("cycle_error", e);
            try { home(); } catch (e2) {}
        }
    }
    if (pending.length > 0) { try { flushPending(); } catch (e3) {} }
    try { refreshEndpoints(); } catch (e4) { log("discovery error: " + e4); }
    sleep(onFallback() ? FALLBACK_POLL_MS : POLL_MS);
}
