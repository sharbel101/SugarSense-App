# Glucose module - `GET /glucose` (implementation brief)

Audience: the backend AI/dev finishing this module. Read `../../HANDOFF-BACKEND-AI.md` and `../../../CLAUDE.md`
(section 2 safety rules, section 3 invariants) first. The upstream contract is in `FORECAST-API.md` (same
folder); read it before this file.

## 0. Status and goal

**Goal:** the Nest backend exposes `GET /glucose` to the app. It calls the forecast service on the VM
server-side (the app never sees the upstream URL or token), validates and maps the body, and returns a
glucose reading + 2 h prediction + hypo/hyper risk in the app contract.

**Already written (untracked, uncommitted, never run through typecheck/lint/tests as a module - verify):**

| File | Role |
|---|---|
| `forecast-upstream.client.ts` | `ForecastUpstreamClient.fetchGlucose()`; token only in the header; returns `ok` / `upstream_stale` / `failed{cause}` |
| `schema/upstream-glucose.schema.ts` | Zod "Gate 1" for the upstream body (`UpstreamGlucose`) |
| `map-upstream-glucose.ts` | pure `mapUpstreamGlucose(upstream, ageMinutes)` -> `GlucoseOkResponse` |
| `glucose-response.ts` | the client contract: `GlucoseResponse = ok \| stale \| unavailable` |
| `FORECAST-API.md` | the upstream API reference |

**Still to write (this is your work):**

1. `glucose.service.ts` - orchestration (section 2).
2. `glucose.controller.ts` - `GET /glucose` (section 3).
3. `glucose.module.ts` + register in `src/app.module.ts` `imports`.
4. Tests (section 5) and fixtures under `test/fixtures/glucose/`.
5. `.env.example` entries (section 4) and a deploy note (section 7).

Nothing here is "working" until `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:e2e` pass and
you have shown the real output.

## 1. Rules that shape the design (do not trade away)

- **Never fabricate or repair a number.** On any failure, return `stale` or `unavailable`; those variants
  structurally carry no glucose value. No "last known value", no extrapolation.
- **`null` means "not supplied", never "no"/zero.** `low.alert: null` is not `false`. Do not coalesce.
- **mg/dL only**; a non-`mg/dL` `unit` is rejected by the schema (invariant 1). Timestamps stay UTC ISO strings.
- **Staleness is visible, not hidden:** `ageMinutes` is rounded UP, never shown fresher than it is.
- **No forecast output feeds the bolus calculator** (CLAUDE.md section 2). This module returns data only; it
  contains no insulin arithmetic and no "take X units" language.
- **Health data:** never log the upstream body, glucose values, the URL, the token, or `err.message`
  (undici embeds the target address). Log status code, latency and a fixed cause word only. The client already
  does this; keep it that way in the service/controller.
- **Alarm/notification separation:** this endpoint is a data read. It must not trigger notifications and must
  not share a channel with the on-device agent (CLAUDE.md section 1, item 6). Web push is a separate VM service.
