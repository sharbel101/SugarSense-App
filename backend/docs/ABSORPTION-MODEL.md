# Glycemic-response-aware meal absorption ("absorption-v3", first written as v2)

Status 2026-10-18: implemented, tested on a scratch PostgreSQL, **not deployed** (needs migration `0008` and a push; see "Deployment").
Deployed behaviour stays the incumbent until `ABSORPTION_MODE=active`. Nothing here is clinically validated.

## 0. Update 2026-10-20: external check and what changed (v2 -> v3)

**Changed in v3 (candidate `meal-aware-0.3`, shadow only; the shown forecast is unchanged):** fibre slowing 0.01 -> 0.05 per gram (cap 15 g, so up to +75% on tau_fast). Nothing else. The version labels were bumped so the new shadow rows do not mix with the `meal-aware-0.2` ones already stored.

**Why only that.** The checks (scripts in `docs/absorption-checks/`, data not stored in the repo):

| Check | Data | Finding |
|---|---|---|
| Fibre, fat, protein, carbohydrate vs post-meal curve | CGMacros (PhysioNet, CC BY-NC-SA 4.0): 872 isolated meals, 37 people, **not type 1 diabetes, no insulin** | Per 10 g more fibre, within a person: peak ~5 min later (95% CI 1 to 12) and ~12 mg/dL lower (-22 to -8). Fat: peak time barely moves (+0.2 min per 10 g, CI -1 to +2.5); protein: slightly lower peak. Cross-validated by person, letting fibre slow appearance cut the 0-180 min curve error from 47.3 to 44.1 mg/dL at 0.05/g and to 39.6 fully free (v2's 0.01/g gave 46.5). The error falls steadily with a stronger effect; 0.05 is a deliberately conservative middle because fibre also stands in for food type. |
| Fat/protein vs published type 1 results | Smart 2013 (n=33 children, 30 g carbohydrate, same insulin): time to peak 79 / 96 / 126 / 143 min for low-fat-low-protein / high-protein / high-fat / both; excess glucose at 3 h +34 and +67 mg/dL for protein and both | **Not reproduced.** With insulin matched to the carbohydrate, every version of this engine (incumbent and v2/v3) puts the peak earlier and lower for fat/protein meals (90 -> 80 -> 75 -> 60 min), the opposite of the study, because delayed carbohydrate lets the insulin win early and the engine adds no glucose beyond the carbohydrate. Wolpert 2013 (n=7): time of maximum appearance 71 -> 102 min with 60 g fat; v2/v3 move it only with very high protein plus fat (40 -> 93 min at 40 g protein). |
| Calibrating an "extra late glucose" term (carbohydrate-equivalent g per g of fat/protein, off by default, knobs `equivalentPerFatG/ProteinG`, `stretchPerFatG/ProteinG`) | the Smart numbers above, engine at horizon 300 | The engine cannot reproduce a peak at 2-2.5 h with a late excess: there is no return-to-target term, so any extra that is large enough to match the 3-5 h excess keeps rising to the horizon edge. Not adopted. |
| Same extra term on the person's own stored forecasts | 9 meals, 297 pairs at 2-3 h | 0.1 g/g reduces late bias 14.5 -> 6.0 mg/dL (MAE 44.0 -> 42.9; 4 meals better, 2 worse, 3 unchanged); 0.2 g/g over-corrects (bias -2.5, 4 worse); the published-sized 0.35-0.5 g/g over-predicts badly (MAE 47-57). Too few meals to adopt anything; it points to a **per-person learned scale**, not a population constant. |
| Retrospective replay of all stored real forecasts | 24 distinct meals, 143-205 pairs per horizon | Incumbent -> v2 -> v3: MAE at 120 min 49.6 -> 45.4 -> 45.0, at 180 min 63.2 -> 43.1 -> 43.0; bias at 180 min +47.7 -> +17.8 -> +16.1; 80% interval coverage at 120 min 0.82 -> 0.94 -> 0.95. 15 min is slightly worse (12.0 -> 12.3 -> 12.4). v3 differs from v2 by under 0.5 mg/dL because only two stored meals have fibre recorded. Autocorrelated runs and few meals: a direction, not proof. |

**Correction.** An earlier message said a GI estimate with *high* confidence is ignored. The feature schema only allows `medium` or `low`, so that case cannot occur; no change was made.

**Not done / still open:** a type 1 model of fat/protein that reproduces a later peak (needs a return-to-target term and per-person scaling); validating the fibre value on type 1 data; GI effect size (no source found).


## 1. What the running system actually does (traced, not assumed)

```
photo -> POST /meals/analyze -> Gemini (versioned prompt + JSON schema from the Zod schema) -> Gate 1 (Zod) -> Gate 2 (semantic)
      -> meal_events row (draft; analysis_raw keeps the model's answer verbatim) -> user confirms (PATCH status confirmed)
      -> ForecastService.run(): frozen glucose-only GRU "direct_120" baseline (served by the VM forecast service, 0-120 min)
         + event layer (src/engine): meals and insulin as increments  adjusted(h) = baseline(h) + m_csf*CSF*C*dF - m_isf*ISF*U*dA
      -> forecast_runs / predictions (inputs, model_version, outcomes scored later) -> bounded recursive scale learning
```

The technical reference (PDF) describes Mode A as "physiological simulator + learned residual (boosted trees)". **That is not what runs.**
Production is the frozen GRU plus the event layer with two bounded personal scales (m_csf, m_isf). There is no residual model whose
feature vector could be extended, so the new meal features enter the **event layer**, and are stored with every run so a residual
model or Mode B can use them later without re-deriving anything.

| Reference (PDF) | Running implementation | Consequence here |
|---|---|---|
| Ra(t; D, t_max) = D*A_G/t_max^2 * t * exp(-t/t_max), A_G = 0.8 | gamma(2) cumulative F(s; tau) = 1-(1+s/tau)e^(-s/tau), rate peaks at tau; normalised to integrate to 1; CSF = ISF/ICR carries the scale (project forecasting spec: ICR enters only there) | Same shape with t_max = tau. A_G is **not** a separate factor (it would double-count with ICR). Total carbohydrate mass is conserved by construction: F_total(inf) = 1 for every profile. |
| two-component mixture (1-phi)Ra(t;D,t_fast) + phi Ra(t-delta;D,t_slow) | not implemented (project spec instead has an optional additive delayed amplitude, default 0) | Implemented as specified, mass-conserving; the additive amplitude is never applied on top of it. |
| horizon 4 h | 3 h (36 steps) | Unchanged. The delayed part keeps absorbing beyond 3 h; the profile curve is tested to 300+ min. |
| learned residual, per-user shrinkage | GRU baseline + two shrunk scales | New parameters are fixed bounded population defaults, not fitted. |

## 2. Feature schema "meal-features-v2" and prompt "meal-analysis-v2"

Existing fields kept (names unchanged): `items`, `totalNetCarbsG` (+ range), `totalFatG`, `totalProteinG`, `totalFiberG`,
`estimatedGlycemicIndex`, `glycemicIndexConfidence` (never "high"), `analysisNotes`. **Added** (all nullable; null = not provided):

| Field | Meaning |
|---|---|
| `absorptionClass` | `fast` / `moderate_fast` / `moderate_mixed` / `slow_delayed`: the LIKELY shape of carbohydrate appearance for the whole meal. `moderate_mixed` is the stated default when evidence is thin. Not chosen from a name or one GI number. |
| `absorptionConfidence` | `high` / `medium` / `low`; a class with no valid confidence is read as `low`. |
| `preparationAndMixtureFactors` | `{form: liquid/solid/mixed/unknown, carbohydrateQuality: refined_or_simple/minimally_processed/mixed/unknown, preparation: fried/baked_or_roasted/boiled_or_steamed/raw/packaged_or_processed/unknown, mixedMeal: bool/null}` |
| `glycemicLoadEstimate` (response only) | **computed server-side**: GI x net carbohydrate / 100, only when GI confidence is `medium` and the carbohydrate range is <= 60% of the estimate; else null. Never asked of the model. |
| `featureSchemaVersion` | `meal-features-v2`, stored on the meal. |

GI policy: not inferable from a photo (see sources); the model may return a GI only with a real basis and never "high"
confidence; GI is never a multiplier of carbohydrate grams or of predicted glucose.

Backward compatibility (Gate 1, `withAbsorptionDefaults`): a response without the new keys, or with an unknown label, is read as
"not provided" instead of discarding the carbohydrate estimate; carbohydrate/macronutrient numbers stay strict. A model that fills
the features for `no_food`/`unidentified` is rejected by Gate 2 (never a fabricated profile). Storage (`0008`): `absorption_class_ai`,
`absorption_confidence`, `glycemic_load`, `meal_factors`, `feature_schema_version`, `absorption_class_user`; the person's own
`absorption_class` (fast/medium/slow) is never overwritten, and `analysis_raw` keeps the original response.

## 3. How the features choose the absorption profile (`src/engine/absorption.ts`)

`F_total(s) = (1 - phi) * F(s; tau_fast) + phi * F(s - delta; tau_slow)`, `F(x <= 0) = 0` so the delayed part is exactly zero before `delta`.

Resolution order (pure function, same inputs -> same profile; missing/invalid values fall back to the default profile):

1. A speed class the **person** chose (`absorption_class_user`) is authoritative: the previous single-component behaviour (tau = 40 x {0.5, 1, 1.5}), phi = 0. (A delayed part on top would count the same slowness twice.)
2. Else the class from the vision model (with its confidence); else GI >= 70 **and** confidence `medium` nudges an unclassified meal to `moderate_fast`; else `moderate_mixed`. Low GI never slows a meal; GI never overrides a class.
3. Fat and protein add a delayed fraction continuously (hinge, not a switch); fibre slows the early component slightly.

| Parameter | Value | Unit | Bounds | Tier / basis |
|---|---|---|---|---|
| tau_fast = tauM x ratio | fast 0.625 (25), moderate_fast 0.8125 (32.5), mixed 1 (40), slow_delayed 1 (40) | min | 12..120 | Reference table: fast 20-30, mixed 40-50 (engine default 40 kept so golden vectors G0/G1 hold). Ratios are engineering interpolation (E). |
| tau_slow | 90 | min | fixed | Reference 60-90 for high-fat/protein; project spec's delayed kernel also 90. |
| phi | clamp(0.010*max(0,fat-15) + 0.008*max(0,protein-20), 0, 0.6); slow_delayed floor 0.30 (x0.5 if confidence low) | fraction | 0..0.6 | Cap from the reference; slopes/onsets **engineering defaults (E)**: the evidence gives direction and timing, not a transferable formula. |
| delta | clamp(max(1.0*fat, class floor 45 (x0.5 if low conf), 30), 30, 90) when phi > 0 | min | 30..90 | Reference: delta = beta*fat capped at 90, beta = 1 min/g (E). |
| fibre | tau_fast x (1 + 0.01*min(fibre, 15 g)) | - | <= +15% | Weak evidence, small and capped (E). |
| uncertaintyWeight | class high/medium/low 0.15/0.30/0.50; GI 0.50; macros 0.30 | share | 0..1 | A shifted profile on limited evidence adds `weight x |shift|` to the timing variance: **the band widens, the line does not move because of it.** Unknown/default profile adds nothing. |

None of these is fitted per user; they are fixed, bounded, validated (`assertValidProfile`) and stored in each run's inputs so future
calibration has the data. The calculator for insulin (`bolus`) never sees any of this; no forecast value is an input to a dose.

Resulting share of carbohydrate absorbed (computed from the code):

| Profile | tau_fast / phi / delta | +30 | +60 | +120 | +180 | +300 min |
|---|---|---|---|---|---|---|
| sugary drink (fast, high) | 25 / 0 / 0 | 0.34 | 0.69 | 0.95 | 0.99 | 1.00 |
| rice-type (moderate_fast) | 32.8 / 0 / 0 | 0.23 | 0.55 | 0.88 | 0.97 | 1.00 |
| standard mixed (default) | 40 / 0 / 0 | 0.17 | 0.44 | 0.80 | 0.94 | 1.00 |
| pizza-like (slow_delayed, F30/P25) | 40 / 0.30 / 45 | 0.12 | 0.31 | 0.62 | 0.79 | 0.93 |
| high fat+protein (F50/P40) | 40 / 0.51 / 50 | 0.08 | 0.22 | 0.49 | 0.68 | 0.88 |
| uncertain GI, nothing else | = default | 0.17 | 0.44 | 0.80 | 0.94 | 1.00 |

## 4. Deployment: shadow first

`ABSORPTION_MODE` = `shadow` (default) | `active` | `off`, read on every forecast.

* **shadow**: the incumbent profile (`meal-aware-0.1`) draws the forecast. When some counted meal's profile differs from the default, the candidate (`meal-aware-0.2`) is computed on the same inputs and stored as a shadow run (`model_version` `meal-aware-0.2-shadow+direct_120`, only meal-aware prediction rows, each carrying `shadowOf` = the inputs hash of the prediction it shadows). Shadow rows are never shown, never learned from, never counted in evidence or performance.
* **active**: the candidate draws the forecast (`meal-aware-0.2`); the incumbent becomes the shadow. Instant rollback: set `shadow`.
* `GET /forecast/evaluation` -> `absorptionModel {mode, rows[], note}`: per horizon, n, MAE/RMSE and 80%-interval coverage of the shown vs the shadow model on the same anchors, scored against real glucose. **Promotion rule (decided in advance):** only after a sustained advantage on at least ~30 scored meals (not predictions: they are autocorrelated), with interval coverage not worse and no worse error in the hypoglycaemia range; until then it stays shadow.

## 5. Research used, and what each supports

Verification status is stated honestly: these were checked through search results and secondary summaries in this session; I did not read the full papers.

| Source | Supports | Does not support |
|---|---|---|
| SugarSense Technical Reference, sections 5.6, 6.3.1 (primary spec) | Ra shape, two-component mixture, phi/delta forms, caps, "ignores GI within a class", fat/protein tail 3-5 h | numeric values of alpha_f, alpha_p, beta (not given) |
| Wolpert HA et al., Diabetes Care 2013;36(4):810-816, doi 10.2337/dc12-0092 | crossover of a 60 g vs 10 g fat dinner with equal carbohydrate/protein in 7 people with T1D: more insulin needed and more later hyperglycaemia after the high-fat meal | a size or timing formula; tiny n |
| Bell KJ et al., Diabetes Care 2015;38(6):1008-1015, doi 10.2337/dc15-0100 (systematic review: 7 studies each for fat, protein, GI) | fat, protein and GI all modify postprandial glucose; fat can delay the early response (two studies saw lower early AUC) | a transferable parameter set |
| Pankowska/Warsaw fat-protein-unit method (FPU = (fat x 9 + protein x 4)/100; extended-bolus duration chart 3, 4, 5, >=8 h for 1, 2, 3, >=4 FPU), via secondary descriptions | order of magnitude of how long fat/protein effects last (hours, growing with load) | any glucose-curve parameter; it is an **insulin-dosing heuristic** with documented hypoglycaemia concerns and is **not used** to dose anything here |
| Matthan NR et al., Am J Clin Nutr 2016, GI reliability (63 healthy adults, repeated white-bread tests; secondary reports give about 20% within and 25% between people, wording differs between reports) | GI of the same food varies a lot; therefore not a precise per-meal input, and certainly not inferable from a photo (my inference: no study found testing photo-based GI) | - |
| Dalla Man C et al. 2006/2007 (oral glucose absorption / meal model), via secondary descriptions | gastric emptying is nonlinear and meal-composition dependent; gut-compartment structure | the engine does not implement Dalla Man; it uses the project's gamma(2) kernel |
| Project forecasting spec (`docs/research/glucose-forecasting-engine-spec.md`): Smart 2013, Paterson, Zeevi 2015, Bell 2015 as cited there | direction/timing of fat-protein effects; GI-as-multiplier is a triple count | not re-verified here |

Every numeric default above that is not in the reference is an **engineering assumption (E)**, labelled as such; the evidence supports
the direction (fat/protein delay and extend, fast carbohydrate peaks earlier, GI is noisy), not the magnitudes.

## 6. Tests and measured results (2026-10-18)

* 315 vitest tests pass on the VM against the scratch database (1 skipped placeholder); typecheck and lint clean; `db/tests/verify.sql` 63 checks pass on the migrated scratch database.
* Physics (`src/engine/absorption.spec.ts`): every profile finite, non-negative, monotone, normalised (integral of the rate = 1 to 1e-3, F(inf) = 1 to 1e-9); delayed part exactly zero before delta; more phi or longer delta shifts mass later with no extra mass; deterministic; default profile equals the old kernel bit for bit; insulin kernels/IOB golden vectors unchanged; > 1000 valid input combinations give in-bounds profiles and no NaN.
* Controlled scenarios (same 60 g, same start, same "took none" record): early absorption sugary > mixed > high-fat/protein at 15/30/60/90 min; at +120/+150/+180 min carbohydrate on board high-fat > mixed > sugary and the +2 h to +3 h rise high-fat > mixed > sugary (delayed absorption does not vanish after the early window); the uncertain-GI meal equals the default exactly. No test asserts a peak ordering between meals (insulin, start glucose and physiology also matter).
* End to end on PostgreSQL: mocked Gemini response -> gates -> stored features -> confirmation -> forecast -> stored run with features and resolved profile -> replay of the stored inputs reproduces the stored forecast; shadow and active modes; older/manual meals identical in both modes with no shadow rows; person-chosen class outranks the model.
* Mutation check: each rule (profile used, label sanitising, shadow exclusion, delay boundary, user-class priority, mass conservation, feature storage) was switched off in turn on the VM copy and the new tests failed.

**Constructed world (tests only):** with truth generated by the delayed profile, the shadow forecast's 120-min MAE is lower than the incumbent's. This verifies the plumbing and arithmetic, not accuracy.

**Retrospective replay on the real stored forecasts (read-only, 2026-10-18; macronutrient part only, because no stored run has an absorption class, fibre or GI confidence):**
474 scored predictions in 98 runs, but only **10 distinct meals**, heavily autocorrelated (a run is stored for every new glucose reading); some of the meals were later cancelled or were unconfirmed drafts counted before that rule existed, and the incumbent replay reproduces the stored prediction in only 227/474 cases (the engine changed since those runs were stored), so this compares the two profiles inside the *current* engine, not the forecasts that were shown.

| Horizon (min) | n | MAE incumbent -> new profile (mg/dL) | RMSE | 80% interval coverage |
|---|---|---|---|---|
| 15 | 96 | 15.7 -> 15.0 | 19.5 -> 18.4 | 0.86 -> 0.82 |
| 30 | 85 | 29.8 -> 26.3 | 37.6 -> 33.0 | 0.74 -> 0.73 |
| 60 | 78 | 49.8 -> 43.2 | 62.1 -> 53.6 | 0.68 -> 0.76 |
| 120 | 71 | 52.2 -> 45.4 | 68.6 -> 55.5 | 0.80 -> 0.94 |
| 180 | 58 | 60.0 -> 38.3 | 72.0 -> 45.7 | 0.93 -> 0.98 |

All replayed meals fall in the high-fat/protein stratum, so fast / mixed / high-fat comparisons are **not possible**. With 10 meals this is a direction, **not evidence of improvement**; it is the reason the deployment mode is shadow.

## 7. Limitations and open decisions

* No labelled dataset with absorption classes exists yet; the class, GI and preparation fields have never been scored against outcomes. Shadow mode collects exactly that.
* phi/delta slopes, onsets, the fibre effect and the class ratios are engineering defaults; they can only be calibrated with many fat/protein meals with scored outcomes (the project spec asks for >= 10 per user before any per-user fit). Nothing is fitted per user here.
* The vision model's class is itself an estimate from one 2-D photo; the person can override with a speed class (which outranks it).
* The old speed class (fast/medium/slow) and the new class coexist; a person's explicit `medium` is indistinguishable from the default for meals created before `0008` (they are backfilled as "user" only when not `medium`).
* Learning/evidence after promotion mixes `meal-aware-0.1` and `meal-aware-0.2` rows (both are "meal-aware-%", shadow excluded); revisit if the scales drift.
* The reference's 4 h horizon and learned residual model are not implemented; unchanged by this work.

## 8. Deployment steps (not yet done)

1. Backup, then `DB_ENV_FILE=~/sugarsense-db.env node db/migrate.mjs` (adds columns only; backfills `absorption_class_user`).
2. Push `main` (the deploy timer builds and restarts). Default mode is shadow: forecasts shown do not change.
3. Later, after `GET /forecast/evaluation` shows an adequate sample: `ABSORPTION_MODE=active` in the backend environment and restart; revert to `shadow` to roll back.
