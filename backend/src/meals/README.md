# Meals module - POST /meals/analyze

Meal-photo carb/calorie/GI estimation via Gemini. Replaces the old client-side-Gemini architecture:
the API key and the vision call now live only in this backend (`GeminiMealVisionProvider`); the
mobile app sends a photo and gets back carbs/calories/GI/confidence, never touches the model or the
key. See `../../HANDOFF-BACKEND-AI.md` section 5 and `../../../CLAUDE.md` section 9 for the design
this implements.

## Request / response

`POST /meals/analyze` - JSON body (see `dto/analyze-meal-request.schema.ts`):

```jsonc
{ "images": [{ "base64Data": "<base64, no data: prefix>", "mimeType": "image/jpeg" }], "userNote": "optional" }
```

`images` is capped at one entry today (single-photo only, per the task this module was built from) but
is an array so a second, oblique-angle photo can be added later - see `../../CLAUDE.md` section 9,
"Guided two-photo capture" - without a breaking change to already-shipped clients.

Response is a discriminated union on `status` (`meal-analysis-response.ts`):

- `{ status: "ok", items: [...], totalNetCarbsG, totalCarbsRangeLowG, totalCarbsRangeHighG, totalCaloriesKcal, totalFatG, totalProteinG, totalFiberG, estimatedGlycemicIndex, glycemicIndexConfidence, analysisNotes, promptVersion, modelVersion }`
- `{ status: "no_food_detected", reason, promptVersion, modelVersion }`
- `{ status: "needs_manual_entry", reason, promptVersion, modelVersion }`

The two non-`"ok"` variants never carry `items` or any nutrition field - not even `null` or `0` - so a
failure can never be mistaken for a real (possibly low-carb) estimate.

## How a request flows

1. `MealsController` validates the body with `ZodValidationPipe` (`../common/zod-validation.pipe.ts`)
   against `analyzeMealRequestSchema` -> 400 on a malformed request.
