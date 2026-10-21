# Garmin metrics service (poller + read-only API)

`gsvc/` polls the gateway below on a conservative schedule, stores the results in PostgreSQL (migration `backend/db/migrations/0011_garmin_metrics.sql`)
and serves them at `/api/garmin/v1/*` from a separate local process (default `127.0.0.1:8310`, reached only through nginx). The API never calls Garmin.
Frontend contract: `MASTER-PROMPT-GARMIN-FRONTEND.md`. Status: implemented and tested offline (99 tests, plus the store contract against a scratch Postgres);
NOT deployed to production until the steps in "Deploy" are approved and run.

Schedule (env, all optional): `GARMIN_POLLING_ENABLED` (default **false**), `GARMIN_FAST_INTERVAL_MIN=7` (minimum 5; heart rate, 15-min steps, day totals, exercise),
`GARMIN_STRESS_INTERVAL_MIN=30` (stress and body-battery series), slots in local time `GARMIN_SLEEP_SLOTS=07:30,11:30`, `GARMIN_HRV_SLOTS=08:00,18:00`,
`GARMIN_SPO2_RESP_SLOTS=09:00,21:00`, `GARMIN_READINESS_SLOTS=08:00,14:00,20:00`, `GARMIN_SLOT_RETRY_MIN=60`, `GARMIN_SLOT_MAX_ATTEMPTS=4`, `GARMIN_LOCAL_TZ=Asia/Beirut`.
Never speeds up on success. About 0.9k gateway calls a day at 7 minutes; the watch often syncs less often than that, so unchanged answers are cache hits.
Pause without touching data: `python -m gsvc.cli pause` / `resume`. Safety: one shared Gate (>= 2 s between calls, 5 min poll floor, 429 backoff 5/15/60/180/360 min with Retry-After,
breaker after 3 failures), auth failure or NEEDS_LOGIN pauses polling and is never retried, nothing here can sign in (tested).
Unsupported (no gateway tool): skin temperature, RR intervals, per-minute steps. `get_activities_fordate` and `get_training_readiness` shapes are unverified (no data on the probe day).
Retention: observations are kept (about 1k rows a day); poll-run logs 30 days.

Deploy (needs approval, VM): apply migration 0011 (backup first), `deploy/setup-roles.sh`, copy `gsvc/` + files into `~/garmin-mcp`, `pip install -r requirements.txt`,
install the two systemd units, add `deploy/nginx-garmin.conf.snippet` to both nginx sites (`nginx -t`, reload), start the API, then one supervised `python -m gsvc.cli once`
with `GARMIN_POLLING_ENABLED=true` before enabling the worker service.

---

# garmin-mcp: read your Garmin data from the VM through the SAME gateway your claude.ai "garmin" connector uses

The connector in your Claude settings points at `https://missingmcp.com/garmin/mcp`: a free hosted gateway (run by one person, built on the
open-source `garmin_mcp`) with an OAuth sign-in. **There is no API key and no payment.** You sign in once on its page with your Garmin email and password
(+ MFA); it keeps only encrypted Garmin session tokens and gives the client an OAuth token. `connector_client.py` does that sign-in once, by hand,
then refreshes its own token automatically and saves compact daily metrics as JSON under `data/<day>/`.

## Rules (enforced and tested)

- **No unattended sign-in.** `tools` and `poll` can refresh their saved token but can NEVER start a sign-in: with no usable token they stop, write
  `~/garmin-mcp/NEEDS_LOGIN` and print "Run login manually". Only `login`, run by you in a terminal and guarded by `login_guard.py`
  (15 min gap, 24 h block after a 429/403/locked answer, max 3 attempts per 24 h, history in `~/.garminconnect/login_attempts.json`), starts one.
- **Read-only.** Only 10 `get_*` tools can be called (sleep, stress, heart rate, respiration, HRV, resting HR, body battery, SpO2, daily stats,
  readiness). Writes (log food, edit/delete activities, upload/schedule workouts, weight, ...) are refused locally.
- **Gentle.** >= 2 s between requests, one poll per 5 minutes, backoff 5/15/60/180 min (cap 6 h) after rate-limit answers, circuit breaker after 3
  failures in a row; state survives restarts (`state/gate_state.json`).
- No timer, cron or service exists. Never create one that runs `login`.

## One-time sign-in (do it only when connect.garmin.com works in your browser and 24-48 h have passed since your last failed Garmin attempt)

The gateway checks your Garmin password with Garmin during sign-in, so a sign-in during a Garmin cool-down can extend it.

```bash
ssh -i ~/.ssh/oracle_sep5.key ubuntu@139.185.53.135
cd ~/garmin-mcp
./venv/bin/python connector_client.py check      # offline: should say "saved tokens: NO"
./venv/bin/python connector_client.py login      # type YES, open the link it prints in ANY browser (laptop or phone), sign in
```

After you finish signing in, the browser shows "page cannot be reached" for `http://127.0.0.1:8976/callback?code=...&state=...`. That is expected:
copy the **full address** from the address bar and paste it into the terminal. Then:

```bash
./venv/bin/python connector_client.py tools      # which tools the real server offers and which this client may use
./venv/bin/python connector_client.py poll       # today's metrics -> data/<today>/*.json (+ _manifest.json without values)
```

If `tools` or `poll` ever prints `NEEDS LOGIN`, the saved token was rejected; only then run `login` again (and only after checking `python login_guard.py`).

## Other commands

```bash
./venv/bin/python -m pytest -q                       # 23 offline tests
./venv/bin/python tests/local_server_check.py        # end to end against a local stand-in server (no internet)
```

## Good to know

- The gateway is a third party that holds your Garmin session tokens (its page says the password is "never stored"). Revoke it by disconnecting
  the connector in claude.ai; this client's own tokens are in `./oauth` (delete the folder to forget them).
- In claude.ai (Settings > Connectors > garmin) the write tools such as "Add body composition" are set to always allowed. Consider setting those to
  "Needs approval" or "Blocked", since they can change your Garmin account.
- Not verified against the real gateway yet: the sign-in flow, the tool names and the data shapes. `data/` is not read by the SugarSense backend yet.
