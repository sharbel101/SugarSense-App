# Meal-aware forecasting layer (backend)

Status 2026-10-16: implemented, tested against PostgreSQL on the VM, **not deployed** (see "Going live").
Design source: `backend/docs/research/glucose-forecasting-engine-spec.md` (a proposal; its own caveats stand:
no published validation of this kind of forecaster at 180 minutes, accuracy unknown until it runs on real data).
Safety rules: root `CLAUDE.md` section 2. This layer forecasts glucose. It never produces, suggests or
adjusts an insulin dose and no forecast value feeds the bolus calculator.

## How it fits the existing system

```
CGM -> bg.db -> forecast service (frozen GRU direct_120, glucose only, 120 min)      [unchanged, on the VM]
                     |  GET /glucose (existing proxy, contract unchanged)
                     v
Nest: ForecastService  = glucose-only baseline  +  event layer (this folder + src/engine)
        events (meals, insulin) and therapy settings come from PostgreSQL
```

**Decision: augment, not feed.** The GRU is frozen and sees only 60 minutes of glucose, so there is nothing to
feed meal or insulin features into. The layer adds, on top of the GRU's output, the glucose effect that the
logged events *still have to produce*:

```
adjusted(h) = baseline(h) + m_csf * CSF * C * [F(age+h) - F(age)]  -  m_isf * ISF * U * [A(age+h) - A(age)]
```

* `F(s) = 1 - (1 + s/tau) e^(-s/tau)` gamma(2) meal absorption, tau = 40 min (x0.5 fast, x1.5 slow classes); `A(s)` the
  exponential insulin curve (peak 75 min rapid / 55 ultra-rapid, end 300 min). Golden vectors G0/G1 of the spec are
  reproduced in `src/engine/engine.spec.ts` (including the +47.7 mg/dL net hump at 90 min for a matched 4 U / 40 g).
* `CSF = ISF / ICR` (mg/dL per gram). **The ICR enters only here** (spec double-counting rule 1). The insulin term uses
  ISF x units and never the ICR, so a meal covered exactly by its dose nets to ~0 at full action; the transient
  difference between `F` and `A` is the physiology the layer reproduces. There is no fixed ICR penalty.
* Increments start at the anchor: the part of an event's effect that already happened is in the CGM history and is
  not added again (spec "anchored simulator": `y(t0) + m(t0+h) - m(t0)`).
* **Overlap risk, stated honestly:** the GRU extrapolates the recent trend, so for a meal that is already pushing
  glucose up the GRU and the layer can both express part of the same rise. Mitigations: the 80% band always contains
  the glucose-only value; both predictions are stored and scored side by side; the learned scale `m_csf` absorbs a
  systematic overlap. Whether the layer helps on real data is **not yet measured**.
* Fat/protein: delayed second component with amplitude `alpha = 0` (spec: population value is not a mean shift);
  they only widen the late interval. Glycemic index is stored but never used as a multiplier (spec section 4).
* Horizon: 36 steps of 5 min = 180 min. Beyond 120 min the GRU has no forecast: the baseline is held at its
  120-minute value and **only logged events move the line** (flagged `extension: true`, band keeps widening).
* Uncertainty (independent sources, in quadrature): baseline error (measured RMSE curve of the deployed model on
  this user's own record, 5-60 min, extrapolated beyond 60 and replaced by stored outcomes as they accumulate,
  shrinkage n/(n+30)), carbohydrate estimate (photo range read as an ~80% interval, bounded 10-50% of the value; typed
  values 25%), insulin sensitivity (25%, +50% when the dose is marked uncertain), meal/dose timing, fat/protein.

## What happens when data is missing (never invented)

