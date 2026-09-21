# SugarSense - CLAUDE.md

Guidance for Claude Code (and humans) working in this repo. This file is a distillation of
**SugarSense-Technical-Reference.pdf** (author: Charbel Zaarour, USEK). Section numbers like
"PDF Sec 6.3" refer to that document, which is the source of truth. If this file and the PDF
disagree, the PDF wins - then fix this file.

## 0. Status - read first

- **Greenfield.** The reference is a *design document: intended behaviour, not implemented
  behaviour.* Do not describe anything here as working until it exists and its tests pass.
- Lives on the `sugarsense_app` branch of `sharbel101/GlucoGuard`. That branch was created as an
  orphan: **no shared history or code with `main` / `glucowatch` (the Garmin watch apps).** Never
  merge it into them, never import from them.
- Working agreement: **run the tests and show real PASS/FAIL output before saying code works.**
  Report failures and skipped steps plainly. If an acceptance threshold (PDF Sec 11.3) is not met,
  say it was not met.
- The development environment exists, plus a UI **prototype** in `mobile/` (ported from the standalone
  `test-APP/` folder) running on mock data (`mobile/src/data/mockData.ts`). It is NOT connected to the backend
  and violates several rules in this file (no `edited` flags, bolus arithmetic hidden behind a toggle, no
  uncertainty/low-confidence states, "LOW RISK" reassurance copy, hard-coded strings) - treat it as a visual
  reference to be rebuilt against real data and the copy rules in section 2, not as compliant code. Real
  commands are in section 15 below; when you add tooling, record the real commands there - do not
  invent them.

## 1. What SugarSense is

A Type 1 diabetes **decision-support** app: mobile app + backend + modelling layer. It turns three
imperfect inputs into one calibrated, uncertainty-aware glucose forecast and an auditable insulin
suggestion.

Inputs: (1) meal photo -> carbs via a vision-language model under a structured output contract;
(2) wearable physiology (HR, HRV, movement, skin temp, sleep) from an off-the-shelf open-source
BLE band; (3) user therapy parameters + logged events (ICR, ISF, insulin taken, glucose readings).

Outputs: editable carb breakdown with stated uncertainty; 4-hour glucose trajectory as a
*distribution*; bolus suggestion with every arithmetic term shown, hard-capped, confirm-required;
hypoglycaemia risk signal; stream of explained anomaly findings from a background agent.

### The six things most often misunderstood

1. It does **not** measure glucose from the wearable, and no part of the design claims to.
2. The ML predicts the **simulator's error**, not glucose itself (one user = ~1,400 labelled meals/yr).
3. The uncertainty band is a **primary output**, not a visualisation choice.
4. Hypoglycaemia detection and glucose forecasting are **two models** with different data needs
   and maturity.
5. Mode A / Mode B are not "basic / advanced" - different architectures for different data regimes.
   Mode A must work for everyone on day one.
6. The anomaly agent is **not** the hypoglycaemia alerting system: different cadence, purpose,
   alarm budget, and they must not share a notification channel.

### Explicitly NOT

Not a medical device, no regulatory status. Never doses insulin (no automated delivery, ever).
Not a CGM replacement. Evaluation is n=1 to n=small, not a clinical trial. The moment anyone other
than the developer uses it with their own therapy, ethics review + informed consent are required.

## 2. Safety rules - hard constraints, never trade away

- **Suggestion is not a dose.** `units_suggested` and `units_administered` are separate columns;
  neither is derived from the other. The user enters what they actually took.
- **Never store or show a fabricated number.** Vision failure -> manual entry. Insulin history
  incomplete -> IOB shown as *unknown*, never silently 0. Stale glucose anchor beyond threshold ->
  forecast withheld, not extrapolated.
- **Fail loudly, in a safe direction.** Missing wearable coverage -> shrink residual toward
  population value and widen interval (do not impute silently). Low model confidence -> show a
  range with no median line. Mode B -> A fallback must be announced in the UI.
- **Uncertainty is always visible** at the moment of decision. No implied precision.
- **Show all bolus arithmetic** (PDF Sec 12.2; section 10 below). Surface low carb confidence next to the number.
- **Bounded, proposed-never-applied personalisation.** Fitted parameter changes are surfaced as
  observations and used in the *forecast*; the bolus calculator keeps clinician-supplied
  ICR/ISF until a human changes them. This is what separates decision support from a closed loop.
- **No forecast or model output is an input to the bolus dose.**
- **Alarm budgets are a safety feature.** Alerting more than ~1 false alarm/day (hypo) or ~2
  interruptions/day (agent) gets the feature switched off, and then it protects nobody.
- **Agent never acts.** It does not change parameters, doses, models, or silence other alerts.

### UI language (PDF Sec 14.3, 9.7)

