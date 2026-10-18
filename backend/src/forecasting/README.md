# Meal-aware forecasting layer (backend)

Status 2026-10-17: implemented and tested against PostgreSQL on the VM. The first version (up to commit `f95dfbd`) is deployed
on the production backend with `DATABASE_URL` set. The follow-up fixes from the simulated-usage test (trend-overlap correction,
race-safe event writes, `Cache-Control: no-store`, settings time zone, first-profile fallback, evidence label, honest
unavailable notes) are committed locally but **not yet pushed or deployed** (see "Going live").
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
* **Overlap risk and the trend correction:** the GRU extrapolates the recent trend, so for a meal that is already pushing
  glucose up the GRU and the layer would both express part of the same rise. The layer therefore subtracts what the GRU
  has already extrapolated from the *event-driven* glucose movement: `k_h x (event-driven slope over the last 15 min)`,
  where `k_h` (minutes) is how strongly the deployed GRU continues a slope at horizon `h`. The table
  `BASELINE_TREND_RESPONSE_MIN` (`src/engine/params.ts`) was measured by least squares on 5,171 stored real predictions of the
  deployed model (about 2 min at +5, about 7 min at +45...60, about 4 min at +120); it is a property of that model and must be
  re-measured if the model is replaced. Switch: `EngineParams.trendOverlap`. Further mitigations: the 80% band always contains
  the glucose-only value; both predictions are stored and scored side by side; the learned scale `m_csf` absorbs a
  systematic remainder. In a synthetic test world the corrected layer helped at 15-60 min for meal + insulin and did **not**
  help at 120 min or for meal-only entries. Whether it helps on real data is **not yet measured**: every forecast carries
  `models.eventLayerEvidence` (`none_yet` / `supports` / `against` / `mixed` plus the number of scored forecasts; a verdict needs at
  least 30 scored forecasts at each of 30, 60 and 120 min) so the screen can say "not yet validated".
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
| Dose that could belong to two meals (or contradicting "took none" + a dose) | Linked to neither, but the meals AND the dose are all counted in the line (insulin is recorded around them; which meal a dose belongs to does not change the sum). Reason `insulin_link_ambiguous`, role `used`; not a training example |
| Dose with no meal recorded (a correction logged "with a meal", a snack bolus, a meal not logged yet) | **Counted in the line**: it lowers glucose like any dose (reason `dose_without_recorded_meal`, role `used`; kind `correction` is `correction_dose`). If it covered food that was never logged, glucose ends higher; the range always reaches up to the glucose-only value. Not a training example. (Until 2026-10-18 this case only widened the range; changed because a person who took insulin wants to see its effect in the prediction.) |
| Planned dose | Never counted until recorded as taken (`confirmation: planned` cannot hold an administered amount) |
| Basal, long/short/other insulin | Never used as a meal bolus |
| ICR or ISF not set | Meals ignored (`therapy_settings_missing`), glucose-only forecast, note says so. **No default ratio** |
| Entry older than the first saved settings | The first settings a person saves are taken to describe how they have been treating all along, so they apply to earlier entries too (later versions apply from their own date) |
| Carbs unknown | Meal kept but ignored; a dose linked to it cannot lower the mean |
| Uncertain meal/dose timing | Timing term widens the band |
| Database down / not configured | Glucose-only forecast, `saved: false`, fixed explanatory note; write routes answer 503 with a fixed message |
| Glucose stale/unavailable | Passed through; no forecast is produced |
| Forecast model unavailable | `baseline_unavailable`; nothing is extrapolated. The answer still carries `mealAware` (events, coverage, on-board estimates) so the screen can show what was logged, and the note says plainly that no forecast line exists |
| Glucose stale | `stale` with a fixed message; no number and no forecast |

Carbohydrate coverage (`GET /events/meals/:id/coverage`, and stored with each run): `units x ICR` versus the recorded
carbohydrate. It is an analysis feature. It explains history; it is not a dose suggestion and nothing in the wording
tells anyone to take insulin.

## API (all routes accept the optional `X-App-Token` header when `APP_API_TOKEN` is set; rate limited)