| Situation | Behaviour |
|---|---|
| Nothing logged | Glucose-only forecast; active insulin reported as **unknown**, not 0 |
| Meal logged, **no insulin record** | Mean unchanged; band stretched upward to the uncovered-carbohydrate case. Not "no insulin taken" |
| Meal + explicit confirmed 0-unit entry | "Confirmed none": full carbohydrate effect applied |
| Meal + dose declared or exactly one rapid bolus in [-30, +20] min | Both applied (carbs and insulin) |
| Dose that could belong to two meals | Linked to neither; both meals range-only; dose range-only |
| Bolus with no meal recorded | Mean unchanged; band stretched downward. A *correction* dose lowers the mean |
| Planned dose | Never counted until recorded as taken (`confirmation: planned` cannot hold an administered amount) |
| Basal, long/short/other insulin | Never used as a meal bolus |
| ICR or ISF not set | Meals ignored (`therapy_settings_missing`), glucose-only forecast, note says so. **No default ratio** |
| Carbs unknown | Meal kept but ignored; a dose linked to it cannot lower the mean |
| Uncertain meal/dose timing | Timing term widens the band |
| Database down / not configured | Glucose-only forecast, `saved: false`, fixed explanatory note; write routes answer 503 with a fixed message |
| Glucose stale/unavailable | Passed through; no forecast is produced |
| Forecast model unavailable | `baseline_unavailable`; nothing is extrapolated |

Carbohydrate coverage (`GET /events/meals/:id/coverage`, and stored with each run): `units x ICR` versus the recorded
carbohydrate. It is an analysis feature. It explains history; it is not a dose suggestion and nothing in the wording
tells anyone to take insulin.

## API (all routes accept the optional `X-App-Token` header when `APP_API_TOKEN` is set; rate limited)

| Route | Purpose |
|---|---|
| `GET /forecast?horizonMin=5..180` | Current forecast (`ForecastDisplay`, `forecast-response.ts`). Saved before its outcome is known |
| `POST /forecast/counterfactual` `{excludeMealIds[], horizonMin?}` | What-if for a future "clear recent meals" action: those meals are left out, **delivered insulin still counts**, nothing is deleted or saved, labelled `counterfactual: true` |
| `GET /forecast/evaluation` | Stored-outcome comparison of the layer against the glucose-only baseline, per horizon |
| `POST /events/meals` | Manual meal (`clientId`, `eatenAt`, `carbsG?`, `fatG?`, `proteinG?`, `fiberG?`, `absorptionClass?`, ...). 201 created / 200 same `clientId` / 409 probable double entry / 422 invalid time |
| `PATCH /events/meals/:id` | Correct a meal (`expectedRevision` for optimistic concurrency; `label`, carbs, time, speed class, `status: cancelled`). Records a revision and the before/after numbers |
| `POST /events/insulin`, `PATCH /events/insulin/:id` | Insulin entry. `confirmation`: `confirmed` (taken), `uncertain` (taken, approximate), `planned` (not taken yet). `PATCH {status:"cancelled"}` withdraws a mistaken entry: kept with its revision history, no longer acts in forecasts, no longer counts as "insulin recorded", not listed again |
| `GET /events/meals/:id/coverage` | Carbohydrate vs insulin coverage under the ratio that applied at that meal |
| `GET /events/recent?hours=` | Recent meals/insulin for a picker |
| `GET /therapy/settings`, `GET /therapy/settings/history`, `PUT /therapy/settings` | ICR (g per unit) and ISF (mg/dL per unit) by time of day, versioned |
| `POST /meals/analyze` (existing) | Unchanged fields + `mealEventId`, `forecast`, `forecastNote` (also on failure variants) |