| Use | Never use |
|---|---|
| "Estimated carbohydrates" | "Accurate carb count" |
| "Suggested dose - check before using" | "Take 7 units" |
| "Predicted range" | "Your glucose will be 140" |
| "Based on the settings you entered" | "Optimal dose" |
| "Not medical advice" | "Clinically validated", "medical grade" |

Findings are **observations, never instructions or diagnoses** ("resting HR has been ~12 bpm above
your usual for three days...", not "you are ill, raise your basal"). Any finding touching therapy
ends by pointing at a clinician.

## 3. Data invariants - write these tests first (PDF Sec 3.2)

1. **One glucose unit:** store mg/dL only; convert at the presentation boundary only.
2. **Timestamps are UTC** with the offset recorded separately (time-of-day is a model feature).
3. **Suggestion != dose** (separate columns, neither derived from the other).
4. **Every derived value is reproducible:** a `prediction` stores its full `input_snapshot` and
   `model_version`. If it cannot be re-derived in six months it cannot be used for evaluation.
5. **Missingness is data:** absent sensor coverage is `coverage = 0`, never a zero value or an
   interpolated one.
6. **No AI-produced number without an edit path and an `edited` flag.**

### Entities (12) - shared types live in `packages/schemas`

`profile`, `therapy_settings` (icr, isf, target_low/high, insulin_type, insulin_peak_min,
insulin_duration_min, max_bolus, basal_schedule - clinician-supplied priors, never silently
overwritten), `meal` (client_uuid, eaten_at, carbs_g, **carbs_sigma**, fat_g, protein_g, fibre_g,
source, ai_confidence, model_version, prompt_version, user_edited), `meal_item`, `glucose_reading`
(value_mgdl, measured_at, source in {manual, health_connect, healthkit, cgm, lab}, external_id,
trend), `insulin_event` (units_administered, units_suggested, suggestion_accepted, kind,
administered_at, meal_id), `prediction` (horizon_min, input_snapshot, quantiles, model_version,
scored_error), `sensor_sample`, `sensor_aggregate` (bucket, mean/min/max/n, **coverage**),
`daily_context` (sleep_minutes, sleep_efficiency, resting_hr, hrv_rmssd, activity_minutes,
skin_temp_delta), `care_relationship` (explicit consent, revocable), `audit_log` (append-only).

## 4. Repo layout (PDF Sec 13)

Created (environment skeleton only, no features):

```
mobile/    React Native + Expo (TypeScript), development build. All screens, BLE, on-device inference.
backend/   NestJS (TypeScript, ESM). Vision-model credentials, persistence (Postgres/Supabase),
           clinician access, training jobs.
ml/        Python 3.12 venv. Dataset prep, Mode A residual training, Mode B pretrain/fine-tune, eval.
           Exports quantised artefacts the phone can load.
```

Planned from the PDF but **not created yet** (PDF Sec 13 names them under `apps/` and `packages/`):
`sim` (simulator), `schemas` (Zod types for section 3 entities), `agent` (anomaly detectors), and the
read-only clinician web view. Because `mobile/` and `backend/` are independent npm projects, how shared
TypeScript is consumed by both (Metro symlink rules vs Nest ESM) is an open decision - settle it when
the first shared package is needed, not before.

- **`packages/sim` is the most important structural decision.** If the equations exist in both
  Python (training) and TypeScript (inference) they will diverge and the residual model will learn
  to correct a simulator that isn't the one on the phone. Either generate one from the other, or
  keep both and run a **fixture test on every commit asserting identical trajectories.**
- `packages/agent` and `packages/sim` stay framework-free so they can be replayed in test harnesses.
- **The phone must produce a forecast with no network.** Only meal-image analysis and model
  training need the server. Simulator, Monte Carlo, residual inference, hypo classifier, anomaly
  agent all run on-device.
- Vision-model credentials live only in `backend/`. Never ship them in the app.

| Component | Runs on | Why |
|---|---|---|
| Simulator, Monte Carlo, residual inference, hypo classifier, anomaly agent | Phone | Offline; small arithmetic |
| Residual/Mode B training (population), vision call | Backend | Credential custody, compute |
| Per-user fine-tuning | On-device while charging preferred; backend nightly acceptable | Keeps glucose series on the phone |

## 5. Two operating modes (PDF Sec 7)

Selected automatically by data availability. The user never chooses.

| | Mode A - no CGM (default) | Mode B - CGM |
|---|---|---|
| Glucose obs | 0-8/day, irregular | 288/day, regular |
| Engine | Simulator + learned residual | Dilated causal TCN over multivariate series |
| ML role | Corrects a physics model | Predicts trajectory directly |
| Planning RMSE 30 / 60 min | 25-40 / 35-55 mg/dL | 12-20 / 20-30 mg/dL |
| Useful horizon | 2-4 h, wide intervals | 30 min-2 h, tight intervals |

Both share: data model, meal subsystem, simulator, uncertainty contract (quantiles + Monte Carlo
carb propagation), bolus calculator, hypo model, anomaly agent. A CGM is just another `source` on
`glucose_reading`. The accuracy figures are planning targets from the literature, not results.

**Transitions:** A->B only after 14 days of CGM history (Mode B runs in *shadow* until then, user
still sees Mode A). B->A on CGM loss is immediate and announced (interval visibly widens with a
line of text). Gap <30 min: sequence model imputes with an explicit mask channel. Gap >30 min:
fall back to Mode A anchored at the last valid reading.

## 6. Physiological simulator - `packages/sim` (PDF Sec 6.3)

Deterministic, no learning. Parameters are clinician-supplied or fitted under tight bounds.
Step dt = 5 min. Horizons H = {30, 60, 120, 180, 240} min.

```
CSF = ISF / ICR                                  [mg/dL per g]
Ra(t; D, tmax) = (D * A_G / tmax^2) * t * exp(-t / tmax)   A_G = 0.8 ;  integral(Ra) = D * A_G
  tmax: fast/liquid/simple 20-30 min | mixed (default) 40-50 | high fat/protein 60-90 (+ 2nd comp.)
High fat/protein two-component mix:
  Ra_total(t) = (1 - alpha) * Ra(t; D, t_fast) + alpha * Ra(t - delta; D, t_slow)
  alpha = clamp(a_f*fat_g + a_p*protein_g, 0, 0.6) ;  delta = beta*fat_g, capped at 90 min
Insulin (exponential model, peak tp, duration DIA; typical tp 55-75, DIA 300-360 min):
  tau = tp * (1 - tp/DIA) / (1 - 2*tp/DIA) ;  a = 2*tau/DIA
  S   = 1 / (1 - a + (1 + a) * exp(-DIA / tau))
  IA(t)  = (S / tau^2) * t * (1 - t/DIA) * exp(-t/tau)             for 0 <= t <= DIA
  IOB(t) = 1 - S*(1-a) * [ (t^2/(tau*DIA*(1-a)) - t/tau - 1) * exp(-t/tau) + 1 ]
Dynamics:
  dG/dt = CSF*Ra(t) - ISF * sum_i D_i*IA(t - t_i) + b(t) + eps(t)
  G[k+1] = G[k] + dt * (CSF*Ra[k] - ISF*IA_total[k] + b[k])
```

`b(t)` = per-user diurnal drift (hepatic output net of basal, dawn phenomenon), initialised flat at
zero. The simulator is known to be wrong about: constant ISF/ICR, exercise/sleep/illness/stress,
glycaemic index, gastric-emptying variation, alcohol, injection-site variance. Those structured
errors are exactly what the residual model targets. Meals are considered for 480 min after eating.

**IOB is the anti-stacking term** - the most common cause of severe hypo from manual dosing. It is
subtracted in every bolus calc.

## 7. Mode A learned residual (PDF Sec 6.4-6.6)

- Target: `r_h(t0) = G_obs(t0+h) - G_sim(t0+h)`. Forecast = `G_sim + r_h(x(t0))`. A model predicting
  zero is already as good as the simulator alone (floor); shrinking toward zero degrades gracefully.
- Output = conditional quantiles q in {0.1, 0.25, 0.5, 0.75, 0.9} per horizon, **pinball loss**,
  one model per (horizon, quantile) = 25 small models. **Sort quantiles at each horizon** after
  prediction (no crossing).
- Features (at anchor t0): glucose state (last G, minutes since, trend, TIR 24h); meal (carbs_g,
  carbs_sigma, fat, protein, fibre, class, signed prebolus lag); insulin (dose, IOB, boluses in
  4h, minutes since last, basal in effect); therapy (ICR, ISF, DIA, tp, targets); time (sin/cos
  hour, weekday/weekend, minutes since waking); wearable acute/delayed/recovery/illness proxy;
  **coverage_\* and imputed flags**; and **the user's own rolling residual mean/SD (14 d and same
  3-h clock window)** - typically the strongest single feature.
