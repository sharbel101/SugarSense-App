# MASTER PROMPT - UI/UX + integration chat: log carbs and insulin from anywhere, meal-aware forecast, IOB/COB, insulin-ratio settings

Paste this whole file into the UI chat (Claude Code opened in `C:\Users\Pc\sugarsense_app_dev`).
Written 2026-10-16 by the backend/VM chat, against repo `main` plus the uncommitted backend work in `backend/src/forecasting`,
`backend/src/engine`, `backend/db/migrations/0006_event_forecasting.sql`. Where this file and the live code disagree, trust the code,
then tell the user.

---------------------------------------------------------------------------------------------------

## 0. Your lane and the rules that win

* You own `mobile/` (and UI docs). You never edit `backend/`, `deploy/` or the VM. If the contract is missing something,
  write it down as a request for the backend chat (section 11) - do not work around it on the device.
* Read first, in this order: `mobile/AGENTS.md` (+ `mobile/docs/MOBILE_UIUX_FRONTEND_AI_GUIDE.md`, `UIUX_COMPLIANCE.md`),
  root `CLAUDE.md` sections 2, 3, 9, 10 (safety and wording **win**), `backend/src/forecasting/README.md` (the contract),
  `backend/src/forecasting/forecast-response.ts` (the exact response types), `backend/src/meals/README.md`
  (new additive fields at the end), the Expo SDK 57 docs (<https://docs.expo.dev/versions/v57.0.0/>).
* Existing code you build on (do not rewrite what works): `src/services/GlucoseProvider.tsx` (one 60 s poller),
  `src/services/glucoseState.ts`, `src/api/glucoseContract.ts` (the "shape gate" pattern: anything that does not match is
  rejected whole, never repaired), `src/services/glucoseChart.ts` + `src/components/GlucoseChart.tsx` (chart + press-and-drag
  scrub), `src/components/QuickAdd.tsx` (the "+" button and its sheet), `src/services/events.ts` + `EventsProvider.tsx`
  (device-only event store), `src/services/mealService.ts`, `src/api/mealsApi.ts`, `src/api/requestHeaders.ts`.

### Non-negotiable product rules

1. **This is logging, not dosing.** The app records what the person actually did. It never calculates, suggests or recommends an insulin
   dose in this change, never says "take", "inject", "add X units", "you need". No forecast number is ever an input to a dose.
   (The bolus calculator of `CLAUDE.md` section 10 is a separate, later feature and must not use any forecast output.)
2. **Unknown is not zero.** `null` from the server is shown as "unknown" / "not logged", never as `0`. Insulin that was not logged is **not**
   "no insulin taken". Only an explicit "I took no insulin" (a confirmed 0 U entry) means none.
3. **Nothing is computed on the device.** No forecast, no insulin-on-board, no carbs-on-board, no coverage, no ratio maths in `mobile/`.
   Show what the server returns.
4. **Never invent, repair or extrapolate** a missing point, band or number. A failed state looks like a failed state.
5. Wording (`CLAUDE.md` section 2): "estimated carbohydrates", "predicted range", "based on what you logged", "record insulin you took",
   "not medical advice". Never "accurate", "optimal", "your glucose will be", "clinically validated".
6. A planned dose is not a taken dose. v1 of this UI does not offer "planned"; the server supports it and ignores it for the forecast.

---------------------------------------------------------------------------------------------------

## 1. What the backend now offers (and what is NOT live yet)

**Deployment status (updated 2026-10-17):** the first version of these routes is live on the public API (`GET /forecast`, `/events/*`,
`/therapy/*`, and `POST /meals/analyze` with `mealEventId` / `forecast` / `forecastNote`). The follow-up fixes listed in the box below are
tested but may not be deployed yet; build to the contract as written here, it is a superset and compatible. Always:

* build against the contract with stubbed `fetch` in tests (plain-Node tests like `tests/events.test.mjs`);
* treat 404/503 from these routes as "the server cannot do this right now": keep the **old** behaviour (the glucose-only forecast from `GET /glucose`),
  keep logged events **pending on the device**, and say so in plain words. Never crash, never fake success;
* run the real end-to-end check in section 10.

**Contract additions after a full simulated-usage test (2026-10-17) - all additive:**

* `models.eventLayerEvidence: { status: 'none_yet' | 'supports' | 'against' | 'mixed', samples }` on every `ok` forecast: how well the meal/insulin
  adjustment has done against the glucose-only line on this person's own stored outcomes. While `none_yet` (fewer than 30 scored forecasts per
  horizon) show the adjusted line as "not yet validated" in the About-this-forecast panel; never as proven. `against` / `mixed`: say so plainly.