| Route | Purpose |
|---|---|
| `GET /forecast?horizonMin=5..180` | Current forecast (`ForecastDisplay`, `forecast-response.ts`). Saved before its outcome is known |
| `POST /forecast/counterfactual` `{excludeMealIds[], horizonMin?}` | What-if for a future "clear recent meals" action: those meals are left out, **delivered insulin still counts**, nothing is deleted or saved, labelled `counterfactual: true` |
| `POST /forecast/preview` `{mealId? \| meal{carbsG, eatenAt?, fatG?, proteinG?, absorptionClass?}, insulinUnits?, insulinAt?, horizonMin?}` | **"What would this do?" before anything is saved.** The meal (a stored draft by `mealId`, or typed grams) and/or the insulin amount are counted IN FULL on top of what is logged: a meal alone shows its uncovered rise, a meal with an amount shows the net effect, an amount alone shows the correction. Answer is a normal forecast with `preview: true`, `saved: false`, `mealAware.preview {mealId, insulinUnits}` and a first note saying so. Nothing is written; nothing counts until confirmed. A what-if of the numbers typed in, never a suggestion. 400 bad body, 404 unknown/withdrawn `mealId`, 422 time in the future / older than 48 h |
| `GET /forecast/evaluation` | Stored-outcome comparison of the layer against the glucose-only baseline, per horizon |
| `POST /events/meals` | Manual meal (`clientId`, `eatenAt`, `carbsG?`, `fatG?`, `proteinG?`, `fiberG?`, `absorptionClass?`, ...). 201 created / 200 same `clientId` / 409 probable double entry / 422 invalid time |
| `PATCH /events/meals/:id` | Correct a meal (`expectedRevision` for optimistic concurrency; `label`, carbs, time, speed class, `status: cancelled` to withdraw it). Records a revision and the before/after numbers. See "Withdrawn entries" |
| `POST /events/meals/:id/cancel` `{expectedRevision?, includeInsulin?}` (empty body fine) | **The Cancel button of the meal history: removes the meal AND the insulin that belongs to it in one atomic step** (one revision each, history kept, nothing deleted). The insulin is every active entry named against the meal (`meal_id`, any amount, a "took none" record included) plus the entries the system itself pairs with the meal by time (the same linking as the coverage view: one unambiguous dose within 30 min before / 20 min after, or a confirmed "took none"). A dose that could belong to two meals, or one far from the meal, is NOT removed. `includeInsulin:false` removes only the meal. Answer: `result` (`updated` / `unchanged` / `conflict` 409 / `not_found` 404), `meal`, `insulin[]` (the entries removed by this call), refreshed `forecast`. Repeating is safe: `unchanged` (200), also with an old revision once the meal is removed; a meal already removed still has its remaining named entries removed |
| `POST /events/insulin`, `PATCH /events/insulin/:id` | Insulin entry. `confirmation`: `confirmed` (taken), `uncertain` (taken, approximate), `planned` (not taken yet). `PATCH {status:"cancelled"}` withdraws a mistaken entry (see "Withdrawn entries") |
| `GET /events/meals/:id/coverage` | Carbohydrate vs insulin coverage under the ratio that applied at that meal |
| `GET /events/recent?hours=` | Recent meals/insulin for a picker |
| `GET /therapy/settings`, `GET /therapy/settings/history`, `PUT /therapy/settings` | ICR (g per unit) and ISF (mg/dL per unit) by time of day, versioned. `PUT` also accepts `timezone` (IANA name, e.g. `Asia/Beirut`): the local clock the time-of-day segments are read in |
| `POST /meals/analyze` (existing) | Unchanged fields + `mealEventId`, `forecast`, `forecastNote` (also on failure variants). The meal is stored as a **draft**; `forecast` is a **preview** of what it would do (see "Unconfirmed meals"), not the real forecast |