- **Model class by data volume - stop at gradient-boosted trees for the foreseeable horizon:**
  0 events: simulator only, wide intervals | 30-200: ridge/elastic-net on a reduced set |
  200-2,000: LightGBM quantile objective | >50k glucose samples (CGM): TCN/GRU (Mode B).
  Boosted trees are small, fast, and inspectable - important for a health app.

### Uncertainty by Monte Carlo (PDF Sec 6.5) - the distinctive element

Three independent sources: carb estimate (log-normal), parameter uncertainty (ISF/ICR/tmax normal
around clinician values, narrowing with fitting), residual-model quantile spread.

```
for n in 1..200:
    D_n ~ LogNormal(D_hat, sigma_ln); ISF_n, ICR_n, tmax_n ~ Normal(...)
    traj_n = simulate(G(t0), D_n, insulin_events, ISF_n, ICR_n, tmax_n) + residual_median(x(t0))
pool -> empirical 10/25/50/75/90th percentile per horizon
widen by residual model's own spread in quadrature (s = sqrt(s_sim^2 + s_res^2); interval width
/ 2.563 -> sigma; q = centre +/- 1.2816*s for 10/90); then enforce monotone quantiles.
```

Quadrature assumes independence and errs slightly narrow: if calibration (PICP) shows
under-coverage, replace with a direct empirical combination over the MC samples.
A plate the vision model was unsure about MUST produce a visibly wider band.

