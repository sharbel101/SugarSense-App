// glucose_watchdog.js - keeps glucose_sync.js running without a laptop.
// glucose_sync.js writes a heartbeat to glucose_sync.lock every loop (at most about 90 s apart while a scrape runs). If the script is not running, or the
// heartbeat is older than 5 minutes (a hung script), this restarts it. glucose_sync.js in turn makes sure this watchdog is running.
// No "auto" directive: it must keep working even if the accessibility service is off. ES5 only (Rhino).

var MAIN_PATH = "/sdcard/Download/glucose_sync.js";
var LOCK_PATH = "/sdcard/Download/glucose_sync.lock";
var CHECK_MS = 45 * 1000;
var STALE_MS = 5 * 60 * 1000;
var MIN_RESTART_GAP_MS = 2 * 60 * 1000;   // never restart in a loop

function wlog(m) { console.log("[watchdog] " + m); }

// single instance: this engine is itself in the list, so more than one watchdog engine means another one is already running
(function () {
    try {
        var list = engines.all();
        var n = 0;
        for (var i = 0; i < list.length; i++) {
            if (String(list[i].getSource()).indexOf("glucose_watchdog") >= 0) n++;
        }
        if (n > 1) { wlog("another watchdog is running - exiting"); exit(); }
    } catch (e) {}
})();

var wake = null;
try {
    var pm = context.getSystemService(context.POWER_SERVICE);
    wake = pm.newWakeLock(1, "glucoguard:watchdog");   // PARTIAL_WAKE_LOCK: the CPU keeps running between checks
    wake.setReferenceCounted(false);
    wake.acquire();
} catch (e) { wlog("wake lock failed (continuing): " + e); }
try { events.on("exit", function () { try { if (wake != null && wake.isHeld()) wake.release(); } catch (e) {} }); } catch (e) {}

function mainEngines() {
    var out = [];
    try {
        var list = engines.all();
        for (var i = 0; i < list.length; i++) {
            if (String(list[i].getSource()).indexOf("glucose_sync.js") >= 0) out.push(list[i]);
        }
    } catch (e) {}
    return out;
}

function lastBeat() {
    try {
        if (!files.exists(LOCK_PATH)) return 0;
        return parseInt(files.read(LOCK_PATH).split("|")[1], 10) || 0;
    } catch (e) { return 0; }
}

wlog("started");
var lastRestart = 0;
while (true) {
    try {
        var running = mainEngines();
        var age = Date.now() - lastBeat();
        var dead = running.length === 0;
        var hung = !dead && age > STALE_MS;
        if ((dead || hung) && Date.now() - lastRestart > MIN_RESTART_GAP_MS) {
            lastRestart = Date.now();
            wlog((dead ? "glucose_sync is not running" : "glucose_sync heartbeat is " + Math.round(age / 1000) + " s old") + " - restarting it");
            for (var i = 0; i < running.length; i++) { try { running[i].forceStop(); } catch (e1) {} }
            try { files.remove(LOCK_PATH); } catch (e2) {}
            sleep(1500);
            engines.execScriptFile(MAIN_PATH);
        }
    } catch (e3) {
        wlog("check failed: " + e3);
    }
    sleep(CHECK_MS);
}
