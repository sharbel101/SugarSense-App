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

var AGENT_VERSION = "v4.0-2026-10-22";
var FAIL_LOG_PATH = "/sdcard/Download/glucose_fail.log";
var MAIN_PATH = "/sdcard/Download/glucose_sync.js";
var WATCHDOG_PATH = "/sdcard/Download/glucose_watchdog.js";
var RETRY_AFTER_FAIL_MS = 90 * 1000;   // after a failed scrape try again in 90 s, not after the whole safety period
var STALE_RESTART_MIN = 20;            // iCan Reach still shows data this old after a refresh: restart the app (rate limited)
var FAIL_RESTART_COUNT = 2;            // ... or after this many failed scrapes in a row
var RESTART_MIN_GAP_MS = 15 * 60 * 1000;
var RESTART_BACKOFF_MS = 60 * 60 * 1000;   // a restart that did not bring newer data means the gap is on the sensor/primary-phone side: ask again only hourly

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

// --- keep the SCREEN on while a scrape runs ----------------------------------
// The screen times out after 15 s but a scrape takes 30-60 s. Reads failed when the screen went to sleep in the middle, and a pull gesture on a dark or
// half-woken phone opens the notification shade instead of refreshing iCan Reach (see glucose_fail.log). The old SCREEN wake lock is ignored by Android for
// an app like AutoJs6 (targetSdk 36), so a 1-pixel, untouchable overlay window with keepScreenOn is used instead (tested: the display stays on past the
// timeout). It lives only while a scrape runs and is closed when this script ends.
var screenWin = null;
function holdScreen() {
    try {
        if (screenWin == null) {
            screenWin = floaty.rawWindow('<frame w="1px" h="1px" keepScreenOn="true"/>');
            screenWin.setTouchable(false);
            screenWin.setPosition(0, 0);
        }
    } catch (e) {
        screenWin = null;
        log("screen hold failed (continuing): " + e);
    }
}
function releaseScreen() {
    try { if (screenWin != null) screenWin.close(); } catch (e) {}
    screenWin = null;
}
try { events.on("exit", releaseScreen); } catch (e) {}

function keyguardLocked() {
    try { return context.getSystemService(context.KEYGUARD_SERVICE).isKeyguardLocked(); } catch (e) { return false; }
}
function foreground() {
    try { return String(currentPackage()); } catch (e) { return ""; }
}

// Collapse whatever covers the app (notification shade, quick settings) and go back to a known state.
function clearOverlays() {
    try {
        if (foreground() === "com.android.systemui") {
            back();
            sleep(500);
            if (foreground() === "com.android.systemui") {
                swipe(device.width / 2, device.height * 0.5, device.width / 2, device.height * 0.02, 300);
                sleep(500);
            }
        }
        home();
        sleep(800);
    } catch (e) {}
}

// Bring iCan Reach to the front and CONFIRM it is there before any gesture is made.
function ensureIcanForeground() {
    for (var attempt = 0; attempt < 3; attempt++) {
        app.launchPackage(ICAN_PKG);
        for (var w = 0; w < 10; w++) {
            if (foreground() === ICAN_PKG) return true;
            sleep(1000);
        }
        log("iCan Reach is not in front (" + foreground() + ") - clearing overlays");
        clearOverlays();
    }
    return false;
}

function wakeAndUnlock() {
    for (var i = 0; i < 4 && !device.isScreenOn(); i++) {
        device.wakeUpIfNeeded();
        device.wakeUp();
        sleep(1200);
    }
    if (keyguardLocked()) {
        swipe(device.width / 2, device.height * 0.9, device.width / 2, device.height * 0.1, 350);
        sleep(1200);
    }
}

// Last resort when iCan Reach itself looks stuck: force-stop it from Android's app-info page and start it fresh. Rate limited, every step logged.
var lastRestart = 0;
var restartGapMs = RESTART_MIN_GAP_MS;
var failStreak = 0;
function forceRestartIcan(why) {
    if (Date.now() - lastRestart < restartGapMs) return false;
    lastRestart = Date.now();
    log("restarting iCan Reach: " + why);
    report("ican_restart", why);
    try {
        app.openAppSetting(ICAN_PKG);
        sleep(2500);
        var btn = textMatches("(?i)(force stop|force close)").findOne(4000);
        if (btn == null) btn = descMatches("(?i)(force stop|force close)").findOne(1500);
        if (btn == null) {
            log("force-stop button not found");
            dumpScreen("no-force-stop");
            home();
            return false;
        }
        if (btn.enabled()) {
            var tgt = btn;
            var up = 0;
            while (tgt != null && !tgt.clickable() && up < 4) { tgt = tgt.parent(); up++; }
            (tgt != null ? tgt : btn).click();
            sleep(1500);
            var ok = textMatches("(?i)(ok|force stop|force close)").clickable(true).findOne(3000);
            if (ok != null) { ok.click(); sleep(1500); } else { log("force-stop confirmation not found"); }
        } else {
            log("force-stop is disabled (the app is not running)");
        }
        home();
        sleep(1000);
        app.launchPackage(ICAN_PKG);
        sleep(8000);
        clearAllDialogs();
        return true;
    } catch (e) {
        log("force restart failed: " + e);
        try { home(); } catch (e2) {}
        return false;
    }
}