2. `MealsService.analyzeMeal` runs up to `MAX_ANALYSIS_ATTEMPTS` (2) attempts, each: call the
   `MealVisionProvider`, then Gate 1 (`gates/gate1-structural.ts`, a Zod parse), then Gate 2
   (`gates/gate2-semantic.ts`, the five semantic sanity checks plus a couple of "no leaked numbers on
   a non-detected result" consistency checks). Any of the three failure kinds - provider/network,
   Gate 1, Gate 2 - is logged distinctly and retried with exponential backoff; after both attempts
   fail it returns `needs_manual_entry`, never a fabricated result.
3. A `"no_food"` or `"unidentified"` model output that *passes* both gates is not a failure and is not
   retried - it is a correct analysis that happens to have no usable estimate, mapped straight to
   `no_food_detected` / `needs_manual_entry` respectively.
4. `GeminiMealVisionProvider` (`providers/gemini-meal-vision.provider.ts`) is the only place that talks
   to `@google/genai`. `MealsService` depends on the `MealVisionProvider` interface only, so all of the
   above is unit-tested with `FakeMealVisionProvider` and never touches the network (see
   `meals.service.spec.ts`).

## Design decisions worth flagging

- **No verbatim prompt/schema text was provided.** The task that requested this endpoint referred to
  "the system prompt and JSON schema I've specified (given above)", but no such text appears earlier
  in that conversation. `prompt/meal-analysis-prompt.ts` and `schema/meal-analysis.schema.ts` were
  authored from scratch to satisfy every constraint that *was* stated explicitly (no silent bias, an
  honest range rather than a point estimate, glycaemic index nullable and never "high confidence",
  explicit no-food/unidentified states). If an exact wording exists elsewhere, swap it in and bump
  `PROMPT_VERSION`.
- **One Zod schema, not two.** `schema/meal-analysis.schema.ts` is parsed directly for Gate 1 *and*
  used to generate the JSON Schema sent to Gemini (`schema/to-gemini-json-schema.ts`, via Zod 4's
  `toJSONSchema`, as `responseJsonSchema`+`responseMimeType`). A hand-duplicated second schema is
  exactly the kind of drift CLAUDE.md section 4 warns about for `packages/sim`; this can't drift
  because there is only one definition.
- **`foodStatus` is a 3-way enum** (`detected` / `no_food` / `unidentified`), not a boolean, so the
  model has an explicit place to say "there is food but I can't identify it" distinct from "there is
  no food". `glycemicIndexConfidence` structurally excludes `"high"` from its enum - Gate 1 rejects it,
  not just the prompt discouraging it.
- **Media resolution and thinking level:** each image part is sent with
  `PartMediaResolutionLevel.MEDIA_RESOLUTION_HIGH` (portion-size accuracy per Gemini's own
  media-resolution docs), and `thinkingConfig.thinkingLevel` is raised to `ThinkingLevel.HIGH` -
  portion-size/absorption-profile estimation from one 2D photo is a genuinely reasoning-heavy visual
  task, not a fast lookup.
- **Model is pinned, not floating:** `gemini-3.8-flash` by default (override via `GEMINI_MODEL`), never
  an alias like `gemini-flash-latest` - CLAUDE.md invariant 4 needs `model_version` to mean the same
  thing forever, which a floating alias can't guarantee.
- **DB persistence is out of scope here.** HANDOFF-BACKEND-AI.md section 6 lists "database access
  layer" as an open decision the user must make (Prisma/Drizzle/TypeORM/raw `pg`) - this module
  doesn't guess at one. Every response (success or failure) carries `promptVersion`/`modelVersion` so
  that once persistence exists, storing "with every stored meal record, successful or not" is a
  straightforward write of already-available fields, not a redesign.
- **Images travel as base64 JSON**, not multipart/form-data - the mobile app already resizes to 1024px
  JPEG q80 before upload (CLAUDE.md section 9), so payloads are small, and `createPartFromBase64`
  consumes base64 directly. `main.ts` raises the JSON body limit to 15mb accordingly.

## Testing

- `*.spec.ts` next to each source file: Gate 1, Gate 2, the retry/backoff loop (via
  `FakeMealVisionProvider`), the controller (via a fake provider bound through Nest's testing module),
  and a dedicated security-boundary spec for `GeminiMealVisionProvider` proving a configured API key
  never appears in a thrown error message *or* a log line (mocks `@google/genai`, no network).
- `../../test/meals-analyze.fixtures.e2e-spec.ts`: runs the real endpoint against 5 real (openly
  licensed) food photos plus one non-food photo in `../../test/fixtures/meals/`, asserting a
  well-formed response within a wide, hand-checked carb ballpark. **Skipped automatically** unless
  `GEMINI_API_KEY` is set - this repo's dev environment does not have one configured, so this suite has
  not actually been run against the live API as part of building this module. Run it with:

  ```bash
  GEMINI_API_KEY=your-real-key npm run test:e2e
  ```

  **This is not an accuracy-measurement harness** - there is no ground truth here, only a human's
  ballpark guess at 5 stock photos. CLAUDE.md section 15, phase 3 ("carb uncertainty calibration")
  calls for a real harness: a kitchen scale, ~20 actually-weighed meals, real device photos (not stock
  images), and comparing the model's stated range against the true weighed value - that is a separate,
  valuable follow-up task, not done here.

## Access control (added 2026-10-16)

- Optional shared secret: when the server sets `APP_API_TOKEN`, requests must carry header `X-App-Token`
  (otherwise HTTP 401 `{ "status": "unauthorized" }`). Unset = open. A token in the public web bundle is
  not secret; this is bot protection, not user auth.
- Rate limit (Gemini quota): default 10 requests per client address and 30 in total per 10 minutes
  (`RATE_LIMIT_MEALS_PER_IP`, `RATE_LIMIT_MEALS_GLOBAL`). Exceeding it returns HTTP 429
  `{ "status": "rate_limited", "retryAfterSeconds": n }` plus `Retry-After`. The UI should show
  "try again in a minute" and offer manual entry.

## Forecast fields (added 2026-10-16, additive)

When the forecasting layer is available the response of `POST /meals/analyze` carries three extra fields on every variant:
`mealEventId` (the stored meal event, or null), `forecast` (the refreshed glucose forecast, or null) and `forecastNote`.
On `no_food_detected` / `needs_manual_entry` the forecast is the glucose-only one and the note says the meal is not included.
Optional request fields: `clientId` (a retry maps to the same meal event) and `eatenAt` (ISO time eating started; default: now).
The Gemini schema and prompt are unchanged (fat, protein, fibre, GI and the carbohydrate range were already returned).
Contract: `../forecasting/README.md`.

## Absorption features (prompt `meal-analysis-v2`, feature schema `meal-features-v2`, added 2026-10-18, additive)

The analysis also returns `absorptionClass` (`fast` / `moderate_fast` / `moderate_mixed` / `slow_delayed`), `absorptionConfidence`,
`preparationAndMixtureFactors` and a server-computed `glycemicLoadEstimate` (GI x net carbs / 100, only when GI is medium-confidence and the
carbohydrate range is tight). All are nullable: an older response, an unknown label or a missing key reads as "not provided" (Gate 1
`withAbsorptionDefaults`), and a no-food/unidentified result must carry none of them (Gate 2). They are stored on the meal (migration
`0008`) and feed the absorption model; see `docs/ABSORPTION-MODEL.md` for the equations, parameters, sources, deployment (shadow first)
and the measured results. GI is never a multiplier and is never inferred from a photo.
