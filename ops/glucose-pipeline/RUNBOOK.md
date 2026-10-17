# Glucose pipeline: architecture, failure matrix and agent runbook

Audience: an AI agent (or human) woken because `bg-guardian` opened an incident, or asked to check why glucose
data is not arriving. Read this fully before touching anything. This pipeline carries the user's real glucose
for a watch face and a low-glucose alert policy: be careful, be minimal, report honestly.

## 1. The chain (and which links are NOT ours to fix)

```
sensor -> primary phone (iCan app, BLE) -> Sinocare cloud -> iCan Reach follower app (the A70 phone, USB to the laptop)
   -> AutoJs6 script glucose_sync.js  --HTTPS-->  Cloudflare quick tunnel(s) [primary]  / ngrok static domain [fallback]
   -> bg_service :8000 (bg.db) -> forecast :8001 -> NestJS :3000 -> web/app;  watch -> ngrok -> nginx :80 -> bg_service
```

- Everything left of "AutoJs6 script" is the sensor/Sinocare side. When iCan Reach itself stops advancing the
  pipeline is healthy and **correctly** reports stale data. That is `SENSOR_SIDE_GAP` (info). Do not "fix" it,
  do not wake the user for it. (Evidence 2026-10-17: 24 h with zero phone-poll gaps > 60 s and a delivery every
  5 min, while the follower app froze for 30-50 min several times; the user confirmed the CGM had disconnected.)
- Everything from the script rightwards is ours.

## 2. Where state lives (all read-only checks are safe)

| What | Where |
|---|---|
| Open incident | VM `~/bg/guardian/incidents/current.json` (absent = no open incident) |
| Closed incidents | VM `~/bg/guardian/incidents/history.jsonl` |
| Latest facts + findings | VM `~/bg/guardian/status.json` |
| Acknowledge | `touch ~/bg/guardian/incidents/ack` (stops reminders; removed when the incident closes) |
| Collector health | `GET /agent/status` on bg_service (needs the token; read it server-side: `grep ^API_AUTH_TOKEN= ~/API/.env`, never print it) |
| Phone script log | `adb logcat -d | grep GlobalConsole` (laptop, phone on USB) |
| Phone script + config | `/sdcard/Download/glucose_sync.js`, `glucose_config.json`, `glucose_endpoints.json`, backup `glucose_sync.v1.bak.js` |
| Repo copy of the phone script | `ops/glucose-pipeline/phone/glucose_sync.js` |

SSH: `ssh -i C:\Users\Pc\.ssh\oracle_sep5.key ubuntu@139.185.53.135` (key only). adb:
`C:\Users\Pc\AppData\Local\Android\Sdk\platform-tools\adb.exe` (use PowerShell for `adb push`, Git Bash mangles `/sdcard`).

Quick triage (read-only):
```bash
ssh -i KEY ubuntu@139.185.53.135 'cat ~/bg/guardian/incidents/current.json 2>/dev/null || echo "no open incident"; echo; python3 -c "import json;s=json.load(open(\"/home/ubuntu/bg/guardian/status.json\"));print(s[\"at\"]);print(s[\"units\"]);print(s[\"tunnels\"]);print(s[\"collector\"])"'
```

## 3. Decision tree by incident code