// The watchdog (glucose_watchdog.js) restarts this script if it stops; this script makes sure the watchdog is running.
function ensureWatchdog() {
    try {
        var list = engines.all();
        for (var i = 0; i < list.length; i++) {
            if (String(list[i].getSource()).indexOf("glucose_watchdog") >= 0) return;
        }
        if (files.exists(WATCHDOG_PATH)) {
            engines.execScriptFile(WATCHDOG_PATH);
            log("watchdog started");
        }
    } catch (e) {
        log("watchdog check failed: " + e);
    }
}

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
    if (/\d{1,2}\/\d{1,2}\/\d{4}/.test(descStr)) return null;   // the detail page (date + value + sensor age), not the list card
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
    if (!ensureIcanForeground()) {
        log("could not bring iCan Reach to the front");
        return null;
    }
    sleep(4000);
    var closed = clearAllDialogs();
    log(closed > 0 ? ("cleared " + closed + " dialog(s)") : "no dialog");
    sleep(closed > 0 ? 3000 : 1000);
    // iCan Reach resumes on whatever page it was left on. The reading must come from the list page, so leave the detail page first.
    for (var k = 0; k < 2; k++) {
        if (descMatches("(?s).*\\d{1,2}/\\d{1,2}/\\d{4}.*mg/dL.*").exists()) {
            log("iCan Reach is on its detail page - going back to the list");
            back();
            sleep(1500);
        } else break;
    }
    if (PULL_TO_REFRESH && foreground() === ICAN_PKG) {
        pullToRefresh();
        // the refresh can raise a fresh alert popup on top of the reading card
        var closed2 = clearAllDialogs();
        if (closed2 > 0) { log("cleared " + closed2 + " dialog(s) after refresh"); sleep(2000); }
    }
    return readGlucose();
}

function syncOnce(fetchId) {
    holdScreen();
    try {
        return syncOnceInner(fetchId);
    } finally {
        releaseScreen();
    }
}

function syncOnceInner(fetchId) {
    wakeAndUnlock();
    if (foreground() === "com.android.systemui") clearOverlays();

    var reading = openAndRead();
    if (!reading) {
        // one recovery attempt: leave whatever page we are on, relaunch fresh
        log("glucose node not found - recovery retry");
        clearOverlays();
        reading = openAndRead();
    }
    if (!reading) {
        // the pull-to-refresh itself can leave the card unreadable for a while, so read the app as it is, without pulling
        dumpScreen("retry-failed");
        log("glucose node not found after retry - reading without pull-to-refresh");
        try { if (ensureIcanForeground()) { sleep(6000); clearAllDialogs(); } } catch (e) {}
        reading = readGlucose();
        if (reading) log("read without pull-to-refresh worked");
    }
    if (!reading) {
        failStreak++;
        dumpScreen("final-failed");
        log("glucose node not found (failed scrapes in a row: " + failStreak + ")");
        if (failStreak >= FAIL_RESTART_COUNT && forceRestartIcan(failStreak + " scrapes in a row could not read the screen")) {
            reading = openAndRead();
            if (reading) log("read after restarting iCan Reach");
        }
    }
    if (!reading) {
        report("scrape_failed", "reading not found on screen after recovery retry (" + failStreak + " in a row)");
        home();
        return false;
    }
    failStreak = 0;
    if (reading.ageMinutes !== null && reading.ageMinutes >= STALE_REPORT_AGE_MIN) {
        report("source_stale", "iCan Reach shows data " + reading.ageMinutes + " min old (sensor/primary phone side)");
    }
    if (reading.ageMinutes !== null && reading.ageMinutes >= STALE_RESTART_MIN && !reading.ageCoarse) {
        // The follower app can be stuck while the primary phone is fine: one rate-limited restart, then read again.
        if (forceRestartIcan("iCan Reach shows data " + reading.ageMinutes + " min old after a refresh")) {
            var again = openAndRead();
            if (again) {
                log("after restart iCan Reach shows " + (again.ageMinutes === null ? "?" : again.ageMinutes) + " min old data");
                reading = again;
                // newer data after the restart = the app was stuck (restart again soon if it recurs); the same old data = the sensor side has not uploaded
                restartGapMs = (again.ageMinutes !== null && again.ageMinutes >= STALE_RESTART_MIN) ? RESTART_BACKOFF_MS : RESTART_MIN_GAP_MS;
                if (restartGapMs === RESTART_BACKOFF_MS) report("source_gap", "restarting iCan Reach did not bring newer data (" + again.ageMinutes + " min old): the sensor or the primary phone is not uploading");
            }
        }
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
ensureWatchdog();
var lastWatchdogCheck = Date.now();

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
        try {
            var ok = syncOnce(fetchId);
            lastScrape = ok ? Date.now() : Date.now() - SAFETY_SCRAPE_MS + RETRY_AFTER_FAIL_MS;   // a failed scrape is retried in 90 s
        }
        catch (e) {
            log("cycle error (continuing): " + e);
            report("cycle_error", e);
            try { home(); } catch (e2) {}
        }
    }
    if (Date.now() - lastWatchdogCheck > 5 * 60 * 1000) { lastWatchdogCheck = Date.now(); ensureWatchdog(); }
    if (pending.length > 0) { try { flushPending(); } catch (e3) {} }
    try { refreshEndpoints(); } catch (e4) { log("discovery error: " + e4); }
    sleep(onFallback() ? FALLBACK_POLL_MS : POLL_MS);
}