### Personalisation and cold start

- **Shrinkage everywhere:** `theta = n/(n+k) * theta_user + k/(n+k) * theta_pop`, k ~ 30. Never
  deploy an unshrunk per-user fit.
- **Bounded weekly refit** of simulator scale params: multipliers `m_ISF, m_ICR` in **[0.7, 1.3]**
  (hard), regularised toward 1, **proposed never applied** (section 2 above).
- Cold-start stages: **0** install - simulator only, clinician params, deliberately wide (~+/-40%
  at 2 h), "illustrative" | **1** 30 meals - per-user residual intercept per time-of-day block |
  **2** 100 meals + 200 scored predictions - full shrunk residual model, wearable features enter |
  **3** 300+ meals - bounded parameter fitting | **4** CGM connected - autoregressive features.

## 8. Mode B - CGM sequence model (PDF Sec 7.5)

- Input: 72 timesteps (6 h causal lookback, > insulin duration) x ~35 channels on a 5-min grid:
  glucose + diffs + `is_observed` mask + minutes-since-reading; **simulator channels** Ra, COB, IA,
  IOB, and the Mode A trajectory `G_sim(t)`; raw meal/insulin events; therapy (static); wearable
  aggregates + coverage; calendar.
- Architecture: dilated **causal** TCN - 1x1 conv to 64 ch, 6 residual blocks, dilations
  1,2,4,8,16,32, kernel 3, GELU, dropout; last-timestep repr + static therapy vector -> MLP head
  emitting 5 horizons x 5 quantiles = 25 outputs **jointly**. ~200-400k params; int8 < 1 MB.
  Causal by construction (leakage structurally impossible), parallel training, on-device.
- **Direct multi-horizon output, not recursive rollout** (recursive compounds error). Apply a
  monotonic + smoothness pass at output time.
- **Baseline first:** LightGBM on lag features must be beaten; if not, ship it instead. GRU is the
  second alternative; TFT is phase 9, not first build. **Rejected:** large pretrained time-series
  foundation models.
- Loss: multi-quantile pinball weighted by clinical risk, `w = 1 + lambda * f(y)^2`,
  `f(G) = 1.509 * ((ln G)^1.084 - 5.381)` (G in mg/dL); hypo samples ~3-5x in-range weight. Tune
  lambda against **error-grid outcome, not RMSE**. Optional physiological-consistency penalty.
- Training: (1) population pre-train on multi-subject CGM corpora, leave-one-subject-out;
  (2) per-user fine-tune - **freeze the encoder, retrain head + per-user normalisation**, low LR,
  min 14 days (ideally 8 wks); (3) shrink head toward population (k ~ 30, n = training days);
  (4) weekly head refit on rolling window, **promote only if it beats the incumbent** on PDF Sec 11
  metrics on a held-out recent period. Channel mismatch: train with wearable channels present but
  masked to zero + availability flag (or a separate physiology branch).
- **Mode A is Mode B's safety envelope:** if |neural - sim| > threshold (start ~50 mg/dL at 30 min,
  scaling with horizon; tighten as agreement accumulates) and sim inputs are complete, widen the
  interval to span both, log a divergence event for the agent; if extreme, report the simulator
  and mark the neural model unreliable for that window. When they disagree, say "we don't know".
- Deployment: ONNX Runtime Mobile / TFLite / ExecuTorch, int8, fully offline.

## 9. Meal understanding (PDF Sec 5)

```
capture -> local resize (1024 px, JPEG q80) -> upload to backend -> vision model call
  fixed, versioned system prompt in code | responseSchema enforces JSON | low temperature
  two views when available (top-down + ~45 deg oblique) | optional scale ref (bank card 85.6x54 mm)
  optional user text appended
GATE 1: schema parse (Zod) - structure guaranteed or rejected
GATE 2: semantic sanity - every item has portion+carbs; sum(item carbs) within 5% of declared
        total; 0 < total <= 400 g; no placeholder/empty names; portion_g physically plausible
on failure: retry w/ exponential backoff, max 2 attempts; then partial result + MANUAL ENTRY
present per-item, fully editable -> user confirms -> record `edited` flag and the delta
```