| Code | Meaning | What to do |
|---|---|---|
| `SENSOR_SIDE_GAP` (info) | follower app data not advancing | Nothing. Optionally tell the user "sensor / primary phone side". |
| `PHONE_OFFLINE` | script stopped polling, public path healthy | 1) `adb devices`: phone not listed -> phone off/unplugged/USB: **expected, report, do not fix**. 2) Phone listed -> `adb logcat -d | grep GlobalConsole | tail`: is the script running? If not, restart it (section 4). 3) Script running but not polling -> Wi-Fi? `adb shell dumpsys connectivity | grep -i validated`. |
| `COLLECTOR_SCRAPE_FAILING` | script alive, cannot read/deliver | Read `recent_events` in `/agent/status` and the phone log. Screenshot iCan Reach (`adb exec-out screencap -p`): logged out? new popup/consent screen? update dialog? Clear it (tap on-screen via adb), then restart the script. If a login is needed, **stop and tell the user** (never type credentials). |
| `QUICK_TUNNELS_DOWN` | no cloudflared tunnel reachable; phone should be on the ngrok fallback | `systemctl status bg-cloudflared`; `sudo systemctl restart bg-cloudflared` (new URL; guardian republishes it, phone re-discovers within ~10 min on fallback). Confirm via `~/bg/guardian/status.json`. |
| `TUNNEL_DOWN:<n>` | one of several tunnels down | Informational unless it persists; the manual legacy tunnel (`cloudflared tunnel --url http://localhost:8000`, log `~/cloudflared.log`) is unsupervised: if dead, leave it, the supervised one carries the load. |
| `NGROK_DOWN` | ngrok agent/endpoint not reachable (watch + Expo Go lose their API) | `systemctl status bg-ngrok-tunnel`; `sudo systemctl restart bg-ngrok-tunnel`. **Never start a second ngrok on the same domain** (ERR_NGROK_334 crash loop). `sugarsense-ngrok` must stay disabled. |
| `ALL_TUNNELS_DOWN` | phone and watch both cut off | VM outbound internet? `curl -s -m5 https://1.1.1.1`. Restart `bg-cloudflared` then `bg-ngrok-tunnel`. If the VM itself is unreachable by SSH: tell the user, check the Oracle console. |
| `SERVICE_DOWN:<unit>` | systemd unit inactive/failed | `systemctl status <unit>`, `journalctl -u <unit> -n 80 --no-pager`; restart only that unit. Do not edit code to make it start; report the cause. |
| `LOCAL_ENDPOINT_DOWN:<n>` | unit active but health check failing | Read the unit's journal; restart that unit once; if it fails again report, do not loop. |
| `BG_API_UNREACHABLE` | bg_service not answering locally | `journalctl -u bg.service -n 80`; `sudo systemctl restart bg.service` (state resets, scheduler re-learns the watch cadence within ~15 min: harmless). |
| `DISK_LOW` | < 10 % free | Find the largest recent growth (`du -xh --max-depth=2 / | sort -h | tail`); journal vacuum (`sudo journalctl --vacuum-size=200M`) is safe; delete nothing else without asking. |
| `NGROK_QUOTA_70/90` | free plan: 20,000 HTTP requests/month, then the watch API stops | Find who is hitting ngrok (`curl -s localhost:4040/api/requests/http?limit=50`): Expo Go polling `/glucose` each 60 s is the usual cause. Tell the user; do not move the phone onto ngrok. |
| `PHONE_BATTERY_LOW` | <= 20 % and not charging | Tell the user to plug the phone in. |

## 4. Restarting the phone script (the only phone-side action pre-approved)

```powershell
$adb = "C:\Users\Pc\AppData\Local\Android\Sdk\platform-tools\adb.exe"
function RunScript($p) { & $adb shell "am start -n org.autojs.autojs6/org.autojs.autojs.external.open.RunIntentActivity -a android.intent.action.VIEW -d file://$p -t application/x-javascript" | Out-Null }
RunScript "/sdcard/Download/stopall.js"; Start-Sleep 4
& $adb shell "rm -f /sdcard/Download/glucose_sync.lock"
& $adb logcat -c
RunScript "/sdcard/Download/glucose_sync.js"; Start-Sleep 25
& $adb logcat -d | Select-String GlobalConsole | Select-Object -Last 8
```
Healthy log: `glucose agent v3-... started`, then `scrape (...)`, `sent ok (200): ...`. To roll back to the old
script: `adb shell cp /sdcard/Download/glucose_sync.v1.bak.js /sdcard/Download/glucose_sync.js` then restart.
The boot task re-runs `/sdcard/Download/glucose_sync.js` after a phone reboot. If AutoJs6 lost its accessibility
service: `adb shell settings put secure enabled_accessibility_services org.autojs.autojs6/org.autojs.autojs.core.accessibility.AccessibilityServiceUsher; adb shell settings put secure accessibility_enabled 1`.

## 5. Hard limits for unattended agents

Allowed without asking: read-only checks above; restart of **one named unit** from section 3; restart of the phone
script (section 4); `touch ack`; writing a short note in the incident report you hand back.

Never, without the user: edit `bg_service.py`, the models, `bg.db`, `forecast.env`, `/etc/nginx` or any unit
file; change alert thresholds or the LOW policy; rotate or print tokens; log into iCan Reach / any account;
delete files; reboot the VM or the phone; switch `HYPER_EXCURSION_MODE`; start extra tunnels on the ngrok
domain; run commands on the user's other devices. If the fix is not in section 3, stop and report.

Always: say what you saw (code, since when, evidence), what you did, and whether the incident cleared
(`incidents/current.json` gone). Never claim fixed without re-reading `/agent/status` showing `state: ok` and
`reading_age_s` small, or an honest "sensor-side, not ours".

## 6. How the self-healing works (so you know what NOT to redo by hand)

- Phone script v3 tries the primary tunnel first, fails over to the ngrok static domain within ~1 s, polls
  slowly there (ngrok free = 20,000 requests/month), retries the primary every 5 min, and while on the
  fallback asks `GET <ngrok>/agent/endpoints` (served by bg-guardian) for the current quick-tunnel URLs and
  stores them in `glucose_endpoints.json`. Undelivered readings are queued (max 40) and sent later with their
  true timestamps.
- `bg-cloudflared` restarts a dead tunnel in 5 s (new hostname); `bg-guardian` republishes it.
- Debounce prevents flapping from waking anyone: services 60 s, tunnels 2-10 min, scrape failures 10 min,
  phone offline 15 min.
