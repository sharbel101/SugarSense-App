Wire the SugarSense app to our live Garmin data API and show it on the Wearable screen (`mobile/src/screens/WearableScreen.tsx`). Follow `CLAUDE.md` section 2 and the repo's design system. Full contract: `garmin-service/MASTER-PROMPT-GARMIN-FRONTEND.md`.

API (live now):
- Base URL: `https://entitle-evacuate-removed.ngrok-free.dev/api/garmin/v1` (put in `EXPO_PUBLIC_GARMIN_API_URL`). On the web build served from the VM (port 8090) the same path works same-origin: `/api/garmin/v1`.
- Header on every call except `/health`: `x-app-token: <EXPO_PUBLIC_GARMIN_API_TOKEN>`. Also send `ngrok-skip-browser-warning: 1` when using the ngrok URL. The user will give you the token; never hard-code or commit it.
- `GET /metrics/latest` -> `{generated_at, last_successful_fetch_at, metrics:{name:{value,unit,kind,origin,measured_at,age_seconds,quality:"available"|"stale",...}}, data_freshness, missing_metrics, warnings}`.
- `GET /metrics/history?metrics=heart_rate,body_battery&from=<ISO with Z>&to=<ISO>&limit=500` -> `{observations:[{metric,value,unit,measured_at,...}], has_more, next_cursor}`, oldest first; ALWAYS pass `from` (for example now minus 6 h) or you get the oldest day data. Follow `next_cursor` while `has_more`.
- `GET /status` -> `{polling:{state,paused_reason}, groups:{fast:{last_successful_fetch_at,last_measurement_at,stale}}, data_stale}`.
- Metrics: `heart_rate` (about every 2 min, arrives in batches after the watch syncs), `steps_day_cumulative` (show the latest value, never add rows), `body_battery` (a few points a day), `stress_day_avg` (daily), `sleep_duration`, `sleep_score`, `sleep_stages`, `hrv_overnight_avg`, `resting_heart_rate`, `spo2_*`, `respiration_*`, `exercise_session`. There is no per-15-minute step series and no stress series across the day. Absent metrics are listed in `missing_metrics`: show "no data yet", never 0.

Build: a typed client (10 s timeout, error mapping for 401/429/503/network), a hook that refreshes `/metrics/latest` every 60 s while the screen is focused (this only reads our database; pull-to-refresh and opening the screen first send `POST /refresh`, which makes the server read Garmin now, with no time limit between presses), heart-rate line chart for the last 6 h (gaps stay gaps), today's steps with 15-minute bars, stress/body-battery sparkline, last-night sleep card (duration, stages, score, HRV), exercise list. Every card shows "measured HH:mm (X min ago)" from `age_seconds`; mark `origin: "garmin_derived"` values "calculated by Garmin". Timestamps are UTC (`Z`): convert to local only when displaying.

Important states: the watch syncs in batches, so data 20 min to a few hours old is normal. If `quality` is `stale` but `/status.groups.fast.last_successful_fetch_at` is recent, say "Waiting for your watch to sync"; if the fetch itself is old or `polling.state != "normal"`, say "Garmin data is not updating". Show loading, error (retry), empty and stale states.

Safety: do not connect to Garmin directly. Show measured heart rate/activity/stress separately from any model-estimated hypoglycaemia risk and never imply they prove low glucose (Garmin does not measure glucose). Not medical advice.

Add tests for the client (success, 401, 503, timeout), cumulative steps not being summed, and the stale vs not-updating messages. Show real test output before saying it works.
