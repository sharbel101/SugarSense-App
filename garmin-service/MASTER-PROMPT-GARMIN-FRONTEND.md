# Prompt for the frontend AI: wire SugarSense to the Garmin metrics API

STATUS: the API is implemented and tested offline (99 tests) but NOT deployed yet. Do not code against the live URL until the backend chat confirms deployment and gives you the base URL and token. Until then build against the typed client and fixtures below.

Copy everything below this line into the frontend chat.

---

You are the SugarSense frontend AI (`mobile/`, React Native + Expo + TypeScript). Follow `CLAUDE.md` section 2 (safety, UI language) and `mobile/docs/UIUX_COMPLIANCE.md`. Add a read-only display of Garmin wearable data from our own backend API.

## Hard rules
- Never contact Garmin, and never store Garmin credentials. Only call the SugarSense Garmin API below.
- Polling this API is free: it only reads our database and never triggers a Garmin request. You may refresh every 60 s while the screen is visible, and not at all in the background.
- Measured activity and heart rate are shown as measurements with their age. NEVER present elevated heart rate, activity or stress as proof of low glucose, and never merge them into any hypoglycaemia-risk number; keep them visually separate from model-estimated risk. Garmin does not measure glucose.
- Copy: "Measured by your Garmin watch", "last synced X ago". Not medical advice.

## API (base URL and token: from the backend chat; keep in `EXPO_PUBLIC_GARMIN_API_URL`, `EXPO_PUBLIC_GARMIN_API_TOKEN`)
Header on every call except health: `x-app-token: <token>`. The token only keeps scanners out; it is not user authentication. Prefix: `/api/garmin/v1`. All timestamps are UTC ISO strings ending in `Z`.

- `GET /health` -> `{status:"ok", service, time}` (no token).
- `GET /metrics` -> catalogue: `{metrics:{name:{unit,kind,origin,group,stale_after_seconds,description}}, unsupported:{name:reason}}`.
- `GET /metrics/latest?metrics=a,b` (optional) -> `{source, generated_at, last_successful_fetch_at, metrics:{name:Entry}, data_freshness:"fresh"|"mixed"|"stale"|"no_data", missing_metrics:string[], warnings:string[]}`.
- `GET /metrics/history?metrics=a,b&from=ISO&to=ISO&limit=N&cursor=C` -> `{count, limit, has_more, next_cursor, observations:[{metric, ...Entry fields}]}` ascending by `measured_at`. `metrics` required; `from`/`to` need a time zone; max range 14 days; limit 1-2000 (default 500). Page with `cursor` while `has_more`.
- `GET /status` -> `{polling:{enabled,state:"normal"|"paused"|"backing_off"|"circuit_breaker_open"|"worker_not_running",paused_reason,worker_alive,backoff_until,breaker_open_until,...}, last_successful_poll_at, groups:{fast|stress|sleep|hrv|spo2_resp|readiness:{last_attempt_at,last_successful_fetch_at,last_new_data_at,last_measurement_at,last_outcome,consecutive_failures,stale,stale_metrics}}, data_stale, counters_24h, recent_errors, unsupported}`.
- Errors: HTTP 400/401/405/429/500/503 with `{error:{code,message}}`. 503 `auth_not_configured` or `storage_unavailable` = show "Garmin data unavailable", never a number.

```ts
export type Kind = 'instant' | 'interval' | 'cumulative' | 'daily_summary' | 'event';
export type TsSemantics = 'instant' | 'interval_start' | 'period_start' | 'period_end';
export interface Entry {
  value: number | Record<string, unknown>; // number, or an object for structured metrics (sleep_stages, hrv_status)
  unit: string | null; kind: Kind; origin: 'raw_sensor' | 'garmin_derived';
  measured_at: string; ts_semantics: TsSemantics; fetched_at: string;
  age_seconds: number; fetched_age_seconds: number; quality: 'available' | 'stale';
  interval_seconds?: number; period?: string; period_date?: string;
  details?: Record<string, unknown>; meta?: Record<string, unknown>;
}
export interface LatestResponse { source: 'garmin'; generated_at: string; last_successful_fetch_at: string | null;
  metrics: Record<string, Entry>; data_freshness: 'fresh' | 'mixed' | 'stale' | 'no_data'; missing_metrics: string[]; warnings: string[] }
export type Observation = Omit<Entry, 'age_seconds' | 'fetched_age_seconds' | 'quality'> & { metric: string };
export interface HistoryResponse { count: number; limit: number; has_more: boolean; next_cursor: string | null; observations: Observation[] }
```

Metric names you can rely on: `heart_rate` (bpm, instant, about every 2 minutes), `steps_day_cumulative` (running day total: show the latest, NEVER sum rows), `distance_day_cumulative`, `intensity_minutes_moderate_day`, `intensity_minutes_vigorous_day`, `active_kcal_day`, `exercise_session` (event; value = duration s, `details` has type/distance/avg_hr), `body_battery` (0-100, Garmin-calculated, a few points a day), `stress_day_avg` (daily, Garmin-calculated), `resting_heart_rate`, `resting_heart_rate_7d_avg`, `heart_rate_day_max/min`, `sleep_duration`, `sleep_score`, `sleep_stages`, `sleep_avg_stress`, `hrv_overnight_avg`, `hrv_status`, `spo2_day_avg/lowest`, `spo2_sleep_avg`, `respiration_*`. Not available any more: per-15-minute steps, activity level, and a stress score across the day (the official API gives daily totals only). Absent metrics: show "no data yet", never 0.

## Build
1. `mobile/src/api/garminClient.ts`: typed client (fetch with 10 s timeout, token header, error mapping to a discriminated result type; no retries on 4xx; one retry with backoff on network error/503). Parse dates with `new Date(iso)`; format in the user's local zone only at display time.
2. A hook `useGarminLatest()` (refresh every 60 s while focused, pause when the app is backgrounded) and `useGarminHistory(metrics, from, to)` that follows `next_cursor`.
3. UI (place it in the existing Wearable screen, `mobile/src/screens/WearableScreen.tsx`, following the repo's design system): a heart-rate chart for the last 6 h (points, gaps left as gaps, no interpolation), today's steps (latest cumulative) plus a bar chart of `steps_interval`, activity level strip, stress/body-battery sparkline, last sleep card (duration, stages, score, HRV) and exercise list. Each card shows "measured HH:mm (X min ago)" from `age_seconds`, and a plain-language Garmin-calculated badge when `origin === 'garmin_derived'`.
4. States for every card: loading skeleton; error (network/401/503) with retry; empty ("no data yet"); stale (`quality === 'stale'`, grey with the age); paused/backing-off banner from `/status.polling.state`.
5. Stale versus unchanged: use `/status`. If `groups.fast.last_successful_fetch_at` is recent but `last_measurement_at` is old, say "Waiting for your watch to sync" (the watch uploads in batches, a 20-30 minute lag is normal). If the last successful fetch itself is old or `state !== 'normal'`, say "Garmin data is not updating" with the reason. Do not call an unchanged value stale just because it did not move.
6. Later link to the hypoglycaemia-risk model (not now): the model may consume `heart_rate`, `steps_day_cumulative`/`exercise_session_level` and `exercise_session` as separate features with their `age_seconds` and a coverage flag (missing = coverage 0, never zero). Expose them as typed selectors only; do not compute risk in the UI.
7. Tests (the repo's runner): client success/401/503/network/timeout mapping; cursor paging; `missing_metrics` renders "no data yet"; cumulative steps are never summed; stale and paused states; UTC to local formatting around the DST change on 25 Oct 2026 (Lebanon).

Report real test output before saying it works.
