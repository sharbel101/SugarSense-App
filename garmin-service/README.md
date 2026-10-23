# Garmin metrics service (official Personal API poller + read-only API)

`gsvc/` reads your Garmin data from **Garmin's official Personal API** and stores it in PostgreSQL (migration `backend/db/migrations/0011_garmin_metrics.sql`).
A second, separate process serves the stored data at `/api/garmin/v1/*` (default `127.0.0.1:8310`, reached only through nginx). Every GET answers from the database; the one route that reaches Garmin is `POST /refresh`, which the app calls each time you open the Wearable screen or pull to refresh (see below).
Frontend contract: `MASTER-PROMPT-GARMIN-FRONTEND.md`.

There is nothing to sign in to: you create one **Personal API key** in Garmin Connect (Settings > Personal API token). The poller exchanges it for a 24 h bearer
token (renewed automatically) and makes read-only GET requests. No password, no MFA, no third-party gateway, no browser login.

## What it fetches (about 9 requests every 10 minutes)

| Every cycle (10 min) | Every 30 min | Hourly |
|---|---|---|
| heart rate (about every 2 min), day summary (steps, distance, intensity minutes, active calories, stress average, SpO2, respiration) | body battery, last night's sleep, overnight HRV | the 10 latest exercise sessions |

**Refresh on demand.** `POST /api/garmin/v1/refresh` (same token) fetches all of the above right now, stores it and answers `{ok, outcome, requests, rows_new}`; the app then reloads from the database. There is no time limit between presses (a double tap within 3 s shares one fetch). `outcome` is `ok`, `partial`, `unavailable`, `rate_limited` (Garmin asked us to wait; `retry_at` says until when), `auth_failed` or `paused`. It works even if the background loop is off. Shortly after midnight the previous day is fetched too. The watch only syncs in batches, so polling faster returns the same answer; the interval cannot be set below 5 minutes.

What is **not** available from this API (checked against real answers): steps per 15 minutes, a stress score across the day, activity level, beat-to-beat intervals, skin
temperature. The catalogue (`GET /metrics`) lists what exists and `UNSUPPORTED` says why the rest does not.

## Safety

- Read-only: the code only issues GETs (plus the token exchange). The key is sent to the token endpoint only.
- Backoff: HTTP 429 or Garmin errors back off exponentially (honours `Retry-After`, capped at 1 h); the loop never runs faster because requests succeed.
- A rejected key pauses polling (`state/AUTH_FAILED`) until a person fixes it and runs `python -m gsvc.cli resume`. `python -m gsvc.cli pause` stops polling without touching data.
- The key lives only in `service.env` (chmod 600) on the VM as `GARMIN_PERSONAL_API_KEY`. Never commit it, never put it in the app bundle.

## Run

```
python -m gsvc.cli status      # flags and settings, sends nothing
python -m gsvc.cli once        # one cycle now
python -m gsvc.cli run-worker  # what the systemd unit runs
```

Settings (env or `service.env`): `GARMIN_PERSONAL_API_KEY`, `GARMIN_POLLING_ENABLED` (default false), `GARMIN_POLL_MIN` (default 10), `GARMIN_LOCAL_TZ` (default Asia/Beirut),
`GARMIN_WORKER_DATABASE_URL`, `GARMIN_API_DATABASE_URL`, `GARMIN_API_TOKEN`, `GARMIN_API_HOST/PORT`, `GARMIN_CORS_ORIGINS`, history limits.

## Switching an existing VM install from the old gateway

1. Copy `gsvc/`, `requirements.txt` and `deploy/*.service` into `~/garmin-mcp` (the old `connector_client.py`, `login_guard.py`, `oauth_support.py`, `rate_gate.py`, `oauth/`, `state/NEEDS_LOGIN` and `data/` can be deleted).
2. In `service.env`: add `GARMIN_PERSONAL_API_KEY=...`, replace `GARMIN_FAST_INTERVAL_MIN` with `GARMIN_POLL_MIN=10`, delete the slot variables. `chmod 600 service.env`.
3. `sudo systemctl restart sugarsense-garmin-api sugarsense-garmin-worker`, then `python -m gsvc.cli once` and check `/status`.
Rows already stored by the gateway stay in the database; the removed metrics (`steps_interval`, `activity_level`, `stress_level`, ...) simply stop getting new values.

## Tests

`pytest tests` (71 tests): client (token cache/renewal, typed errors), parsers (synthetic payloads with the real keys), worker (scheduling, backoff, pause flags), store and API.
