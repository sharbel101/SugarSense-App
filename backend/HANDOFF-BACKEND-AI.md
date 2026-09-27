# SugarSense backend - handoff for the AI/dev who starts coding it

Read this first, then read `../CLAUDE.md` in full. This file is the backend-specific briefing; `CLAUDE.md`
(distilled from the *SugarSense Technical Reference* PDF) is the source of truth for the design, the safety
rules and the data model. If the two disagree, `CLAUDE.md` wins - then fix this file.

**Status: skeleton only.** No data models, no database connection, no auth, no business logic. Do not describe
anything as working until it exists and its tests pass.

---

## 1. Where you may work

| Path | Access |
|---|---|
| `C:\Users\Pc\sugarsense_app_dev\backend` | **write** - this is your project |
| `C:\Users\Pc\sugarsense_app_dev\CLAUDE.md` | read - the spec (sections below tell you which parts matter) |
| `C:\Users\Pc\sugarsense_app_dev\mobile\src\data\mockData.ts` | read - shows what data the UI expects |
| `C:\Users\Pc\sugarsense_app_dev\mobile\`, `ml\`, `test-APP\` | **do not modify** (other people/AIs own them) |

Git: repo `sharbel101/SugarSense-App`, branch `main`, remote `origin`. Do not commit or push unless the user asks.
Never commit secrets (`.env*` is gitignored; only `.env.example` is committed).

## 2. What exists right now

- **NestJS 12**, TypeScript, **ESM** (`"type": "module"` - relative imports need the `.js` extension, e.g.
  `import { AppModule } from './app.module.js'`).
- **Vitest** for tests (`*.spec.ts` unit, `test/*.e2e-spec.ts` e2e), **oxlint** for linting, Prettier config.
- Routes: only `GET /health` -> `{ "status": "ok" }` (`src/health.controller.ts`). It is a liveness probe.
- CORS: `main.ts` allows `CORS_ORIGINS` (default `http://localhost:8081`, the Expo web dev server). Native apps are
  not subject to CORS.
- Installed but unused: `pg`, `@supabase/supabase-js`, `@nestjs/config` (loaded globally in `AppModule`),
  `class-validator`, `class-transformer`.
- `.env.example` lists `PORT`, `CORS_ORIGINS`, `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY`. Copy to `.env`; nothing is required for the server to start.
- Tests currently: 2 unit (module compiles; `pg`/Supabase load) and 2 e2e (`/health` = 200, `/` = 404). All pass.

### Commands (run in `backend/`)

| Command | Purpose |
|---|---|
| `npx --yes npm@11 install` | install deps (see gotchas: npm 10 crashes here) |
| `npm start` / `npm run start:dev` | start Nest on `PORT` (default 3000) / watch mode |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | oxlint |
| `npm test` / `npm run test:e2e` | unit / e2e tests |
| `npm run build` | compile to `dist/` |

## 3. What the backend owns - and what it must NOT do

The phone must produce a forecast with **no network**. So these run **on the phone**, not here: the physiological
simulator, Monte Carlo uncertainty, residual-model inference, the bolus calculation, the hypoglycaemia classifier,
and the anomaly agent.

**The backend owns:**

1. **The vision-model call for meal photos**, and its credentials. The API key never goes into the app.
2. **Persistence** of the entities in section 4 (Postgres, likely via Supabase).
3. **Clinician access**: consent-gated, read-only view of a patient's data (`care_relationship`) with an
   append-only `audit_log`.
4. **Sync** of findings from the on-device agent (append-only store, kept for the clinician view).
5. **Model artefacts and versions** (training happens in `ml/`; the backend stores/serves versioned artefacts and
   supports shadow-mode rollout - a version pin, not a redeploy).
6. Later: CGM ingestion (Nightscout first), training-job orchestration.

**The backend must never:** compute or return an instruction to take insulin, auto-deliver anything, or produce a
fabricated number when an upstream step fails. The bolus arithmetic lives on the phone (`CLAUDE.md` section 10); the
server only stores what was suggested and what the user says they actually took.

## 4. Data model (12 entities) and invariants

Entities (fields in `CLAUDE.md` section 3): `profile`, `therapy_settings`, `meal`, `meal_item`,
`glucose_reading`, `insulin_event`, `prediction`, `sensor_sample`, `sensor_aggregate`, `daily_context`,
`care_relationship`, `audit_log`.

**Invariants - write these as tests before features:**

1. **One glucose unit:** store mg/dL only; convert at the presentation boundary only.
2. **Timestamps are UTC**, with the UTC offset recorded separately.
3. **A suggestion is not a dose:** `units_suggested` and `units_administered` are separate columns; neither is
   derived from the other.
4. **Every derived value is reproducible:** a `prediction` stores its full `input_snapshot` and `model_version`.
5. **Missingness is data:** absent sensor coverage is `coverage = 0`, never a zero or an interpolated value.
6. **No AI-produced number without an edit path:** meal values carry an `edited` flag (and the delta is recorded);
   user corrections are stored as labelled training pairs from day one.

Other rules: therapy settings (ICR, ISF, targets, max bolus, insulin type/peak/duration) are clinician-supplied
priors and are never silently overwritten. `audit_log` is append-only. `care_relationship` records explicit,
revocable consent.

## 5. The meal-analysis endpoint (the main first feature)

Contract from `CLAUDE.md` section 9. The phone uploads a resized photo (1024 px JPEG, optionally two views and a
user note); the backend calls the vision model and returns:

```
{ items: [{ name, portion_description, portion_g, carbs_g, confidence }],
  total_carbs_g, total_carbs_sigma, fat_g, protein_g, fibre_g,
  confidence: "high" | "medium" | "low", model_version, prompt_version }
```

- Fixed, **versioned** system prompt in code; response schema enforced at the API level; low temperature.
- **Gate 1:** parse with Zod - structure is guaranteed or rejected.
- **Gate 2 (semantic sanity):** every item has a portion and carbs; sum of item carbs is within 5% of the declared
  total; `0 < total <= 400 g`; no empty/placeholder names; `portion_g` plausible for the item.
- On failure: retry with exponential backoff, **max 2 attempts**; then return a partial result and require manual
  entry. **Never fabricate a number.**
- `total_carbs_sigma` is the point of the endpoint: derived from model confidence, disagreement between two views
  (when available), and a learned calibration from user corrections (wide population defaults until then).
- Store `model_version` and `prompt_version` with every meal.
- **Capture metadata (design decision 2026-09-22, see `../CLAUDE.md` section 9 "Guided two-photo capture"):** the app
  guides a top-down and a ~45 degree photo using the phone's orientation sensors and may auto-capture. Each photo
  arrives with its metadata (camera elevation angle, roll, gravity vector, angular speed, auto vs manual, retake
  count, image size, device model, EXIF focal length, reference object declared, optional depth map later). Accept
  and store it with the meal; use the angles in the geometry stage, and record single-photo / no-reference cases so
  `total_carbs_sigma` widens. Server-side framing checks (plate visible, blur, exposure) may request a retake.

## 6. Decisions still open - ASK THE USER, don't guess

1. **Database access layer:** Prisma, Drizzle, TypeORM or raw `pg`; and how migrations are managed.
2. **Supabase scope:** hosted Postgres only, or also Auth and Storage (meal photos)? Row-level security?
3. **Auth model:** who signs in (patient, clinician), sessions/tokens, how consent is enforced.
4. **API style:** REST + OpenAPI (recommended for the mobile team to consume) or something else.
5. **Shared types:** how Zod schemas / TS types are shared with `mobile/` (they are separate npm projects; Metro
   and Nest ESM have different resolution rules).
6. **Vision provider** for meal photos, and **hosting/deployment** target.
7. Where model artefacts live and how shadow-mode versions are pinned.

Record each answer in `CLAUDE.md` section 15 ("Open decisions") once decided.

## 7. What the frontend currently expects (context, not a contract)

`mobile/` is a UI prototype on **mock data** (`mobile/src/data/mockData.ts`); nothing calls this backend yet. The
mock shapes are pixel coordinates and pre-formatted strings, which are **not** suitable as API shapes. Design the
API around numeric domain objects and let the client format them:

- glucose readings (mg/dL, UTC timestamp, source, trend), forecast quantiles per horizon (30/60/120/180/240 min,
  quantiles 0.1/0.25/0.5/0.75/0.9), meal estimate with sigma, insulin events (suggested vs administered),
  hypoglycaemia risk with evidence, findings (schema below), wearable aggregates with coverage.
- Known frontend gaps that will need backend support: dose-taken entry, therapy-settings screens, manual glucose
  entry, per-item meal editing with an `edited` flag, low-confidence / loading / error states.

Finding schema (every on-device detector emits this; the backend stores and syncs it):
`id, detector, layer (1-4), detected_at, window{from,to}, severity (info|low|medium|high), score,
evidence{statement, values, baseline, series_ref}, suggested_action, acknowledged_at, dismissed,
user_feedback (useful|not useful|wrong)`. `user_feedback` is the only signal for tuning thresholds - keep it.

## 8. Safety and copy rules that touch the backend

- Language in any user-facing string the server produces: "estimated", "suggested - check before using",
  "predicted range", "based on the settings you entered", "not medical advice". Never "accurate", "optimal dose",
  "clinically validated", "medical grade". Findings are observations, never instructions or diagnoses.
- Degrade loudly and safely: vision failure -> manual entry; incomplete insulin history -> "IOB unknown", never
  silently 0; stale glucose -> withhold the forecast rather than extrapolate.
- Health data: treat every record as sensitive. Do not log request bodies containing glucose, meals or photos. The
  service-role key bypasses row-level security - server-side only, never in the app.
- No regulatory status; not a medical device. Anyone other than the developer using it with their own therapy
  needs ethics review and informed consent (`CLAUDE.md` section 1).

## 9. Environment gotchas

- **Use npm 11 for installs here:** `npx --yes npm@11 install ...`. npm 10.9.x (bundled with Node 22.16) crashes on
  this dependency tree with `Cannot read properties of null (reading 'edgesOut')`.
- `@nestjs/cli` 12 pulls `@angular-devkit` 22, which asks for Node >= 22.22.3. On Node 22.16 npm prints
  `EBADENGINE` warnings; they are harmless. Upgrading Node clears them.
- `supertest/types` does not resolve under this tsconfig; tests use `INestApplication<Server>` from `node:http`.
- Windows dev machine, slow network (~0.5 MB/s): avoid large downloads. No Docker installed, so no local Supabase
  stack yet; use a hosted Supabase/Postgres project or install Postgres deliberately (ask first).
- `npm audit`: 0 vulnerabilities in production dependencies; the few in dev tooling are known. Do not run
  `npm audit fix --force`.

## 10. Suggested order of work

1. Get the section 6 decisions from the user.
2. Add the ORM/migration tooling and a database connection (config via `@nestjs/config`, no secrets committed).
3. Write the six invariant tests first, then the schemas/migrations for the entities.
4. Meal-analysis endpoint behind a provider interface, with a fake provider first so Gate 1/Gate 2/retry logic is
   fully unit-tested before any real API key is used.
5. CRUD/sync for glucose readings, insulin events (suggested vs administered), meals with edit tracking.
6. Auth and the consent-gated clinician read path with `audit_log`.
7. Findings sync, model-artefact versioning.

**Definition of done for any change:** `npm run typecheck`, `npm run lint`, `npm test` and `npm run test:e2e`
all pass, and you have shown the real command output to the user before saying it works.