`clientId` is any id of 8-80 characters `[A-Za-z0-9._-]` (the app's own event id works); resending it never creates a
second event. Every write response carries the refreshed `forecast` (or `null` when nothing changed).

Every forecast point also carries `insulinOnBoardUnits` and `carbsOnBoardGrams` (estimates from logged entries only, run down with the same
kernels as the effects, `null` = unknown, `0` insulin only after an explicit "none taken"), so the graph can draw how they fall. The
values at "now" are in `mealAware.availability`.

Meals have a short `label` (typed, or derived from the items of a photo meal, e.g. "steamed white rice + grilled chicken").

Responses expose display fields only: no ICR/ISF values, scales, snapshots, raw Gemini JSON, internal ids other than
event ids, or any database detail (tests assert this).

## Data (migration `0006_event_forecasting.sql`, plus 0001-0005)

`therapy_profiles` + `therapy_segments` (versioned ICR/ISF by local time of day; append-only), meal provenance
(`estimated` / `user_corrected` / `user_entered` / missing), `forecast_runs` (immutable, full normalised inputs for
byte-for-byte replay), `predictions` (+ ICR, ISF, therapy version used, feature configuration), `prediction_event_links`
(which events each run used, in which role, with carbohydrate and insulin amounts and the coverage), `event_revisions`,
`prediction_outcomes`, `model_parameters` (versioned scales), `model_performance` (by horizon and feature configuration). Migration
`0007` adds `meal_events.label` and `insulin_events.status` (`active` / `cancelled`).
Changing the ICR creates a new version; stored predictions keep the value they used (copied, not looked up).

## Recursive personalisation

On every batch of new CGM readings: store them (idempotent), match them to earlier predictions (nearest reading within
+/-3 min of the target; outcome written once; a sensor gap leaves the prediction unscored), roll per-horizon error
statistics (15/30/45/60/120/180 min), and at most once per 20 h consider moving the two scales `m_csf`, `m_isf`:
ridge fit shrunk toward 1 (k = 30), information gate (>= ~13 reliable forecast moments), rate limit 0.1/7 in log space per
update, bounds [0.6, 1.6], activation only after a time-ordered check that the candidate beats **both** the incumbent and
the glucose-only baseline on later data. Otherwise it is stored as `proposed`. Every version is kept; rollback inserts a new
version. Only runs where every logged event is trustworthy are used (known carbohydrates, settings present, insulin
relationship known, timing within 15 min, no uncertain doses). The prescribed ICR/ISF are **never** changed by this.

## Going live (nothing below has been done on the production service)

1. `0006` and `0007` are already applied to the production database (additive, backups taken first). The web-app nginx site
   (`/etc/nginx/sites-available/sugarsense-web`, port 8090) now also proxies `/forecast`, `/events` and `/therapy` to the backend
   (backup `sugarsense-web.bak-20261016-185745`); the ngrok gateway already forwards everything else.
2. Push `main`; the deploy timer builds and restarts the backend (its tests skip the database suite because no test
   database is configured there).
3. Add `DATABASE_URL` (value from `~/sugarsense-db.env`) to `~/sugarsense-app/backend/.env`, optionally `PRIMARY_USER_ID`,
   then `sudo systemctl restart sugarsense-backend`. Until then the new routes answer 503 and `/forecast` is glucose-only.
4. Tell the UI chat about the contract above (`MASTER-PROMPT-UI-FORECAST-INTEGRATION.md`).

## Tests

* `src/engine/*.spec.ts` - kernels (spec golden vectors), event layer, linking, composer, fitting (pure, run anywhere).
* `src/forecasting/schemas.spec.ts` - request validation, time zones, ratio resolution (pure).
* `src/forecasting/forecasting.db.spec.ts`, `forecasting.http.spec.ts` - real PostgreSQL, application role. Run on the VM:
  `set -a; . ~/sugarsense-test-db.env; set +a; npx vitest run src/forecasting` (scratch database `sugarsense_test`).

## Known limits

No Kalman filter yet (the spec's online residual correction); the baseline's trend overlap is mitigated, not removed;
the 60-120 min baseline error is extrapolated from 5-60 min measurements; exercise and sleep are not used; fat/protein
amplitudes are not learned; photo-time timing uncertainty (10 min) and the dose-uncertainty factor (50%) are engineering
defaults; one user, no authentication; meal edits change totals, not individual items.