* `baseline_unavailable` now also carries `mealAware` (the logged events, coverage and on-board estimates) so the screen can still list what was
  logged. Its `notes` say plainly that no forecast line exists. Do not draw a line from it.
* `PUT /therapy/settings` accepts `timezone` (IANA name, e.g. `Asia/Beirut`; use the device's zone, `Intl.DateTimeFormat().resolvedOptions().timeZone`).
  Time-of-day ratio segments are read in that zone. Send it with every save.
* A cancelled meal's `GET /events/meals/:id/coverage` answers **404**, not an error banner: treat it as "nothing to show".
* Responses carry `Cache-Control: no-store`; do not add client-side caching on top.
* **Removing an entry (trash button), both routes:** `PATCH /events/meals/:id` and `PATCH /events/insulin/:id` with `{ status: "cancelled", expectedRevision }` return 200 `result: "updated"` with the refreshed `forecast`. Removing an entry that is already removed is 200 `result: "unchanged"` (even with an old revision), also with a `forecast`: treat both as success and drop the row. 409 `conflict` = the entry changed, reload and ask again; 422 = it was already removed and cannot be edited; 400 = the server did not understand the status. `GET /events/recent` leaves removed rows out and carries `status` on every meal and insulin entry. A dose that was recorded for a meal you removed stops moving the line (it still counts as insulin on board and widens the range), and nothing removed is ever used for learning.
* **Change 2026-10-18 (scan flow) - nothing counts until it is confirmed, and a preview shows what a meal would do.** Server rules: a scanned meal is a DRAFT and is never part of the real forecast, carbs on board, insulin on board pairing, or `GET /events/recent` until you `PATCH /events/meals/:id {status:"confirmed"}`. Backing out of any screen therefore needs NO cleanup call (a `PATCH {status:"cancelled"}` is optional tidying). **Flow to build:** (1) after the scan show the carbs (editable) and, right away, the **preview** chart: use the `forecast` in the `/meals/analyze` answer (`preview: true`, the meal counted in full: the line RISES) and re-call `POST /forecast/preview {mealId}` after the person edits the carbs (send nothing else; the edit is not saved until confirm, so for edited grams send `{meal:{carbsG, eatenAt}}` instead of `mealId`); (2) then the insulin step: as the person types or accepts an amount call `POST /forecast/preview {mealId, insulinUnits}` (or `{meal:{...}, insulinUnits}`) and redraw: this shows the NET effect; label the chart "Preview - not saved" (`preview: true`) and never as the real forecast; (3) one explicit confirm ("I took it"): `PATCH meal {status:"confirmed", carbsG?}` then `POST /events/insulin` (`confirmation: confirmed`, `mealId`); only then does anything count; (4) back / close before confirm: do nothing. Remove the copy "Includes the meal you just saved..." and the "line stays put" text: before confirm the preview shows the rise; after confirm the real forecast includes it. The preview also works for a correction with no meal: `POST /forecast/preview {insulinUnits: n}` (a what-if of the amount the person typed; never suggest the amount).
* **Cancel button for a meal and its dose (requested; one call):** `POST /events/meals/:id/cancel` (body `{expectedRevision?}`, empty is fine). It removes the meal AND the insulin that belongs to it in one atomic step: every dose named against the meal plus the dose the server itself pairs with it by time (the same pairing `GET /events/meals/:id/coverage` reports as `insulinRecord: "linked"`, `insulinUnits`). So the **meal-history Cancel button and the scan / post-meal Cancel button both make exactly this one call**; no two-step ordering in the app. Before the confirm sheet, call `GET /events/meals/:id/coverage` to show what goes with it ("Remove this meal and 18 U of insulin?"); a dose that could belong to two meals or is far from the meal is NOT removed, and the answer's `insulin[]` lists exactly what was removed (show it on the "Cancelled" screen). Treat 200 `updated` and `unchanged` as success (a repeat is safe), 409 `conflict` = "it changed, reload and ask again", 404 = already gone. The answer also carries the refreshed `forecast`; refresh the Logged list and the history after it. A scanned draft that was never confirmed: the same call (it only removes the draft and any dose named against it); backing out with the Back arrow still needs no call. **Cancelled means removed from SugarSense, not erased:** the rows stay on the server (with their revision history) so earlier forecasts remain reproducible, but they disappear from every list and forecast and are never used for learning; the confirm text must say it only removes the entry from the app and does not undo insulin already taken. `includeInsulin: false` removes only the meal (rarely wanted).
* **Change 2026-10-18 - logged insulin now moves the line:** every delivered dose is counted in the central line, including a dose with no meal recorded (`reason: "dose_without_recorded_meal"`, now `role: "used"`; before it was `range_only`) and the meals around an ambiguous dose (`reason: "insulin_link_ambiguous"`, now `used`). The chart tooltip must not say "widens the range only" for them (it is "used"). If such a dose covered food that was never logged the glucose ends higher than the line; the range always reaches up to the glucose-only line, so keep the glucose-only line visible.
* **What-if line `mealAware.allLoggedCounted`:** `null` normally. When present it is a what-if, not a prediction: every logged dose and meal counted in full, nothing else eaten or taken. It now appears only when the main line still leaves something out: a meal with no insulin record, or a dose paired with a meal that has no carbohydrates. Draw it as a separate dashed line with its own 80% range, labelled with `description` ("What-if, not a prediction ..."), and show `summary` in one sentence ("If everything you logged counts and nothing else is eaten or taken, the line reaches its lowest around X mg/dL at about +Y min"; the server also adds that sentence to `notes`). `countedEntries[]` lists which entries it counts; link them to the Logged today rows. Never call it a prediction or a recommendation. Suggestion for the Insulin form: `kind` defaults to `bolus` ("With a meal"); a dose logged that way without a meal now moves the line anyway, but "Correction (no meal)" is the accurate label, so make it easy to pick. The what-if line is NOT a substitute for the main line: the main line is what the person asked to see.
* Resending the same `clientId` (an offline retry, or a double tap) always returns the existing event - safe to retry; after a queued entry is finally
  sent, **refresh the "Logged today" list** (it kept showing "not available" after a failed refresh until the app was reloaded).
* The layer now removes the part of the rise the glucose-only model already extrapolates (trend-overlap correction). No UI change; do not describe it to users.

**Which API draws what (this answers "do we need new APIs?" - no new backend work for the main flow):**

| Need | Source |
|---|---|
| Current reading, last-hour history, hypo/hyper risk chips, "ranges" for 15/30/45 min | `GET /glucose` - **unchanged**, keep using it exactly as now |
| The forecast line and band to 3 hours, adjusted for logged meals/insulin, plus the glucose-only comparison line | **`GET /forecast`** (new; the glucose-only model is inside it, so it replaces the *forecast line*, not the reading) |
| Insulin on board / carbs on board *right now* | `GET /forecast` -> `mealAware.availability` |
| Save a meal / insulin / correction | `POST /events/meals`, `POST /events/insulin` (each response carries the refreshed forecast) |
| Fix or cancel an entry | `PATCH /events/meals/:id`, `PATCH /events/insulin/:id` |
| List what was logged | `GET /events/recent?hours=12` |
| Insulin-to-carb ratio and correction factor | `GET/PUT /therapy/settings`, `GET /therapy/settings/history` |
| Photo meal | `POST /meals/analyze` (same route; response now also has `mealEventId`, `forecast`, `forecastNote`) |

IOB/COB **curves** along the graph are in the API too: every forecast point has `insulinOnBoardUnits` and `carbsOnBoardGrams` (see section C). Do not compute them on the device.

Details you must read in the README/types, not guess: `ForecastDisplay` is a union on `status`:
`ok` | `baseline_unavailable` | `stale` | `unavailable`. In `ok`: `anchor {measuredAt, glucoseMgdl, ageMinutes}`, `horizonMin`, `points[]`
(every 5 min, up to 36; each `{minutes, time, baseline | null, adjusted, low, high, extension, insulinOnBoardUnits | null, carbsOnBoardGrams | null}`; `low`/`high` bound the 80% range),
`mealAware {changedForecast, counterfactual, excludedMealIds, availability{...}, events[{id,type,time,role,reason}]}`,
`models`, `saved`, `notes[]` (plain-language limits to show), `disclaimer`.
Write `src/api/forecastContract.ts` as a pure, import-free mirror of `forecast-response.ts` with a parser (`parseForecastResponse`)
that rejects anything off-shape - same pattern as `glucoseContract.ts` - and unit-test it under plain Node with a real-looking sample
(the backend README shows the shape; a captured live sample is in section 10).

---------------------------------------------------------------------------------------------------

## 2. Work packages (do them in this order; each ends with typecheck, lint, tests)

### A. Data layer

1. `src/api/forecastContract.ts` (types + parser) and `src/api/forecastApi.ts` (`fetchForecast(signal)` using `API_URL`, `ngrokBypassHeaders`,
   optional `X-App-Token` header read from an `EXPO_PUBLIC_` env var **only if present** - the server enforces it only when the user turns it on;
   a token in the web bundle is not a secret and must not be described as security).
2. `src/services/ForecastProvider.tsx` modelled on `GlucoseProvider`: polls `GET /forecast` every 60 s while the app is active (the reading changes every
   3-5 minutes; do not poll faster), one request at a time, aborts on background, fetches on foreground. Expose `{ view, refreshing, refresh, applyForecast }`.
   `applyForecast(f)` lets an event save push the forecast returned by the server into the screen **immediately**, without waiting for the next poll.
   Failure semantics mirror `glucoseState.ts`: keep the last good forecast for at most ~10 minutes labelled "as of HH:MM", then drop it; never show
   an old forecast as current. If `GET /forecast` is 404/503 or fails, **fall back to the existing `GET /glucose` forecast line** (current behaviour) and
   show one quiet line "Meal and insulin entries are not included right now."
3. `src/api/eventsApi.ts` + `src/api/therapyApi.ts`: typed wrappers for the routes in section 1, each returning a discriminated result
   (`created | exists | duplicate | invalid | conflict | not_found | server_unavailable | network_error`) with the server's `reason` string. HTTP map:
   201 created, 200 exists/updated/unchanged, 409 duplicate or conflict, 422 invalid, 404 not found **or route not deployed**, 503 cannot save, 400 validation.
4. Rewrite `EventsProvider` to be API-backed and **offline-safe**:
   * Each event keeps its client-generated `id`; send it as `clientId` (8-80 chars of `A-Za-z0-9._-`; your `newEventId()` already fits). Resending the same
     id can never create a second event - that is what makes retries safe.
   * States per event: `pending` (not confirmed by the server), `saved`, `failed` (server said invalid - show the `reason`). A save that fails on the network or with
     404/503 stays `pending` and is retried with backoff and on every foreground; the user can tap "Send now". Persist the pending queue with
     `@react-native-async-storage/async-storage` (already installed) so a dose log is not lost when the app is closed. Wrap every storage call in try/catch.
   * Remove `LOCAL_ONLY_NOTICE` wherever the event is `saved`; show it (reworded: "Not sent to the server yet - the forecast does not include it") only while `pending`.
   * On success call `ForecastProvider.applyForecast(response.forecast)` when `forecast` is not null.
   * A 409 `duplicate` means "looks like an entry you already made" (same time +/- 2 min and amount): show it and offer "Save anyway" (resend with `allowDuplicate: true`).

### B. The floating "+" button, available everywhere

Today `QuickAddFab` is rendered only inside `HomeScreen`. Make it a **global overlay**: render one `QuickAddFab` at the navigator root (e.g. a `GlobalQuickAdd`
sibling inside `RootNavigator`) so it floats over Home, Predict, Safety, Insights, Profile. Hide it on the Scan/camera flow and while a modal sheet or the keyboard is open.
Keep it 56 dp, bottom-right, lifted above `CustomTabBar` (compute the offset once from insets + tab bar height; do not hard-code 96 in every screen), never covering the chart
scrub area's primary content, with `accessibilityLabel="Add carbs or insulin"`. It need not be draggable.

The sheet's first step is **two big choices** (replace the current three-row menu):

* **Carbs / food** (icon `fork`) - "Log carbohydrates you ate, without a photo."
* **Insulin** (icon `droplet`) - "Record insulin you took." Inside the insulin form a chip row "What was it for?" selects the kind: *With a meal* (`bolus`), *Correction* (`correction`),
  *Long-acting / basal* (`basal`). (The existing separate "Add correction" row folds into this; the existing correction form's optional "current glucose" stays on the device only -
  the server has no field for it, do not send it.)

Under the two choices, show a third small row only when it applies: **"I took no insulin for [meal]"** when the latest forecast has `mealAware.availability.mealsRangeOnly > 0`
(see the banners in section D). Also a small link "Logged today" opening the list in section 5 (Event list).

**Carbs / food form -> `POST /events/meals`** (keep the validation you already have in `events.ts`; the server repeats it):

| UI | API field | Rule |
|---|---|---|
| event id | `clientId` | reuse on retry |
| time (minutes ago / clock) | `eatenAt` ISO UTC | not in the future, not older than 48 h |
| carbs (g) | `carbsG` | 0-400, 1 decimal; the UI keeps requiring > 0 |
| fat / protein / fibre (optional) | `fatG` `proteinG` `fiberG` | **omit when blank** (unknown), never send 0 for "didn't fill in" |
| "How fast does it hit?" (advanced, optional) *Fast (juice, sweets)* / *Normal* / *Slow (fatty or large)* | `absorptionClass` `fast`/`medium`/`slow` | only when the person chooses; default omitted |
| "time is approximate" toggle | `timingUncertaintyMin: 15` | omit when off |
| label | `label` | 1-80 characters, shown in lists; `note` (<= 500) is separate free text |

**Insulin form -> `POST /events/insulin`:**

| UI | API field | Rule |
|---|---|---|
| event id | `clientId` | |
| time | `administeredAt` | not in the future, <= 48 h old |
| units | `unitsAdministered` | 0-100, 2 decimals; the existing sanity cap of 50 stays in the UI |
| "I took this insulin" checkbox (already required) | `confirmation: "confirmed"` | |
| "I'm not sure of the amount or time" (new, optional) | `confirmation: "uncertain"` + `timingUncertain: true` | widens the range on the server |
| kind chips | `kind`: `bolus` / `correction` / `basal` | basal is stored and shown but never used as a meal dose |
| insulin type | `insulinType`: `rapid` `ultra_rapid` `short` `long` `other` | add *Ultra-rapid* to `INSULIN_TYPES`; pre-select from `GET /therapy/settings` `insulinType` if set, otherwise make the person choose - do not assume. Only rapid/ultra-rapid act as meal or correction insulin in the forecast; say so in helper text |
| "For which meal?" (shown for *With a meal*) | `mealId` | pick from `GET /events/recent?hours=6` meals (and just-saved pending ones once they have a server id); optional but strongly encouraged: it removes the server's guesswork. If skipped, the server may match a dose to a meal by time only when it is unambiguous |
| "I took no insulin" action | `kind: "bolus"`, `confirmation: "confirmed"`, `unitsAdministered: 0`, `administeredAt` = meal time, `mealId` | this is the *only* way to state "none taken" |

**After saving** (both forms): the sheet shows "Saved. Forecast updated." (or, if the forecast could not be refreshed, "Saved. The forecast will update on the next
reading."). The chart updates immediately from `response.forecast`. If the server returns `result: "duplicate" | "invalid" | "conflict"` show the reason in the sheet, keep the form.
Never claim the forecast was updated when `forecast` is null.

### C. Chart changes (Home and Predict, same component)

Add `buildForecastChart(glucoseOk, forecastOk | null)` next to `buildGlucoseChart` (pure, unit-tested; keep `buildGlucoseChart` as the fallback path):

* History and the "latest reading" dot still come from `GET /glucose`.
* **Forecast line = `adjusted`** (continues from the latest reading, same dashed style as today) for points with `extension: false`.
* **Extension (after +120 min)**: separate lighter/dotted polyline with a small label "Only your logged meals and insulin move this part." These points have `baseline: null`.
* **Glucose-only comparison line = `baseline`** (thin grey), drawn only when it differs from `adjusted` by >= 1 mg/dL somewhere; legend item "Glucose-only forecast". Hidden otherwise to reduce clutter.
* **Band = `low`/`high` of every 5-minute point** (upper edge forward, lower edge back), legend "80% predicted range". It replaces the 15/30/45-minute band from `ranges` while `/forecast` is `ok`; keep the old band as fallback.
* **Axis:** x domain from the first history point to `anchor + horizonMin` (up to +180); ticks Latest, +1 h, +2 h, +3 h. y domain includes every `low`/`high` and the history, rounded as today.
* **Event markers** on the time axis from `mealAware.events[]` (`type`, `time`, `role`): a fork/droplet glyph at the event time when it falls inside the x domain. `role: used` = filled; `range_only` / `not_used` = hollow with a dashed outline; `excluded` hidden in this change. Tap a marker -> small tooltip ("Meal, 45 g - insulin not recorded" / "Insulin 4 U - used"), data from your own event list, matched by id. Each marker has an accessibility label.
* **Scrub readout** (press and drag, existing behaviour): "+90 min - 168 mg/dL (range 120-226)"; when `baseline` exists add "glucose-only 150".
* **Accessibility text alternative** (required): trend + range + whether meals/insulin are included, e.g. "Forecast for the next 3 hours including 1 logged meal and 1 insulin dose. Around 150 to 190 milligrams per decilitre in 2 hours; range 94 to 286."
* The hypo/hyper chips and `summariseRisk` keep reading `GET /glucose` unchanged (they exist only there). Do not mix the two sources into one series.

**Insulin on board and carbs on board (the user wants these on the graph and changing every reading):** two chips in the chart card header, from
`forecast.mealAware.availability`, refreshed with every `/forecast` result (each poll, each event save), labelled "as of HH:MM" from `anchor.measuredAt`:

* `insulinOnBoardUnits`: number -> `2.3 U` (1 decimal); **`null` -> "unknown"**, never 0. Caption by `availability.insulin`: `logged` "from the doses you logged", `confirmed_none` "none taken (you confirmed)", `none_recorded` "no insulin logged recently".
* `carbsOnBoardGrams`: number -> `18 g` (integer); `null` -> "none logged".
* Tap a chip -> short explainer: "Insulin on board is the part of the doses you logged that is still to act, from a standard action curve. Carbs on board is the part of logged meals not yet absorbed. Estimates from your entries only."
* No "bolus", "dose", "needed" wording on these chips.
* **Curves under the glucose line (available now):** draw two thin, clearly labelled area/line tracks from the per-point values `insulinOnBoardUnits` (units, left scale or its own small panel) and `carbsOnBoardGrams`. They start at the chip values and run down to the right with the forecast. Each track is drawn only for points where the value is a number; a `null` track is not drawn at all (and the chip says "unknown" / "none logged"). A track is a visual aid on its own axis, never mixed into the mg/dL axis; give each a text alternative ("Insulin on board falls from 2.3 to 0.9 units over the next 2 hours"). Do **not** compute them on the device.

Show `notes[]` under the chart as an expandable "About this forecast" (collapsed by default, count badge) and `disclaimer` as small text. Show "Not saved" only when `saved === false` and it is not a what-if.

### D. Banners that tell the person what the model is missing (decided by the server's numbers)

Pure function `forecastPrompts(forecastOk)` -> list of prompts, unit-tested, rendered above the chart in priority order:

1. `availability.therapySettings === "unavailable"` and (`mealsNotUsed > 0` or `insulinDosesUsed + insulinDosesRangeOnly > 0`): "Set your insulin-to-carb ratio so logged meals can be used." [Open settings].
2. `availability.mealsRangeOnly > 0`: "A meal you logged has no insulin recorded, so it is not moving the forecast line yet. The range is wider to cover that." [Record insulin taken] [I took none].
   (Opens the insulin form preselected to that meal / posts the confirmed-0-U entry.)
3. an `events[]` item with `reason === "dose_without_recorded_meal"` (since 2026-10-18 this dose is `role: "used"`: it moves the line): optional, low-key: "This dose has no meal recorded; it is counted as lowering glucose." [Link to a meal] (-> `PATCH /events/insulin/:id {mealId}`). Do NOT say it "widens the range only".
4. an `events[]` item with `reason === "insulin_link_ambiguous"` (now `role: "used"` too, meals and dose are all counted): "A dose could belong to two meals; tell us which to tighten the range." [Choose meal].
5. `availability.insulin === "none_recorded"` and no meals: no banner; the IOB chip already says "unknown".

### E. Photo flow (MealReview -> PostMeal)

* `mealsApi.analyzeMeal`: add optional request fields `clientId` (use the screen's event id so a retry maps to the same meal) and `eatenAt`; extend the response type with optional
  `mealEventId`, `forecast`, `forecastNote` (older servers will not send them: everything must still work).
* `MealReviewScreen` confirm: instead of building a local event, `PATCH /events/meals/:mealEventId` with `{ carbsG: displayTotal }` **only if the person changed an item** plus `status: "confirmed"`.
  The original AI number stays on the server. If `mealEventId` is null (server could not save) fall back to `POST /events/meals` with the confirmed values and the same `clientId`.
* `PostMealScreen`: replace the "Forecast and dose suggestion ... not available" card with the real forecast chart (reuse the Home chart component and `forecastNote`) and a prompt card
  "Did you take insulin for this meal?" with **[Record insulin taken]** (opens the insulin form preselected to this meal), **[I took none]** (confirmed 0 U), **[Not yet]** (leaves the banner of D.2 active).
  Remove every "dose suggestion" phrase and the local-only paragraph. Keep the decision-support disclaimer.
* If analysis failed (`no_food_detected` / `needs_manual_entry`) the response still carries the glucose-only `forecast` and a `forecastNote`; show that note and offer manual entry (the same Carbs form).

### F. Settings: insulin-to-carbohydrate ratio and correction factor (Profile -> "Insulin settings")

Routes: `GET /therapy/settings`, `PUT /therapy/settings`, `GET /therapy/settings/history` (see `backend/src/forecasting/therapy.schema.ts` for exact limits).

* **ICR** = grams of carbohydrate covered by **1 unit** of rapid-acting insulin (show as "1 unit : 10 g"). **Correction factor (ISF)** = mg/dL lowered by **1 unit**. The meal effect needs both
  (carbohydrate effect = ISF / ICR), so ask for both with a plain explanation, but allow saving ICR alone (the server keeps the previous ISF).
* Time-of-day segments: first starts 00:00, start times strictly increasing, up to 8. Limits: ICR 1-150, ISF 5-500, max 2 decimals. Validate on the device with those limits and show the server's 400 text if it still rejects.
* Fields: source (*Prescribed by my care team* -> `clinician_prescribed` / *Entered by me* -> `user_entered`), insulin type (*Rapid-acting* / *Ultra-rapid*), optional "effective from", optional note.
* Each save is a **new version**: say "Saved as version N. Earlier forecasts keep the values they used." Show previous versions read-only from `/therapy/settings/history`.
* While `status === "not_set"` show the server's `whenMissing` text. Always show `disclaimer`. **Never pre-fill, suggest, or auto-adjust a ratio.** Wording: "the values you or your care team entered".
* Never display ICR/ISF inside forecast cards or chips.

---------------------------------------------------------------------------------------------------

## 3. State matrix for the forecast area

| Server answer | What the person sees |
|---|---|
| `ok`, events included | Chart as in C, chips, prompts from D, notes expandable |
| `ok`, nothing logged | Same chart; `adjusted == baseline` so no grey line; IOB "unknown", COB "none logged" |
| `baseline_unavailable` | History only + the server's `reason`; no forecast line; IOB/COB chips hidden (nothing is estimated without a forecast); the "+" button still works; the logged-entry list may still use `mealAware.events` |
| `stale` / `unavailable` | Exactly today's stale/unavailable treatment from `glucoseState.ts` |
| network failure | Previous forecast kept <= 10 min with "as of HH:MM", then dropped |
| 404 / 503 from `/forecast` | Fall back to the `/glucose` forecast line + "Meal and insulin entries are not included right now." |
| `saved: false` (not what-if) | Small "This forecast was not saved to your history." |
| event save pending | Row shows "Not sent yet - retry"; the chart does **not** include it |

---------------------------------------------------------------------------------------------------

## 4. Copy deck (use as written; every string is checked against the wording rules)

* Menu: "Carbs / food" - "Log carbohydrates you ate, without a photo." / "Insulin" - "Record insulin you took."
* Insulin helper: "Record only insulin you actually took. SugarSense does not tell you how much to take."
* Saved: "Saved. Forecast updated." / "Saved. The forecast will update on the next reading." / "Not sent yet - we will retry."
* No insulin: "I took no insulin for this meal" - confirm sheet: "This tells SugarSense that no rapid insulin was taken for this meal. If you are not sure, leave it unrecorded instead."
* Chips: "Insulin on board" (unknown / 2.3 U), "Carbs on board" (none logged / 18 g), caption "from your entries".
* Legend: "Measured", "Forecast (includes what you logged)", "Glucose-only forecast", "80% predicted range".
* Disclaimer: use the server's `disclaimer` verbatim.

---------------------------------------------------------------------------------------------------

## 5. Event list and corrections ("Logged today")

A sheet from the "+" menu and from the chart card: `GET /events/recent?hours=12` merged with the pending queue, newest first. Each row: time, what (carbs with `carbs.kind` badge *estimated* /
*corrected* / *entered*; insulin with units, kind, `confirmation`), status (*saved* / *not sent yet*). Tap -> edit sheet: meals can change carbs, time, approximate-time toggle, speed class, or be
**cancelled** (`PATCH {status:"cancelled"}`: removes it from the forecast, nothing is deleted); insulin can change units, time, confirmation (`confirmed`/`uncertain`) and linked meal.
Send `expectedRevision`; on 409 `conflict` reload and say "This entry changed - please check it again." A mistaken insulin entry is withdrawn with `PATCH /events/insulin/:id {status:"cancelled"}`: it disappears from the list, stops acting in the forecast, and is kept in the history on the server. Show a confirm sheet ("Remove this entry? It will no longer be used in your forecast.").
Every edit returns the refreshed forecast: feed it to `applyForecast`.

---------------------------------------------------------------------------------------------------

## 6. Things to remove or change in the existing code

* `LOCAL_ONLY_NOTICE`, the "Not connected to the server yet" hint in the forms, and the PostMeal "dose suggestion" paragraph (replace as above).
* The per-screen `QuickAddFab` in `HomeScreen` (replaced by the global one).
* The 3-row quick-add menu (replaced by the two-choice step).
* Any place that treats a missing insulin entry as zero.

---------------------------------------------------------------------------------------------------

## 7. Tests (plain Node where possible, like `tests/events.test.mjs`)

1. `parseForecastResponse`: accepts a real sample; rejects a missing `points`, a non-5-minute step, `low > high`, an unknown `status`; `null` stays `null`.
2. `buildForecastChart`: extension split at +120; band polygon from every point; baseline hidden when equal; y domain contains all bounds; no point invented when `/forecast` is absent.
3. `eventsApi` payload builders: blank fat/protein/fibre are **omitted**; "none taken" sends `unitsAdministered: 0` + `confirmed`; unknown time-uncertainty is omitted; kind/type mapping; `clientId` regex.
4. Pending queue: same `id` twice -> one request body semantics; retry after network failure; persistence round-trip (storage mocked); a 409 duplicate does not loop.
5. IOB/COB formatting: `null` -> "unknown"/"none logged", `0` -> "0.0 U" only when `insulin === "confirmed_none"`.
6. `forecastPrompts`: each banner condition in section D, priority order, none when nothing applies.
7. Wording lint: a test that scans the new UI strings for forbidden words (`take`, `inject`, `dose needed`, `recommended`, `accurate`, `optimal`, `will be`).

Commands in `mobile/`: `npm run typecheck`, `npm run lint`, `npm run check:contrast` (add every new text/background pair to `scripts/check-contrast.mjs`), your Node test script, then look at it on Expo Web in **light and dark**.

## 8. UX/accessibility checklist (from `AGENTS.md`)

48 dp touch targets as real boxes (no `hitSlop`), `useColors()` only, sizes from `fontSize`, `accessibilityRole="header"` on titles, labels on icon-only controls, a text alternative on the chart,
state via `aria-*` not `accessibilityState`, primary action in the bottom thumb zone, reduced-motion respected for the sheet and chart transitions.

## 9. Do not

Do not call Gemini or the forecast service from the app. Do not compute forecasts, IOB, COB, coverage or any ratio maths. Do not hard-code a ratio. Do not pre-fill insulin from anything. Do not show ICR/ISF in forecast cards.
Do not treat null as zero. Do not call a pending event "saved". Do not edit `backend/`. Do not add a "dose" or "suggestion" feature.

## 10. Real end-to-end check (only after the user says the backend is deployed)

With the app on Expo Web: (1) `GET /forecast` renders; (2) set the ratio in Settings; (3) log 45 g carbs -> banner "no insulin recorded", line unchanged, range wider; (4) tap "Record insulin taken" with a small test number
-> the line moves, IOB chip shows a number, COB chip shows grams, marker appears; (5) edit carbs -> forecast changes, one entry only; (6) "I took none" on another meal -> line rises; (7) airplane mode -> entry
stays "not sent yet", comes back and sends once; (8) light and dark screenshots. Report real output, not claims.

## 11. Requests for the backend chat (do not build these on the device)

* (Done on the backend 2026-10-16: per-point IOB/COB, meal `label`, insulin cancel. Nothing else outstanding from this list.)
* The "clear recent meals" button (`POST /forecast/counterfactual`) is ready server-side; build the UI later as a what-if view (`mealAware.counterfactual` -> banner "What-if view - not a prediction").

## 12. Report format

Files changed/added, screens affected, the real output of `typecheck`, `lint`, `check:contrast` and your tests, light/dark screenshots, what you could not verify because the backend is not deployed, and anything in this prompt
that conflicted with the code or the safety rules.