`clientId` is any id of 8-80 characters `[A-Za-z0-9._-]` (the app's own event id works); resending it never creates a
second event, including when the same request arrives twice at the same moment (the database decides, not a check-then-insert).
Every write response carries the refreshed `forecast` (or `null` when nothing changed).

Forecast, glucose, event, therapy and meal-analysis responses are sent with `Cache-Control: no-store`, so a browser or proxy
never shows a stale glucose number or forecast.

Every forecast point also carries `insulinOnBoardUnits` and `carbsOnBoardGrams` (estimates from logged entries only, run down with the same
kernels as the effects, `null` = unknown, `0` insulin only after an explicit "none taken"), so the graph can draw how they fall. The
values at "now" are in `mealAware.availability`.

Meals have a short `label` (typed, or derived from the items of a photo meal, e.g. "steamed white rice + grilled chicken").

Responses expose display fields only: no ICR/ISF values, scales, snapshots, raw Gemini JSON, internal ids other than
event ids, or any database detail (tests assert this).

## Unconfirmed meals never count (scan -> insulin -> confirm)

A photo meal is stored as a **draft** (`status: draft`). Only `PATCH /events/meals/:id {status: "confirmed"}` (or a meal entered by hand, `manual_entry`)
makes it part of the history. A draft is **never** counted: not in the forecast line, not in carbs/insulin on board, not in `GET /events/recent`, not in
the carbohydrate-coverage view, not in the probable-double-entry check, not as a training example. So backing out of the scan screen, a crash, or a
lost connection leaves the forecast exactly as it was: the server enforces this, the app cannot get it wrong. An abandoned draft stays as a row (cancelling
it is optional tidying). A dose named against a draft is read as if no meal had been named (it was taken, so it acts; it pairs with a confirmed meal
around it, or with the draft once confirmed). Forecasts stored before this rule that counted a scan which was never confirmed are excluded from learning,
evidence and performance (`NO_WITHDRAWN_EVENTS`).

What the person sees while deciding comes from **`POST /forecast/preview`** (and the `forecast` in the `/meals/analyze` answer, which is a preview of the
scanned meal): the meal counted in full, with the insulin amount they are considering if any. Confirming the meal and recording the insulin
(`POST /events/insulin`, `confirmation: confirmed`) is what makes both count.

## What-if: "where would I be if everything I logged counted?" (`mealAware.allLoggedCounted`)

The main line counts every delivered dose and every meal that has insulin recorded around it, but deliberately does **not** move for a meal
with no insulin record at all (the insulin may just not be logged yet; the range stretches upward instead), or for a dose paired with a meal that
has no carbohydrates. `allLoggedCounted` shows where the line would go if those were counted too, separately, without changing the main line:

* The same engine, with every logged delivered dose and every logged meal counted in full (`applyAll`, reason `what_if_counted`) and
  nothing else eaten or taken. Still left out, because nothing may be invented: planned doses, basal/long-acting insulin, meals without
  carbohydrates or without ratios, meals the person excluded, withdrawn entries.
* Present only when at least one entry is left out of the main line **and** counting it moves the line by at least 15 mg/dL somewhere (a dose
  that finished acting hours ago, or a small leftover effect, does not trigger it). Otherwise `null`. Also `null` in what-if (counterfactual) views and when no glucose
  forecast exists.
* Shape: `description` (fixed text, "not a prediction"), `points[]` (`minutes`, `time`, `adjusted`, `low`, `high`, same 5-minute grid, the
  80% range is included so it never shows false precision), `summary` (`lowestMgdl/At`, `highestMgdl/At`, `lowestRangeEdgeMgdl`) and
  `countedEntries[]` (the entries it counts that the main line leaves out, each with the reason). A plain sentence is also added to `notes`.
* It is **not saved** and **never learned from**; the stored run is the main line. It is an observation about the entries the person
  logged, not a dose suggestion, and no forecast value feeds any dose calculation.

## Meal absorption model (shadow first, 2026-10-18)

How fast a meal's carbohydrate appears now depends on the photo analysis (absorption class and confidence, fat, protein, fibre, GI as weak evidence) through a mass-conserving early/delayed mixture, instead of one fixed gamma(2) curve. It runs in **shadow** mode by default (`ABSORPTION_MODE`; not yet deployed, needs migration 0008): the incumbent draws the forecast, the candidate is stored under a `-shadow` model version, scored against real outcomes and compared in `GET /forecast/evaluation` (`absorptionModel`). Shadow rows never feed learning, evidence or performance. Every run stores each meal's features and resolved profile (`absorptionFeatures`, `absorption` in the run inputs), so replay reproduces the forecast. Full equations, parameters, sources, results and limitations: `../../docs/ABSORPTION-MODEL.md`.

## Withdrawn entries (the app's trash button)

`PATCH /events/meals/:id` and `PATCH /events/insulin/:id` with `{ "status": "cancelled", "expectedRevision": n }` withdraw an entry. Nothing is deleted:
the row and its revision history stay. A withdrawn entry is ignored everywhere:

* **Live forecast:** not loaded, so it is not in the line, the band, `mealAware.events`, the carbs/insulin on board, or "insulin recorded" (a
  withdrawn "I took none" record no longer says insulin was confirmed absent: the meal is range-only again).
* **New runs:** `forecast_runs` and `prediction_event_links` of runs made after the withdrawal contain no row for it. Older runs that used it
  are kept unchanged (history is never rewritten).
* **Linking:** a withdrawn meal is not offered to any dose. A dose that was NAMED against a withdrawn meal (typically a photo that was scanned again and the first scan replaced) is read as if no meal had been named: it pairs with a meal logged around it in time (the replacement), or else it is a lone dose. Either way it was taken, so it acts and stays in the insulin-on-board count (`declaredMealOf` in `forecast.service.ts`).
* **Learning, evidence, performance:** forecasts made earlier from a run that used an entry which was LATER withdrawn (the meal, a dose, or the
  dose linked to a meal) are excluded from the scale fitting, from `models.eventLayerEvidence` / `GET /forecast/evaluation` and from
  `model_performance` (`NO_WITHDRAWN_EVENTS` in `personalization.service.ts`). A withdrawn entry is never a trustworthy training event.
* **Responses:** the PATCH answer carries the refreshed `forecast`. Withdrawing an entry that is already withdrawn answers **200** with
  `result: "unchanged"` (also with an old `expectedRevision`, as an offline retry would send) and still carries the forecast. Any other edit of a
  withdrawn entry, including setting a meal back to `confirmed`, is refused with 422 `a cancelled entry cannot be edited` (no silent revival;
  log it again as a new entry). A stale `expectedRevision` on an entry that is still active is 409 `conflict` and changes nothing. A status other
  than `cancelled` on insulin (or any unknown status) is 400. `GET /events/recent` leaves withdrawn rows out and carries `status` on every meal
  (`draft` / `confirmed` / `manual_entry`) and insulin entry (`active`).

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

## Going live

Done on the production service (2026-10-16): `0006` and `0007` applied to the production database (additive, backups taken
first); the web-app nginx site (`/etc/nginx/sites-available/sugarsense-web`, port 8090) proxies `/forecast`, `/events` and
`/therapy` to the backend (backup `sugarsense-web.bak-20261016-185745`); `DATABASE_URL` is set in the backend's `.env`; the
backend runs the first version (`f95dfbd`).

Still to do for the follow-up fixes: push `main` (the deploy timer builds and restarts the backend in about 3-5 minutes; its
tests skip the database suite because no test database is configured there). No migration is needed and no `.env` change.
The front-end contract is in `MASTER-PROMPT-UI-FORECAST-INTEGRATION.md`.

## Tests

* `src/engine/*.spec.ts` - kernels (spec golden vectors), event layer, linking, composer, fitting (pure, run anywhere).
* `src/forecasting/schemas.spec.ts` - request validation, time zones, ratio resolution (pure).
* `src/forecasting/forecasting.db.spec.ts`, `forecasting.http.spec.ts` - real PostgreSQL, application role. Run on the VM:
  `set -a; . ~/sugarsense-test-db.env; set +a; npx vitest run src/forecasting` (scratch database `sugarsense_test`).

## Known limits

No Kalman filter yet (the spec's online residual correction); the baseline's trend overlap is corrected with a measured
table, which is an approximation (the layer was not better than the glucose-only line at 120 min in synthetic tests);
the 60-120 min baseline error is extrapolated from 5-60 min measurements; exercise and sleep are not used; fat/protein
amplitudes are not learned; photo-time timing uncertainty (10 min) and the dose-uncertainty factor (50%) are engineering
defaults; one user, no authentication; meal edits change totals, not individual items.