- **Copy:** any string the server produces must follow the CLAUDE.md section 2 language table ("predicted
  range", "not medical advice"; never "accurate", "optimal dose", "clinically validated").

## 2. `GlucoseService.getGlucose(): Promise<GlucoseResponse>`

Inject `ForecastUpstreamClient`, `ConfigService`, and a clock (`GLUCOSE_NOW_FN` token, like
`MEAL_ANALYSIS_SLEEP_FN` in meals) so tests are deterministic. Never throw to the controller: every path
returns one of the three variants with HTTP 200.

```
r = await client.fetchGlucose()

r.kind == 'upstream_stale'          -> { status:'stale', reason:STALE_REASON, lastMeasuredAt:null }
r.kind == 'failed'                  -> { status:'unavailable', reason: REASON_BY_CAUSE[r.cause] }
r.kind == 'ok':
    parsed = upstreamGlucoseSchema.safeParse(r.body)
    !parsed.success                 -> unavailable 'invalid_response'   (log issue PATHS only, no values)
    plausibility (Gate 2):
        glucose outside [20, 600]   -> unavailable   (CLAUDE.md section 12 L1: implausible value)
        timestamp > now + 5 min     -> unavailable   (clock skew; never show a future reading as fresh)
    ageMinutes = max(0, ceil((now - timestamp) / 60000))
    ageMinutes > GLUCOSE_STALE_MINUTES (default 20)
                                    -> { status:'stale', reason:STALE_REASON, lastMeasuredAt: timestamp }
    else                            -> mapUpstreamGlucose(parsed.data, ageMinutes)
```

Notes:

- The backend re-checks staleness on its own clock even though upstream already returns 503 when stale:
  the upstream caches a response for up to 900 s per newest reading, so a cached 200 can be old by the time
  it reaches you.
- `GLUCOSE_STALE_MINUTES` should equal upstream `FORECAST_STALE_MIN` (20). Keep the default in one constant.
- Reason strings are fixed user-safe sentences, not upstream text. Suggested map:

| Cause | `unavailable.reason` |
|---|---|
| `not_configured` | "Glucose service is not configured." |
| `unauthorized` | "Glucose service rejected the request." |
| `timeout` / `network` | "Glucose service is not reachable right now." |
| `bad_status` / `invalid_json` / schema fail | "Glucose service returned an unexpected response." |
| implausible / future timestamp | "Glucose reading could not be verified." |
| stale | "The latest glucose reading is too old to show. Check your sensor." |

- Optional single-flight/short cache (a few seconds) is acceptable to absorb many clients; do not cache
  longer than the reading's own freshness and never cache `failed` results across a recovery.

## 3. Controller and module

```ts
@Controller('glucose')
export class GlucoseController {
  constructor(private readonly glucose: GlucoseService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  get(): Promise<GlucoseResponse> { return this.glucose.getGlucose(); }
}
```

- Route is `GET /glucose` (no params). Always HTTP 200 for the three variants (handled states, not transport
  errors). A real 500 is only for a bug.
- `GlucoseModule`: `controllers: [GlucoseController]`, `providers: [GlucoseService, ForecastUpstreamClient,
  { provide: GLUCOSE_NOW_FN, useValue: () => Date.now() }]`. `ConfigModule` is already global.
- ESM: relative imports need the `.js` extension.
- **Authentication:** none exists yet in this backend (same as `POST /meals/analyze`). This endpoint returns
  health data; it must get auth before any real user. Flag it, do not invent an auth scheme without asking the
  user (HANDOFF section 6, decision 3). Until then the VM is reachable only via nginx/tunnels the user controls.

## 4. Configuration

Add to `backend/.env.example` (values on the VM live in `backend/.env`, which must never be copied or printed):

```
# Forecast service on the VM (GET /glucose). Server-side only; never in the mobile app.
FORECAST_API_URL=http://127.0.0.1:8001
FORECAST_API_TOKEN=
```

- On the VM the backend and forecast service share a host, so the URL is loopback. For local development on
  the laptop the service is not reachable on loopback; use a tunnel/SSH port forward
  (`ssh -L 8001:127.0.0.1:8001 ubuntu@139.185.53.135`) or unset the token and rely on `not_configured`.
- The token is the same value as `FORECAST_API_TOKEN` in `/home/ubuntu/forecast/forecast.env` on the VM. Ask
  the user to put it in `backend/.env` on the VM; do not read, print or commit it.

## 5. Tests (write first; fixtures, no network)

Unit (`glucose.service.spec.ts`, fake `ForecastUpstreamClient`, fake clock):

1. ok body -> `status:'ok'`, fields mapped, `ageMinutes` rounded up (e.g. 4 min 10 s -> 5).
2. upstream 503 stale -> `stale`, `lastMeasuredAt: null`, no `glucoseMgdl` key at all.
3. reading older than 20 min on our clock but upstream 200 (cached) -> `stale` with `lastMeasuredAt` set.
4. each `failed` cause -> `unavailable` with the mapped reason; response has no glucose field.
5. schema drift: missing `history`, `unit:'mmol/L'`, probability 1.5, non-ISO timestamp -> `unavailable`.
6. glucose 15 or 700, timestamp 10 min in the future -> `unavailable`.
7. `forecast_available:false` -> `predictions: []`, `forecastAvailable:false`, reason from
   `meta.forecast_unavailable_reason`, while `glucoseMgdl` and risk groups are still present.
8. `forecast_available:true` but `predictions: []` -> reported unavailable (already in the mapper).
9. `hypoglycemia`/`hyperglycemia` absent or null -> `low`/`high` fields all `null`, `alert` is `null` not `false`.
10. `excursion.mode:'shadow'` -> `rangesAreShadow:true`; ranges with `low > high` or missing values dropped.
11. Leak test: serialised `ok` response contains none of `hazard_low_risk`, `normalization`, `inference_ms`,
    `forecast` (the minutes array), `estimated_range`; and no logger call receives the body, URL or token.
12. Invariant: output never contains units other than mg/dL; `history`/`predictions` timestamps pass through
    unchanged.

Client (`forecast-upstream.client.spec.ts`, stub `fetch`): token only in the `Authorization` header; 401 ->
`unauthorized`; 503 `{"detail":"glucose data is stale"}` -> `upstream_stale`, other 503 -> `bad_status`;
abort after 8 s -> `timeout`; redirect -> `network`; non-JSON 200 -> `invalid_json`; missing token -> no fetch
call.

E2E (`test/glucose.e2e-spec.ts`): override `ForecastUpstreamClient`; `GET /glucose` returns 200 and the
variant for ok/stale/unavailable; `Cache-Control: no-store` present; no auth header needed (until auth lands).

Fixture: save a trimmed real upstream body (use `FORECAST-API.md` sample) at
`test/fixtures/glucose/upstream-ok.json`. It is health data of the developer: fine for a private fixture,
strip it if the repo ever holds another person's data.

## 6. Client (app) contract - what mobile will consume

`GET {API_URL}/glucose` -> `GlucoseResponse` (see `glucose-response.ts`). Frontend rules to put in the API
notes for the mobile team:

- Poll about every 60 s (the client comment assumes it; the next poll is the retry). Do not poll faster:
  the reading changes every ~3-5 min and upstream caches per reading.
- Always render `ageMinutes` next to the value. `stale` and `unavailable` show no number and no chart.
- Show predictions as a "predicted range"/forecast with `modelVersion`; if `rangesAreShadow` is true label
  the ranges as not validated. Show no median/line when `forecastAvailable` is false.
- `low.alert === null` must not render as "no risk". Probabilities are about a NEW episode starting; when
  `alreadyHigh`/`alreadyLow` is true say so instead of showing reassurance.
- Web build: the call is same-origin (`/glucose`) through nginx `:8090`; see section 7.

If the app needs fields the contract does not carry (e.g. `excursion.message`, `predicted_peak`), add them to
`GlucoseOkResponse` + the Zod schema + mapper + tests together; do not widen the schema alone (Zod strips
unknown keys on purpose).

## 7. Deploy (VM) - for whoever does the rollout

1. `ubuntu@139.185.53.135`, repo at `~/sugarsense-app`, service `sugarsense-backend` (systemd, `node dist/main.js`).
2. `git pull`, `cd backend && npx --yes npm@11 install && npm run build`, then
   `sudo systemctl restart sugarsense-backend`. Confirm `FORECAST_API_TOKEN` is present in `backend/.env`
   (do not print it) and `FORECAST_API_URL` is loopback.
3. nginx `:8090` site (`/etc/nginx/sites-available/sugarsense-web`): extend the proxy regex
   `^/(health|meals)(/|$)` to `^/(health|meals|glucose)(/|$)`, `sudo nginx -t`, reload. The `:80` gateway
   already forwards everything except `/bg` to Nest and needs no change.
4. Smoke: `curl -s http://127.0.0.1:3000/glucose | head -c 300` returns a JSON with `"status"`; with the
   token removed it must return `{"status":"unavailable",...}` and HTTP 200.
5. Do NOT touch `bg.service`, `forecast.service`, the `/bg` response shape, or the phone collector. The
   watch `GET /bg` contract (`{sgv, direction, mills, delta, stale}`) must stay exactly as is.

## 8. Out of scope (ask the user first)

Persisting readings (`glucose_reading` with `source:'cgm'`, `measured_at` UTC + offset, `external_id`),
storing `prediction` rows with `input_snapshot`/`model_version` for the scoring loop, authentication,
and any push/notification behaviour. If persistence is added later it must follow CLAUDE.md section 3
invariants (mg/dL, UTC + offset, reproducible predictions, coverage-as-data) and the retrospective scoring
loop in section 14.

## 9. Definition of done

- `glucose.service.ts`, `glucose.controller.ts`, `glucose.module.ts` exist and are imported in `AppModule`.
- All tests in section 5 written and passing; `npm run typecheck`, `npm run lint`, `npm test`,
  `npm run test:e2e` output shown to the user.
- `.env.example` updated; no secret in git; no log line contains health data, URL or token.
- This README and `FORECAST-API.md` updated if the contract changed.