Output contract: `{ items[{name, portion_description, portion_g, carbs_g, confidence}],
total_carbs_g, total_carbs_sigma, fat_g, protein_g, fibre_g, confidence: high|medium|low,
model_version, prompt_version }`. **`total_carbs_sigma` is the point of the subsystem.**

- Both views / scale reference are *optional* (a flow that demands two photos gets abandoned in a
  restaurant) but their presence/absence is recorded and widens/narrows sigma. Dominant error is
  portion *volume*, not food identification.
- Sigma = model confidence -> base CV; **view disagreement** (query views separately; most
  informative); learned calibration from user corrections (population defaults, deliberately wide,
  until enough corrections). Carbs `D ~ LogNormal(log(D_hat) - sigma_ln^2/2, sigma_ln)` (positive,
  right-skewed, mean D_hat).
- **Capture every correction from day one** (images, estimate, corrected value, context) even
  though nothing consumes it yet - it is the only ground truth the system will ever accumulate.
  It is a noisy preference signal, not a weighing.
- Extract fat + protein to choose the absorption profile (late 3-5 h rise), not to show calories.

## 10. Bolus calculator (PDF Sec 12.2)

```
carb_units       = carbs_g / ICR
correction_units = max(0, (G_current - G_target) / ISF)          # 0 if G < target
iob_units        = sum_i D_i * IOB(t_now - t_i)
suggested        = clamp(carb_units + correction_units - iob_units, 0, max_bolus)
```

Display every term (e.g. "77 g / 10 = 7.7 U, plus (180-110)/40 = 1.75 U, minus 2.1 U on board ->
7.4 U") so a mistyped glucose is catchable. Hard constraints: (1) below a configurable low
threshold suggest **no** bolus - show reading + prompt to treat the low; (2) cap at user-set max
and refuse with a stated reason above it; (3) low carb confidence shown adjacent to the number;
(4) dose actually taken is user-entered and stored separately; (5) incomplete insulin history ->
say so, don't treat IOB as 0. Identical in both modes; uses no model output.

## 11. Hypoglycaemia risk model (PDF Sec 8)

Separate model, separate output, separate alarm budget. Wearable earns its place here (counter-
regulatory response: tachycardia, sweating, altered HRV).

- Label: `y(t) = 1 if min G over (t, t+30 min] < 70 mg/dL`. Predict P(y=1 | wearable window
  features over 5/15/30 min): HR mean/max/slope, **HR elevation vs the user's own baseline for
  this time+activity**, HRV (RMSSD, SDNN, LF/HF if RR), movement and the key conjunction
  **HR rising while movement absent**, skin-temp slope, EDA if available, time since insulin/carbs,
  IOB, simulator trajectory, sleep state.
- Class imbalance (hypo ~2-5% of time): report **AUPRC and precision at fixed recall**, not AUROC
  or accuracy; use class weighting/resampling; choose the operating point on validation.
- **Alarm budget:** maximise sensitivity subject to <= 1 false alarm / 24 h. If sensitivity there
  is < ~50%, ship only as a passive "check your glucose" nudge (or not at all). Tiered severity
  (low-confidence = silent in-app flag); no repeat within 30 min; none within 20 min of logged
  carbs; **night-only initially**.
- **Shadow mode long before it is allowed to alert anyone.** Published 70-90% sensitivity is on
  curated data; free-living is much worse. Also report lead-time distribution (median, p10).

## 12. Anomaly agent - `packages/agent` (PDF Sec 9)

On-device, never in the cloud, never acts, every finding carries its evidence, strict interruption
budget, **deterministic and replayable** (each detector is a pure function of a history window -
no I/O, no side effects).

Cadence: event-triggered cheap rules (band sync, meal save, glucose entry, bolus) | every 30 min
(rule + statistical, shares the band-sync wake) | nightly while charging (multivariate, drift) |
weekly audit + digest. Cold start: L1 immediate; L2 at 14 days baseline; L3 at 30 clean days; L4 at
200 scored predictions. **Dormant detectors are not mentioned in the UI.**

| Layer | What | Notes |
|---|---|---|
| 1 Rules | data integrity + behaviour; ~80% of the value, no ML | Band not worn >12 h (low); sync stalled >24 h (low); CGM lost >30 min (med); CGM flatline >3 h awake (med - a failing sensor looks like perfect control); implausible value: glucose outside 20-600, carbs >400 g, bolus > max (high, block+query); meal >15 g with no bolus in 45 min (med); stacking risk IOB >60% of new dose (high, in calculator); clock discontinuity (low, log loudly); therapy settings never set after 3 days (med); glucose >250 for >4 h (high, ketone-check prompt) |
| 2 Statistical | per-feature vs the user's OWN 14-day baseline | Robust z = 0.6745*(x - median)/MAD, trigger |z|>3 across 2 consecutive windows; CUSUM `S_k = max(0, S_{k-1} + (x_k - mu0 - k_slack))` or Page-Hinkley for slow drift |
| 3 Multivariate | abnormal *combinations* | Isolation forest (inspectable) on daily context vector, trained on clean days only, retrained nightly on rolling 90 d |
| 4 Model self-audit | protects the prediction engine | Residual bias (widen, refit); calibration decay (80% PICP outside 70-90% over 200 preds); carb-correction bias; mode divergence; feature drift (PSI); wearable coverage <50%/wk -> disable wearable features rather than impute |

Finding schema (every detector emits the same object): `id, detector, layer (1-4), detected_at,
window{from,to}, severity (info|low|medium|high), score, evidence{statement, values, baseline,
series_ref}, suggested_action, acknowledged_at, dismissed, user_feedback (useful|not useful|wrong)`.
`user_feedback` is the only signal for tuning thresholds - keep it.

**Fusion + budget:** group related findings (overlapping window + shared evidence channels) into
one composite at the highest member severity; rank by severity, recency, novelty. High: immediate
notification, max 2/day (then notify once that it is suppressing more). Medium: in-app badge, no
sound, max 5/day. Low: daily digest. Info: weekly digest. Suppress: same detector within 6 h; any
finding within 20 min of a related user action that explains it; anything during sleep unless high.
Not a diagnostic tool, not a user-programmable rules engine (thresholds + notification prefs only).
FindingStore: local, append-only, synced to backend for clinician view, 90-day retention.

## 13. Wearable / band contract (PDF Sec 4)

Band is a replaceable component behind an interface; no hardware/firmware work in scope.
Required over BLE: HR at least every 5 min while worn; activity magnitude or steps at least 1/min;
battery + wear/no-wear; historical buffering. Desirable: RR intervals (HRV computed on phone), skin
temp, sleep staging, SpO2. **Discard vendor scores** (readiness, stress, body battery) - opaque and
change with firmware; compute our own features from underlying signals.

Normalise into `sensor_sample` with the fixed vocabulary `hr, rr, spo2, skin_temp, activity,
steps, sleep_state`. That mapping is the **only device-specific code in the system.** Record a
`quality` per sample and `coverage` per aggregate.

Features are computed on the phone from aggregates, **always relative to the user's own baseline**
(never absolute): hr_mean/max (15/60/120 min), hr_rest_delta vs trailing 14 d, hrv_rmssd (overnight
longest stationary window) and hrv_delta (z-score vs own distribution), activity_load_2h/24h,
exercise_recent (6 h), exercise_yesterday (24-48 h - delayed sensitisation), sleep_minutes /
efficiency / sleep_debt (7 d), skin_temp_delta (vs same clock hour), and `coverage_*`. The wearable
is a *modifier of insulin sensitivity* (exercise, sleep, HRV/RHR, temperature) - associative, not
quantitatively established per person.

## 14. ML discipline, data, evaluation

### Leakage rules (PDF Sec 10.3) - the most common error in published glucose work

- **Blocked temporal splits** (train earlier, test later, gap >= one forecast horizon). Random
  splits on autocorrelated CGM data give fictitious accuracy.
- **Leave-one-subject-out** for any claim about generalising to a new person.
- No feature may use information after t0: rolling baselines, normalisation stats, and imputation
  are all computed **causally**.
- Meals must not straddle the split. **Report the number of independent subjects**, not samples.

### Datasets (PDF Sec 10.1-10.2)

OhioT1DM (12 subjects x 8 wks; CGM + pump + meals + band; **needs a signed data use agreement**;
HR only in the 2018 cohort), D1NAMO (ECG/breath/accel + glucose + food photos; open), DiaData /
ShanghaiT1DM / DiaTrend / ReplaceBG / DCLP3 / CITY (large CGM corpora for Mode B pre-training),
Nutrition5k (vision benchmark - controlled-condition images overstate real-world accuracy).
Bootstrapping order: (1) fit simulator population params on OhioT1DM (grid tmax, tp, DIA); (2) train
residual LOSO and **report the transfer gap**; (3) hypo classifier on OhioT1DM + D1NAMO; (3b) Mode B
pretrain on CGM corpora then fine-tune on OhioT1DM; (3c) replay agent L1/L2 over OhioT1DM; (4) shadow
mode for weeks; (5) personalise with shrinkage. **Steps 1-3c need no users, wearable, or CGM.**

### Evaluation (PDF Sec 11)

Every reported result includes **all four baselines**: last-value-carried-forward, linear
extrapolation, simulator alone, population residual model (no per-user adaptation).

Metrics: RMSE/MAE per horizon (mg/dL), MARD; **Clarke or Parkes error grid (mandatory)** - report
A+B % and enumerate every zone D and E point; PICP + pinball + reliability diagram; hypo AUPRC,
precision/recall at the operating point, **sensitivity at 1 FA/day**, lead time; carb MAE and % within
+/-10 g and +/-20 g, stratified by cuisine and meal type; agent: user-judged precision, interruption
rate over weeks, detection latency on **injected faults** (flatline, missing insulin log, slow
residual bias - part of the regression suite).

Acceptance thresholds, **fixed in advance**:

| Metric | Mode A | Mode B |
|---|---|---|
| RMSE 30 min | < 35 mg/dL | < 20 mg/dL and better than LOCF |
| RMSE 60 min | < 50 mg/dL | < 30 mg/dL |
| Error grid A+B | >= 92% | >= 95% |
| Error grid zone E | 0 predictions | 0 predictions |
| 80% interval coverage | 75-85% | 75-85% |
| Improvement over simulator alone | >= 10% RMSE | >= 20% RMSE |

Mode-independent: carb MAE < 15 g with >= 60% within +/-20 g; hypo sensitivity >= 50% at <= 1 FA/day
(else passive nudge only); agent high-severity precision >= 70% rated useful; agent <= 2
interruptions/day sustained over a month; agent catches an injected 15% residual bias within 100
predictions. Interval coverage requirement is identical across modes - it is the one that protects
the user. **If a threshold is not met, report that it was not met.**

### Retrospective scoring loop (PDF Sec 11.4) - build from v1

Every prediction is stored with its inputs. When a glucose observation lands inside a stored
prediction's window, score it and write `prediction.scored_error`. Without this there is no
personalisation data, no drift detection, and no answer to "how accurate is it, for me?"

### Model versioning (PDF Sec 12.3)

Every artefact has a semantic version, training-data hash, and metrics record; every prediction row
records the version. New models deploy in **shadow mode** and are shown only after beating the
incumbent on PDF Sec 11 metrics over a defined window. Rollback = a version pin, not a redeploy.

## 15. Build order and how to work here

Ordered by dependency, not interest (PDF Sec 16). **Phases 1-3 are unblocked and highest-value:**

1. Simulator parameter fitting on public data + residual transfer study (LOSO)  <- start here
2. Hypo classifier (OhioT1DM + D1NAMO) with an explicit alarm-budget operating point
3. Carb uncertainty calibration (needs a kitchen scale + ~20 weighed meals)
4. Shadow-mode deployment + retrospective scoring loop (needs a working app)
5. Per-user residual personalisation w/ shrinkage (~100 scored predictions/user); 5b agent L1/L2 live,
   L3/L4 shadow
6. CGM integration (Nightscout first - open documented API) - unlocks Mode B; 6b Mode B pretrain +
   fine-tune + Mode A envelope
7. Bounded parameter fitting with clinician review; 8. contextual modifiers (time-of-day, exercise,
   sleep); 9. deeper Mode B (TFT, attention); 10. prospective clinical validation.

Conventions for contributors (human or AI):

- **Write the six invariants (section 3) as tests before features.** Detectors are pure functions and
  get replay/fixture tests. The sim cross-language fixture test (section 4) runs on every commit.
- Prefer boring, inspectable models (ridge -> boosted trees) over novelty. Report against baselines.
- Never state an accuracy or safety claim the evaluation has not measured; keep the limitations in PDF Sec 15
  (no glucose measurement, unvalidated carb estimation, simplified simulator, small-n
  evaluation, no regulatory status, research-grade hypo model) visible in user-facing "About".
- Secrets/credentials never in git (`.env*` is gitignored; commit `.env.example` only).
- Stay on the `sugarsense_app` branch; do not touch or import the Garmin apps.

### Open decisions (ask the user, then record the answer here)

Decided: React Native + Expo with TypeScript (**day-to-day UI work runs in the browser via Expo Web on
localhost; native features are tested later on physical Android/iPhone using Expo development builds,
not Expo Go**); NestJS backend on localhost; Python `ml/`; PostgreSQL/Supabase for data.
Still open: ORM / query layer for Postgres (only the `pg` driver and `@supabase/supabase-js` are
installed; no data models exist), how shared TS packages reach both `mobile/` and `backend/`, BLE
library (`react-native-ble-plx` is the likely candidate but is deliberately NOT installed - the band is
not chosen), on-device inference runtime (ONNX Runtime Mobile vs TFLite vs ExecuTorch), which
vision-language model, band model to target first, and the final `com.sugarsense.app` application id
(set in `mobile/app.json`; it is permanent once published to a store).

### Commands

All commands run from the named folder. Windows, Node >= 22.13, Python 3.12.

| Where | Command | Purpose |
|---|---|---|
| `mobile/` | `npm install` | install deps (`npm` 11 recommended, see Tooling notes) |
| `mobile/` | `npm run web` | **laptop UI testing:** Expo Web on http://localhost:8081 (Fast Refresh) |
| `mobile/` | `npm run start:go` | **iPhone UI testing:** Metro for Expo Go (QR code / `exp://<PC LAN IP>:8081`); also serves the web app |
| `mobile/` | `npm run android` | build + install the dev build on a connected phone, start Metro (**not built yet**) |
| `mobile/` | `npm start` | Metro for an already-installed dev build (`--dev-client`) |
| `mobile/` | `npm run typecheck` / `npm run lint` / `npm run doctor` | tsc / ESLint / expo-doctor |
| `backend/` | `npm install` | install deps |
| `backend/` | `npm start` / `npm run start:dev` | start Nest (port from `PORT`, default 3000) / watch mode |
| `backend/` | `npm run typecheck` / `npm run lint` / `npm test` / `npm run test:e2e` / `npm run build` | checks |
| `ml/` | `.venv\Scripts\python.exe -m pytest` / `-m ruff check .` | env smoke test / lint |

### Tooling notes (environment gotchas)

- **Use npm 11 for `backend/`.** npm 10.9.x (bundled with Node 22.16) crashes on its dependency tree with
  `Cannot read properties of null (reading 'edgesOut')`. Run installs there as `npx --yes npm@11 install ...`
  (or upgrade the global npm). `mobile/` installs fine with npm 10.
- `@nestjs/cli` 12 pulls `@angular-devkit` 22 which asks for Node >= 22.22.3; on Node 22.16 npm prints
  `EBADENGINE` warnings for it. Upgrade Node to clear them.
- Expo cannot generate `ios/` on Windows (`expo prebuild --platform ios` is skipped). iOS native builds
  need macOS or EAS cloud builds (`mobile/eas.json` is ready; needs an Expo login + Apple Developer account).
- `mobile/android/` is generated (gitignored). `expo prebuild` recreates it; native customisation must go
  through config plugins, not hand edits.
- Android SDK lives in `%LOCALAPPDATA%\Android\Sdk`; `ANDROID_HOME` and `platform-tools` on PATH are set at user
  level. Platform 36 and build-tools 36.0.0 are present; **NDK 27.1.12297006 and CMake 3.22.1 are not installed**.
- **No native Android binary has been built.** The first `assembleDebug` got as far as Gradle's NDK auto-install,
  which hung (empty `ndk/27.1.12297006/.installer`, dead `CLOSE_WAIT` connections) on this slow (~0.5 MB/s)
  connection; the `sdkmanager`/`android sdk install` CLI (now a wrapper around Google's new Android CLI) also
  hangs silently here. Manual route that works: download `android-ndk-r27b-windows.zip` (781495902 bytes, sha1
  `3bb7efc850cd0af7707854b7e0d5c3b6a7153703`) and `cmake-3.22.1-windows.zip` from
  `https://dl.google.com/android/repository/` with `curl -C -` (resumable), verify the sha1, extract the NDK into
  `Sdk\ndk\27.1.12297006` (its `source.properties` must read `Pkg.Revision = 27.1.12297006`) and CMake into
  `Sdk\cmake\3.22.1`, then `cd mobile\android; .\gradlew.bat app:assembleDebug -PreactNativeArchitectures=arm64-v8a`.
  What was verified before it stalled: Gradle 9.3.1 downloaded, and under JDK 19 the build got through
  configuration, the Expo/RN Gradle plugin compilation and platform 36 install. Native compilation itself
  (C++/Kotlin app code, APK assembly, install on a device) has NOT been exercised.
- Browser-side code needs CORS: the backend allows `CORS_ORIGINS` (default `http://localhost:8081`). Native
  builds are not subject to CORS, and a physical phone must use the PC's LAN IP as `EXPO_PUBLIC_API_URL`.

## 16. Notation

`G(t)` glucose mg/dL | `D` carb dose g | `A_G` bioavailability 0.8 | `t_max` carb time-to-peak min |
`Ra` rate of appearance g/min | `alpha, delta` slow-fraction / delay for high-fat meals | `tp` insulin
peak min | `DIA` duration of action min | `IA` active fraction per min | `IOB` fraction on board |
`ICR` g per unit | `ISF` mg/dL per unit | `CSF = ISF/ICR` mg/dL per g | `b(t)` endogenous drift
mg/dL/min | `h` horizon min | `r_h` residual at horizon h | `Q_q(h)` q-th quantile | `sigma_ln`
log-normal shape for carb uncertainty | `n_u, k` per-user count / shrinkage constant (~30) |
`m_ISF, m_ICR` fitted multipliers bounded [0.7, 1.3].
