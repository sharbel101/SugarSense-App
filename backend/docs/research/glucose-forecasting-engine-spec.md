# SugarSense Glucose Forecasting Engine: Research and Specification

Oct 16, 2026 · @ok

## Executive recommendation

**Build Approach B in its smallest form.** The forecast is a deterministic physiological simulator driven by the timestamped event history, corrected online by a three-state Kalman filter, with a few personal parameters recalibrated slowly inside hard bounds. There is no neural network and no ODE integrator. The whole forecast is a pure function of (CGM history, events, parameters, now). That is what makes Python and TypeScript parity testable, and it makes late, edited or deleted entries trivial: replay the history.

&#91;embedded content: proposed engine architecture · fast loop per reading or event, slow loop daily\]

Fast loop, on every reading or event: the simulator turns events into a nominal glucose path, the filter anchors that path to the CGM trace, and the forecast propagates the filtered state 180 minutes ahead. Slow loop, daily: calibration moves a few parameters inside bounds and re-measures how wide the intervals must be.

### The model in four sentences

1. CGM glucose is a nominal path m(t) plus a residual. The nominal path is the insulin glucose effect (dose × ISF × cumulative action), plus the meal glucose effect (carbs × ISF/ICR × cumulative absorption), plus context terms. The residual, a level z and a damped trend r, carries everything the simulator does not know.
2. The CGM reads interstitial glucose through a first-order lag (default 8 min), so the filter state is \[sensor glucose, z, r\]. This system is linear, so the Kalman filter is exact and an EKF or UKF is not needed.
3. Process noise is not a free constant. Its rate term grows with the uncertain inputs still active (carb-count error × meal appearance rate, sensitivity error × insulin activity), so the forecast band widens exactly where the physiology is uncertain.
4. Interval widths are then rescaled per horizon from past forecast errors (Section 7), because Gaussian filter intervals cannot be trusted at long horizons without checking.

### The design rule: evidence tier decides a feature's role

| Tier | Meaning | What the engine does with it |
| --- | --- | --- |
| **V** Validated | Structure and magnitudes shown in human data for this kind of use | Used in the mean forecast |
| **L** Limited | Direction established; magnitude from small studies or person-specific | Prior mean near zero, learned per user with shrinkage; meanwhile widens or skews the interval |
| **E** Engineering | Widely used approximation without formal validation | Used inside hard bounds, flagged, kept only if an ablation shows it helps |
| **N** Non-identifiable | Cannot be estimated from CGM plus logged events | Fixed or marginalised, never fitted |

### What goes into version 1

| Component | Role in v1 | Tier | Section |
| --- | --- | --- | --- |
| Insulin: exponential (Maksimovic) activity kernel, peak 75 min (55 for ultra-rapid), end 300 min | Insulin glucose effect = dose × ISF × cumulative action | E | 5 |
| IOB, activity, cumulative action, glucose effect kept as four distinct quantities | Bookkeeping that prevents double-counting | V (identities) | 5 |
| Meals: gamma(2) absorption, τ = 40 min; carb effect = ISF/ICR per gram | Meal glucose effect | L / E | 4 |
| Fat and protein | Delayed second component; no population mean shift; widens late interval | L (direction), N (population size) | 4 |
| Glycemic index | Not used as a multiplier of the carbohydrate effect | L / N | 4 |
| Time of day, dawn | Learned drift profile (two harmonics) + noise inflation, not a fixed rule | L | 6 |
| Sleep | Widens insulin-sensitivity uncertainty only | L | 6 |
| Exercise | Two decaying states from user-entered or heart-rate intensity; flags late-onset low risk | L | 6 |
| CGM lag and noise | First-order lag state; robust gating of outliers | V (structure), E (values) | 7 |
| Online correction | Three-state linear Kalman filter | V (method), E (tuning) | 7 |
| Personal calibration | Bounded, rate-limited MAP of four core parameters (ISF scale, CSF scale, insulin peak, meal τ), plus separate side fits | E | 8 |
| Uncertainty | Filter variance × per-horizon empirical scale | E | 7 |
| Trust monitor | Innovation and data-quality checks → flag | E | 7, 11 |

### What version 1 deliberately leaves out

- GI as a multiplier of carbohydrate effect (double-counts, and GI varies within a person as much as between people).
- Fixed percentage rules for sleep loss, dawn or exercise.
- Population-wide fat and protein mean shifts.
- Online estimation of ISF and carb effect at the same time (confounded when a meal and its bolus are paired).
- Unannounced-meal detection, stress, illness, menstrual-cycle and alcohol effects.
- Nonlinear Hovorka terms (renal loss, glucose-dependent uptake). They matter only if the linear core fails a validation gate.

### A, B or C

|  | A: pure simulator | **B: simulator + online correction + bounded calibration** | C: B + more latent states |
| --- | --- | --- | --- |
| What it is | Events → kernels → glucose path, anchored at the last CGM value | A plus a 3-state Kalman residual, daily bounded calibration, calibrated intervals | B plus per-meal carb-error states, a sensitivity-scale state, unannounced-meal and exercise states, joint state and parameter estimation |
| Strength | Fully explainable, nothing to tune online | Corrects whatever the model gets wrong with three states; keeps explainability | Can fix specific failure modes, such as a systematic carb under-count |
| Weakness | Errors from wrong ISF, ICR or carb counts persist and grow | Cannot attribute an error to its cause; correction is generic | Identifiability: ISF and carb effect are confounded when meals and boluses are paired; more states, more tuning, harder parity |
| Verdict | Baseline for ablations | **Recommended for the first prototype** | Add one state at a time, only when an ablation on held-out users shows a gain on a named failure mode (Section 11) |

### What this report could and could not establish

- The structure and parameter values come from papers and open-source code I opened or saw in search excerpts. Section 12 marks each source as opened or seen in an excerpt.
- Hovorka's model was validated on fasting and overnight data to 60 minutes (Hovorka 2004). I found no published validation of a kernel-plus-Kalman forecaster at 180 minutes in free-living type 1 diabetes. Expected accuracy is therefore unknown until the engine is run on real data.
- The only numbers in this document that I produced are checks of my own code: the insulin and meal kernels, the filter matrices, a worked example, and a synthetic test. These show internal consistency. They are not clinical evidence.
- This is a forecasting engine specification, not a dosing algorithm. Any alerting or dosing use needs its own clinical validation and regulatory review.

## Literature review

**How to read this section.** Claims carry the evidence tier defined in Section 1 (V, L, E, N). "Opened" means I read the page or code. "Excerpt" means I read only a search-result excerpt and quote only what it states. Section 12 gives the status of every source.

### Evidence ledger

| Item | Tier | What the sources establish | What they do not | Used here as |
| --- | --- | --- | --- | --- |
| Compartment structure of glucose-insulin dynamics (Hovorka) | V for fasting and overnight to 60 min; L otherwise | Bayesian-fitted compartment model; 15 overnight fasting experiments with intravenous sampling; Clarke grid 95% zone A and 5% zone B up to 60 min, n = 1674 (Hovorka 2004) | Meals, exercise, horizons beyond 60 min, free-living use | Structural guide: gut and subcutaneous insulin as two-compartment chains |
| Two-compartment subcutaneous insulin absorption | L | 11 alternative subcutaneous kinetics models compared in 7 people with type 1 diabetes (Wilinska 2005) | That one model wins across insulins and sites | Justifies a gamma-like activity shape |
| Exponential insulin curve (Maksimovic) | E | Implemented in oref0 and discussed for Loop; two parameters (peak, end); defaults 75 min rapid-acting and 55 min ultra-rapid; end at least 300 min (oref0 code and docs, opened) | No peer-reviewed validation of the shape; dose-dependent duration | Insulin kernel |
| IOB = 1 minus cumulative activity | V (identity) | OpenAPS docs definition; I checked the closed form against 1 minus the numerically integrated activity, largest difference 4e-11 over three settings | Nothing physiological beyond the definition | Bookkeeping |
| Insulin-action variability | L | Varies within and between people and with time of day, stress and illness (Ellingsen 2009, opened; variability reviews, excerpts) | A magnitude that applies to one person on one day | Uncertainty term for sensitivity |
| Gut model: gamma(2), tau = 40 min | L | Hovorka model parameters; Dalla Man nonlinear gastric emptying built on tracer data | Type 1 mixed-meal validation; fat and protein | Meal kernel |
| Fat and protein delay and prolong the glucose rise | L (direction); N (population size) | Late rises at about 3 to 5 h, effects additive, large between-person spread (Wolpert 2013, Smart 2013, Paterson studies, Bell 2015) | A transferable formula; thresholds differ between studies | Delayed component with shrinkage; wider late interval |
| Glycemic index | L / N | Within-person variability of GI values comparable to between-person (CV 20% vs 25% in Matthan 2016; 42.8% vs 17.8% in a 2007 Diabetes Care study); personalised responses to identical foods (Zeevi 2015) | A kinetic parameter usable meal by meal | Not used as a multiplier |
| Exercise effects | L | Two phases; aerobic lowers glucose most, then interval, then resistance; sensitivity stays raised for hours; late-onset lows (Riddell 2017; T1DEXI; model papers) | Individual size: T1DEXI standard deviations are two to four times the mean change | Two decaying states, prior mean from T1DEXI |
| Sleep restriction | L | One night of 4 h sleep: about 21% lower glucose infusion rate in 7 people with type 1 diabetes; about 25% in healthy people, plus hepatic effects (Donga 2010) | Free-living size, dose-response, persistence | Uncertainty only in v1 |
| Dawn phenomenon | L | Present in all tested subjects but in a median of 56% of nights; fixed basal programming can be ineffective or hazardous | Predicting which night | Learned drift profile plus noise inflation |
| Circadian insulin sensitivity | L | Individual-specific diurnal pattern in type 1 diabetes; UVA/Padova uses 7 classes with random deviations up to 40% | A profile that transfers between people | Shrunk two-harmonic basis; 40% used as a guardrail, not as evidence |
| CGM lag | V (structure); E (value) | First-order plasma-to-interstitium lag; sensor time constants reported 6 to 12 min; physiological delay about 6 min, with about 10 min as a conservative estimate, in one review; 9.4 ± 6.5 min in a model of the Medtronic Enlite sensor | A per-person value | Lag state, device default 8 min |
| Kalman, EKF, UKF on glucose models | V (method) | Many published uses: CGM filtering, failure detection, UKF with Hovorka | Head-to-head comparison against simple residual correction | Linear Kalman filter |
| Parameter identifiability | V (concept) | Fisher-information and Bayesian-prior analyses show only a subset of parameters is identifiable (Visentin; Staal 2019; MI-OMM) | Which subset holds for your users | Gating in Section 8 |
| Empirical interval calibration | E | Split-conformal methods give coverage when errors are exchangeable | Glucose time series are not exchangeable | Rolling quantiles plus coverage monitoring |

### Physiological models and what was validated

The Bergman minimal model (1979; reviewed 2021) was built to estimate insulin sensitivity from intravenous glucose tolerance tests. It has no meal input and no subcutaneous insulin. The Hovorka family (Hovorka 2002, 2004) adds a two-compartment gut, two-compartment subcutaneous insulin, plasma insulin, and three insulin actions (glucose transport, disposal, endogenous production). I used the equations and parameters as reproduced by Boiroux et al. (2010, opened), which is a secondary source: gut and insulin time constants of 40 and 55 min, bioavailability 0.8, distribution volume 0.16 L/kg, plus nonlinear terms for renal loss above 9 mmol/L and reduced uptake below 4.5 mmol/L.

The published validation is narrow. The 2004 study used fasting, overnight data and reached 95% zone A at horizons up to 60 minutes. The UVA/Padova simulator (Dalla Man 2007 meal model, 2014 update, 2018 single-day version) is built for in-silico testing of control algorithms, not as a validated forecaster of individual free-living days.

A check I ran: with the published parameters, a subcutaneous bolus in the Hovorka insulin subsystem gives subcutaneous absorption peaking at 55 min, plasma insulin at 63 min, and the three effect compartments at 84 min (disposal), 101 min (endogenous production) and 165 min (transport). The exponential kernel's 75-minute activity peak sits just before the fastest effect compartments. That is the right order of magnitude, not a proof of any particular peak time, which is why the peak is a bounded personal parameter.

### Insulin kinetics and kernels

The oref0 code and the Maksimovic derivation define activity and IOB for a two-parameter curve (peak and end). The OpenAPS documentation states that activity is the fraction of a dose used per minute and that IOB is the inverse of cumulative activity, requires the end of action to be at least 300 minutes, and limits the peak to 35 to 120 minutes (code clamps 50 to 120 for rapid-acting). Pharmacokinetic and pharmacodynamic studies of faster-acting aspart across a dose range (Heise 2017, excerpts) and time-action summaries show earlier onset for ultra-rapid insulins, which supports separate default peaks. I did not extract dose-dependence numbers, so the kernel is dose-independent, and that is flagged as a limitation. Ellingsen (2009) is the source for treating IOB as a safety quantity and for the within-person variability of insulin action.

### Meals, fat, protein and glycemic index

Wolpert (2013, 7 people) found that a 60 g fat meal, against 10 g, raised glucose and insulin needs, with effects at 3 to 5 hours and a between-person spread (R² = 0.64 against daily insulin dose). Smart (2013) found that protein and fat each lengthen and raise the postprandial excursion from about 180 minutes, additively, and that the high-fat, high-protein meal peaked at 180 to 300 minutes. In the Paterson protein studies, at least 75 g of protein alone raised glucose over 3 to 5 hours; 12.5 g and 50 g did not do so significantly; there was an early dip before the late rise. Bell (2015) is a systematic review with seven studies each for fat, protein and GI and heterogeneous protocols. Bozzetto (2016) compared the glycemic response to high- and low-glycemic-index meals of different fat content in people with type 1 diabetes wearing CGM; I saw only fragments of the paper, so no result from it is used.

The consistent finding is direction and timing, not size. That is why the engine adds a delayed component with a learned, shrunk amplitude and treats population values as nothing more than a wider interval.

GI is a ratio of two-hour incremental areas against a reference food, averaged over healthy volunteers. It carries no information about when the rise happens, mixed meals change it, and within-person variation is as large as between-person variation (Matthan 2016; 2007 Diabetes Care paper, both excerpts). Zeevi (2015) showed large personal differences in response to identical foods in people without diabetes. Section 4 draws the consequences.

### Exercise

The consensus statement (Riddell 2017) and the T1DEXI trial (497 adults) agree on the pattern. Mean glucose change was −18 ± 39 mg/dL for aerobic, −14 ± 32 for interval and −9 ± 36 for resistance exercise. A study of hypoglycemia events found 5.6 against 10.7 per patient for morning against afternoon exercise, most at 15 to 24 hours after exercise. Models separate an insulin-independent uptake that rises and decays within minutes from an insulin-sensitivity increase that decays over hours (Dalla Man 2009, Schiavon 2013, Resalat 2019, Romeres 2021, Deichmann 2021 and 2023, a heart-rate-driven model on arXiv). Their parameters are not comparable across papers, because the states are scaled differently.

### Sleep, circadian rhythm and dawn

In Donga (2010) one night of 4 hours of sleep lowered peripheral insulin sensitivity: about 21% lower glucose infusion rate in 7 people with type 1 diabetes, and about 25% in healthy people with hepatic effects. These are clamp studies in a laboratory, not free-living results. A dawn-phenomenon study found it in all tested subjects but in a median of 56% of nights, and warns that fixed basal programming can be ineffective or hazardous. Other sources describe an individual-specific diurnal pattern of insulin sensitivity.

### State estimation, CGM error and identifiability

The CGM error model of Facchinetti (2014) combines a plasma-to-interstitium lag, calibration error and autoregressive noise. Reported sensor time constants range from about 6 to 12 minutes, and a sensor-error model of the Medtronic Enlite sensor estimated a mean lag of 9.4 ± 6.5 minutes. Garg (2022) reports a MARD of 8.2% (arm) and 9.1% (abdomen) for the Dexcom G7. Kalman-type filters on glucose-insulin models include an EKF with a CGM model (Facchinetti 2010), Kalman-based failure detection, and UKF with Hovorka. Visentin's work, Staal (2019) and MI-OMM show with Fisher information and Bayesian priors that only part of the parameter vector is identifiable.

I could not open a recent meta-analysis of machine-learning glucose predictors (the page was blocked by a captcha, which I did not try to bypass), so this report quotes no machine-learning accuracy figures.

### Datasets

| Dataset | Size and content | Caution |
| --- | --- | --- |
| OhioT1DM (Marling and Bunescu 2020) | 12 people, 8 weeks each | Small; check what meal and exercise fields it logs before relying on them |
| DiaTrend (Sci Data 2023) | 54 people with type 1 diabetes | Real-world, access through Synapse |
| T1DEXI (Riddell 2023) | 497 adults, structured exercise | Check the data dictionary for meal macronutrients before planning fat and protein validation |
| HUPA-UCM | Seen only as an arXiv excerpt | Not relied on |

## Equation specification

This section fixes the units, the decomposition and the exact discrete form. Section 4 defines the meal kernel, Section 5 the insulin kernel, Section 6 the context terms and Section 7 the filter.

### Conventions and units

- Internal units are mg/dL, U, g and minutes. Convert at the edges: 1 mmol/L = 18.016 mg/dL.
- Grid step Δ = 5 min. Event times are stored in UTC with the time-zone offset in force at the event, so daylight-saving changes cannot shift the clock-time terms. Local time of day τ(t) is minutes after local midnight.
- The filter replays a window starting at t\_w = now − 12 h. Events are loaded from t\_w − 6 h, so the tail of earlier doses and meals is included.

| Symbol | Meaning | Unit |
| --- | --- | --- |
| G(t), IG(t) | plasma glucose; sensor (interstitial) glucose that the CGM reads | mg/dL |
| y\_k | CGM reading at grid step k | mg/dL |
| U\_j, t\_j | bolus dose and time (basal deviations enter as small doses) | U, min |
| C\_m, t\_m | available carbohydrate of a meal and its time | g, min |
| ISF | insulin sensitivity factor | mg/dL per U |
| ICR | insulin-to-carbohydrate ratio | g per U |
| CSF = ISF / ICR | carbohydrate sensitivity factor | mg/dL per g |
| a(s), A(s) | insulin activity kernel; cumulative insulin action | 1/min; unitless |
| f(s), F(s) | meal absorption rate kernel; cumulative absorption | 1/min; unitless |
| Act(t) = Σ U\_j a(t − t\_j) | insulin activity | U/min |
| IOB(t) = Σ U\_j (1 − A(t − t\_j)) | insulin on board | U |
| Ra(t) = Σ C\_m f(t − t\_m) | meal appearance rate | g/min |
| COB(t) = Σ C\_m (1 − F(t − t\_m)) | carbohydrate on board | g |
| m(t) | nominal plasma glucose path, relative to the window start | mg/dL |
| z, r | residual level and residual rate | mg/dL; mg/dL/min |
| τ\_s, τ\_r | CGM lag; damping time of the residual rate | min |

### Decomposition

Sensor glucose is plasma glucose seen through a first-order lag. Plasma glucose is a nominal path plus a residual.

```latex
\begin{aligned}
G(t) &= m(t) + z(t) && [\mathrm{mg/dL}]\\
\frac{dIG}{dt} &= \frac{G(t) - IG(t)}{\tau_s}, \qquad y_k = IG(t_k) + v_k && [\mathrm{mg/dL/min}]\\
m(t) &= \Delta G_{ins}(t) + \Delta G_{meal}(t) + \Delta G_{ctx}(t), \qquad m(t_w)=0
\end{aligned}
```

The three effects are integrals of rates, and each rate is a product of a gain and a quantity that has its own unit:

```latex
\begin{aligned}
\frac{d\,\Delta G_{ins}}{dt}  &= -\,ISF(t)\cdot Act(t)  && [(\mathrm{mg/dL})/\mathrm{U}] \cdot [\mathrm{U/min}]\\
\frac{d\,\Delta G_{meal}}{dt} &= +\,CSF(t)\cdot Ra(t)    && [(\mathrm{mg/dL})/\mathrm{g}] \cdot [\mathrm{g/min}]\\
\frac{d\,\Delta G_{ctx}}{dt}  &= \mu(\tau(t)) - \kappa_x\,u_x(t) && [\mathrm{mg/dL/min}]
\end{aligned}
```

The gains are

```latex
ISF(t) = ISF_0(\tau(t))\, e^{\,s_x(t)}, \qquad CSF(t) = \frac{ISF_0(\tau(t))}{ICR(\tau(t))}
```

where ISF\_0 and ICR are the person's clinic settings by time of day, s\_x is the exercise sensitivity state (Section 6), and μ is the learned time-of-day drift of glucose with no meal and no extra insulin (Section 6). **A sensitivity modifier multiplies the insulin term only.** If exercise makes someone more insulin sensitive, a gram of carbohydrate does not raise glucose less, so CSF takes ISF\_0, not the modified ISF.

Insulin entering the model is net: boluses plus (delivered basal − reference basal), cut into small doses at the midpoints of 5-minute segments. The reference basal is the scheduled profile in force at calibration time, so the baseline drift μ is learned relative to it. Counting all basal insulin would count the same action twice, once here and once in the baseline glucose production it balances.

### Exact discrete form

For each step k, with kernels integrated exactly over the step (this is what makes Python and TypeScript agree):

```latex
\begin{aligned}
\Delta G_{ins,k}  &= -\,ISF(t_k+\tfrac{\Delta}{2}) \sum_j U_j\,[A(t_{k+1}-t_j) - A(t_k-t_j)]\\
\Delta G_{meal,k} &= +\,CSF(t_k+\tfrac{\Delta}{2}) \sum_m C_m\,[F(t_{k+1}-t_m) - F(t_k-t_m)]\\
m_{k+1} &= m_k + \Delta G_{ins,k} + \Delta G_{meal,k} + \Delta G_{ctx,k}, \qquad m_0 = 0
\end{aligned}
```

with A(s) = F(s) = 0 for s ≤ 0 and A(s) = 1 for s ≥ t\_d. Events dated before the window still contribute through A and F at positive s.

m(t) is defined only up to a constant. The filter's initial residual z\_0 fixes it. A useful special case is the anchored simulator of Approach A, where only the part of past events not yet realised, and any future events, change glucose:

```latex
\hat{y}_A(t_0+h) = y(t_0) + m(t_0+h) - m(t_0)
```

### Worked example G1

A 40 g meal with its exact bolus (4 U at ICR 10), both at minute 0, ISF 50 mg/dL per U (so CSF = 5 mg/dL per g), insulin peak 75 min and end 300 min, meal τ = 40 min.

&#91;embedded content: worked example G1 · 4 U + 40 g, ISF 50, ICR 10, peak 75, end 300, meal tau 40 · computed with the reference script\]

The meal effect reaches +200 mg/dL and the insulin effect −200 mg/dL, so the doses cancel in the end. In between, carbohydrate acts faster than insulin: at 120 min the meal is 80% absorbed but the insulin action is only 59% complete. The net peaks at +47.7 mg/dL at 90 min even though the dose is exactly matched. This hump is physiology the model must reproduce without any filter, and it is the reason pre-bolus timing matters.

| Minutes | Insulin effect | Meal effect | Net m(t) |
| --- | --- | --- | --- |
| 30 | −15.0 | +34.7 | +19.7 |
| 60 | −47.2 | +88.4 | +41.2 |
| 90 | −83.8 | +131.5 | +47.7 |
| 120 | −117.9 | +160.2 | +42.3 |
| 180 | −168.2 | +187.8 | +19.5 |
| 240 | −193.4 | +196.5 | +3.1 |
| 300 | −200.0 | +199.1 | −0.9 |

All values in mg/dL. They are the golden vector G1 for the TypeScript port (Section 10). The −0.9 at 300 min is the gamma tail: the meal kernel has an infinite tail (0.5% not yet absorbed at 300 min) while the insulin kernel ends at 300 min. That is negligible, but it is a real non-conservation and is documented rather than hidden.

### Dimensional and plausibility checks

| Check | Result |
| --- | --- |
| ISF × U × A | (mg/dL per U) × U × 1 = mg/dL |
| CSF = ISF / ICR | (mg/dL per U) / (g per U) = mg/dL per g |
| CSF × C × F | (mg/dL per g) × g × 1 = mg/dL |
| d IOB / dt = −Act | U/min on both sides; verified numerically, maximum difference 4e-11 |
| Kernel normalisation | insulin activity integrates to 1.000000; meal kernel to 0.9999999987 |
| CSF against a mass balance | Hovorka-style gross rise = bioavailability × 1000 mg/g ÷ distribution volume. With 0.8, 0.16 L/kg and 70 kg (112 dL) this is 7.1 mg/dL per g, against CSF = 5.0 for ISF 50 and ICR 10: same order, and CSF is smaller as it should be, because it is a net effect |
| Process noise | rate disturbance in (mg/dL/min)²; random-walk intensity in mg²/dL² per min |

### Double-counting rules

1. Carbohydrate bioavailability (0.8 in Hovorka) and CSF both scale carbohydrate. The engine has one scalar: CSF absorbs bioavailability, and the meal kernel integrates to 1.
2. Only basal insulin deviating from the reference basal is an insulin event. Baseline glucose production is in μ(τ).
3. Sensitivity modifiers (exercise, sleep) multiply the insulin term only, never CSF.
4. A meal has one timing parameter (τ\_m). Fat, protein and GI do not each add their own shift on top of it (Section 4).
5. The exercise acute-uptake state and the exercise sensitivity state are separate additive terms. There is no further exercise multiplier on top.
6. A bolus calculator's suggested dose is not an event. Only the delivered dose is. The IOB a pump reports is never added to the model's own IOB.

### Validity range and structural limits

- Requires 0 < t\_p < t\_d / 2, ISF > 0, ICR > 0, C ≥ 0, U ≥ 0. Invalid inputs are rejected, not clipped.
- The displayed forecast is clipped to 20 to 500 mg/dL and a `clipped` flag is returned, rather than silently hiding a model that has run off.
- The core is linear: effects add, and nothing pulls glucose back toward a set point. Hovorka's model has glucose-dependent terms (renal loss above about 9 mmol/L, reduced uptake below 4.5 mmol/L) that this core omits. Over the usual range their effect is slow, but at the extremes the nominal path overshoots. The damped residual state absorbs some of this, and a nonlinear variant is kept as a comparator for validation, not for v1.
- Insulin duration and shape are taken as independent of dose, and doses superpose. Dose-dependent duration is a known effect that I did not quantify.

## Meal absorption specification

### Kernel

The carbohydrate kernel is the output of two equal first-order compartments, the gut model of Hovorka. In this specification it integrates to 1, because the bioavailability that Hovorka fixes at 0.8 is absorbed into CSF (double-counting rule 1, Section 3).

```latex
\begin{aligned}
\dot D_1 &= -\frac{D_1}{\tau_m} + C\,\delta(t-t_m), \qquad \dot D_2 = \frac{D_1 - D_2}{\tau_m}, \qquad Ra = \frac{D_2}{\tau_m} \quad [\mathrm{g/min}]\\
f(s) &= \frac{s}{\tau_m^{2}}\,e^{-s/\tau_m}\ [1/\mathrm{min}], \qquad F(s) = 1-\Bigl(1+\frac{s}{\tau_m}\Bigr)e^{-s/\tau_m}, \qquad s=t-t_m
\end{aligned}
```

The rate peaks at s = τ\_m, the mean is 2τ\_m and the median about 1.68 τ\_m. With τ\_m = 40 min (Hovorka's value):

| Minutes after eating | 30 | 60 | 90 | 120 | 180 | 240 | 300 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Share absorbed | 17.3% | 44.2% | 65.8% | 80.1% | 93.9% | 98.3% | 99.5% |

The kernel is linear: the timing does not depend on the size of the meal. Dalla Man's gastric-emptying model makes the emptying rate depend on the amount in the stomach, so larger meals take longer. I keep the linear form because the size dependence is not identifiable from logged carbohydrate and CGM alone. The validation plan (Section 11) checks residuals by meal-size class, and a size-dependent τ\_m is added only if that check shows a gain.

### From grams to glucose

The glucose effect of a meal is CSF × C × F(s), with CSF = ISF\_0 / ICR (mg/dL per g). It is not a free third parameter: ICR and ISF are the person's clinic settings and are recalibrated together (Section 8). C is the carbohydrate the user enters, in grams. Fibre is not required. If the app later records it, subtract only the part the user's clinic subtracts when dosing, so the model and the dose stay consistent.

Carbohydrate counting is uncertain, and that uncertainty is propagated rather than ignored. The rate variance of the residual includes (c\_C · CSF · Ra(t))², where c\_C is the relative error of the carbohydrate entry. The starting value 0.25 is an engineering default, to be replaced by the value fitted from residual statistics. If the app records how the figure was obtained (weighed, read from a label, estimated by eye), c\_C can be set per source.

Late entry works without special code: the meal is stored with the time the user says they ate, and the whole window is replayed.

### Fat and protein

The sources agree on direction and timing and disagree on size (Section 2). Late rises appear from about 3 hours, fat and protein add, between-person spread is large, and thresholds differ between studies. Three mechanisms are proposed in the literature: delayed gastric emptying, glucose production from protein, and fat-related insulin resistance. CGM and logged events cannot tell them apart, and I did not verify the mechanistic evidence. The engine therefore uses one form that keeps the model linear and the units identical: a delayed second appearance component.

```latex
Ra_m(t) = C_m\, f(t-t_m;\tau_m) + E_m\, f(t - t_m - d_{FP};\tau_{FP}), \qquad E_m = \alpha_P\,P_m + \alpha_F\,F_m \quad [\mathrm{g\ carbohydrate\text{-}equivalent}]
```

with d\_FP = 60 min and τ\_FP = 90 min fixed (they are not identifiable), and α\_P, α\_F dimensionless, so that CSF × E\_m is in mg/dL. For a new user α\_P = α\_F = 0: **the population value is not a mean shift**. What the engine does instead is widen the late interval in proportion to the uncertainty of the amplitude. If α is only known to lie in \[0, α\_max\], its standard deviation is α\_max/√12 ≈ 0.29 α\_max, which gives the added rate variance (0.29 · CSF · (α\_P,max P + α\_F,max F) · f\_FP(t))². No fat or protein threshold has to be chosen.

A user's own α is then estimated by shrunk regression once at least 10 meals with substantial fat or protein have logged outcomes (Section 8), constrained to \[0, α\_max\]. The provisional ceilings α\_P,max = 0.5 and α\_F,max = 0.2 exist only to stop a noisy fit from producing implausible values. I did not find a validated source for them.

### Glycemic index

Why GI is not an input:

1. It is a ratio of two-hour incremental areas against a reference food, measured in healthy volunteers. It says nothing about when the rise happens, and for a person on injected insulin the timing against the insulin is what matters.
2. Within-person variability of GI values is as large as the variability between people (CV 20% against 25% in Matthan 2016; 42.8% against 17.8% in a 2007 Diabetes Care study).
3. Meal composition, portion, processing and ripeness change the response, and glycemic load folds GI and amount into one number that no longer maps onto a kinetic parameter.
4. People respond differently to identical foods (Zeevi 2015, people without diabetes).
5. Using GI to scale carbohydrate grams, then also shifting timing for GI, then also adding fat, counts one phenomenon three times.

If the app wants a speed choice, expose three timing classes. They change τ\_m only and never the total carbohydrate effect:

| Class | τ\_m | Use |
| --- | --- | --- |
| Fast | 0.5 × τ\_m | Liquid sugar, rescue carbohydrate |
| Medium (default) | 1 × τ\_m | Ordinary mixed meals |
| Slow | 1.5 × τ\_m | The user marks a meal as slow |

The ratios 0.5 and 1.5 are engineering starting values, fixed because they are not identifiable. Only τ\_m itself is calibrated.

### Meal parameters

| Parameter | Start | Bounds | Tier | Identifiable? |
| --- | --- | --- | --- | --- |
| τ\_m | 40 min | 25 to 80 | L | Weakly; confounded with insulin peak in meal-plus-bolus pairs |
| Timing-class ratios | 0.5, 1, 1.5 | fixed | E | No |
| CSF | ISF\_0 / ICR | via ISF, ICR | E | Only the net of carbohydrate and insulin effect (Section 8) |
| c\_C | 0.25 | 0.10 to 0.50 | E | Yes, from residual statistics |
| α\_P, α\_F | 0 | 0 to 0.5, 0 to 0.2 | L (direction), N (size) | Only after at least 10 qualifying meals |
| d\_FP, τ\_FP | 60 min, 90 min | fixed | N | No |

The bounds are guardrails I chose, not measured limits.

## Insulin model specification

### Four quantities, four units

Insulin bookkeeping fails when these are mixed up. For a dose U given at t\_j, with s = t − t\_j:

| Quantity | Formula | Unit | Meaning |
| --- | --- | --- | --- |
| Dose | U | U | Delivered insulin |
| Activity | U · a(s) | U/min | How fast the dose is acting right now |
| IOB | U · (1 − A(s)) | U | The part of the dose that has not yet acted |
| Cumulative action | A(s) | unitless | Fraction of the dose that has acted: A(s) = ∫₀ˢ a(u) du |
| Glucose effect | ISF · U · A(s) | mg/dL | Lowering realised so far |

They are tied by Act = −d(IOB)/dt and IOB = U − ∫ Act dt. The correct use of IOB in a forecast is that **ISF × IOB is the fall still to come**, not the fall so far. For a 4 U bolus at ISF 50 and 75 min after the dose (chart below), IOB is 2.69 U, so 135 mg/dL of lowering is still to come and 65 mg/dL has been realised. Reading IOB as if it were the realised effect, or the activity peak as the halfway point, are the two common errors.

&#91;embedded content: exponential insulin kernel, peak 75 min, end 300 min · computed with the reference script from the closed forms below\]

The chart shows why. Activity peaks at 75 min, but only a third of the action has happened by then. IOB falls below half at 105 min.

### Kernel

The two-parameter exponential curve (peak time t\_p, end of action t\_d) as implemented in oref0 and derived by Maksimovic. I write the constant 2τ/t\_d as b to keep it apart from the activity a(s).

```latex
\begin{aligned}
\tau &= \frac{t_p\,(1 - t_p/t_d)}{1 - 2\,t_p/t_d}, \qquad b = \frac{2\tau}{t_d}, \qquad S = \frac{1}{1 - b + (1+b)\,e^{-t_d/\tau}}\\[4pt]
a(s) &= \frac{S}{\tau^{2}}\; s\,\Bigl(1-\frac{s}{t_d}\Bigr)\,e^{-s/\tau} \quad [1/\mathrm{min}], \qquad 0 \le s < t_d\\[4pt]
A(s) &= S\,(1-b)\left[\left(\frac{s^{2}}{\tau\,t_d\,(1-b)} - \frac{s}{\tau} - 1\right)e^{-s/\tau} + 1\right], \qquad A(s \ge t_d) = 1
\end{aligned}
```

The code in oref0 gives the same IOB expression and applies it only for s < t\_d. It requires 0 < t\_p < t\_d/2, which my reference implementation asserts. I checked, numerically, that the area under a(s) is 1.000000, that a(s) peaks at s = t\_p, and that IOB = 1 − A to 4e-11.

| Peak, end | τ (min) | b | S | Peak activity | IOB at 60, 120, 180, 240 min |
| --- | --- | --- | --- | --- | --- |
| 75, 300 (rapid-acting default) | 112.5 | 0.750 | 2.691 | 0.614% per min | 76.4%, 41.1%, 15.9%, 3.3% |
| 55, 300 (ultra-rapid default) | 70.9 | 0.473 | 1.823 | 0.750% per min | 66.8%, 28.8%, 8.8%, 1.5% |
| 75, 360 | 101.8 | 0.565 | 2.083 | 0.571% per min | 77.9%, 45.0%, 20.8%, 7.3% |

These rows are golden vectors for the port (Section 10).

### Defaults and bounds

| Insulin type | t\_p start | t\_p bounds | t\_d start | t\_d bounds |
| --- | --- | --- | --- | --- |
| Rapid-acting analogue | 75 min | 50 to 120 | 300 min | 300 to 480, not fitted |
| Ultra-rapid (Fiasp-type) | 55 min | 35 to 100 | 300 min | 300 to 480, not fitted |

The starting values and the limits on t\_p and t\_d come from the oref0 code and the OpenAPS documentation. The t\_d upper bound of 480 min is mine. Every event stores its insulin type, because two kernels can be active at once. Regular human insulin is not supported in v1. Long-acting basal insulin in multiple-daily-injection users is treated as a constant background that sits in the drift μ(τ), not as events, and a missed or late basal dose is a failure mode (Section 7).

### Basal and extended boluses

- Pump basal: only the deviation from the reference basal is an event (Section 3). A suspension is a negative deviation. Temporary basals are cut into 5-minute micro-doses at segment midpoints.
- Extended or dual-wave boluses: each delivered increment is an event at its delivery time.
- A bolus whose delivery failed or was cancelled is removed by the data layer. The engine does not infer failed delivery, except through the infusion-site check in Section 7.

### What this kernel cannot do, and what is personalised

- **It is an action profile, not plasma concentration.** My check of the Hovorka insulin subsystem (Section 2) gave effect-compartment peaks at 84, 101 and 165 min against this kernel's 75 min. That supports the order of magnitude, not a particular peak, so t\_p is the one kernel parameter that is personalised, within its bounds and with a strong prior. It is identifiable only from correction boluses with no meal and no other active insulin (Section 8).
- **t\_d is fixed.** The tail of the curve carries a few percent of the action and sits below the noise of CGM and other disturbances.
- **Dose independence and superposition are assumed.** Studies across dose ranges show pharmacokinetic and pharmacodynamic properties that change with dose (Heise 2017). I did not extract the numbers. Large doses may act longer than the kernel says, and that is tested as a residual pattern in validation.
- **Within-person variability is real** (Ellingsen 2009; variability reviews). It enters as c\_S, the relative standard deviation of effective sensitivity applied to active insulin: the rate variance of the residual includes (c\_S · ISF · Act(t))². The starting value 0.25 is an engineering default, to be replaced by the fitted value.
- **Time of day** enters through ISF\_0(τ), the user's clinic segments, plus the learned drift in Section 6. Site, wear time, temperature and exercise are not modelled in v1.

## Context specification: exercise, sleep, circadian rhythm

### One rule for all context features

For every context feature the literature gives a direction and a rough size from small or laboratory studies, and a large person-to-person spread. The engine therefore follows the evidence-tier rule of Section 1: the published size is used as an uncertainty scale (a standard deviation), not as a mean shift, until the user's own data move the mean. Variances from independent sources add.

| Feature | Mean forecast in v1 | Uncertainty in v1 | Personalised how |
| --- | --- | --- | --- |
| Time of day and dawn | Learned drift μ(τ), two harmonics | Variance of clean-window rates by time of day | Ridge regression on clean windows |
| Sleep deficit | None | Extra sensitivity variance | After enough contrasting nights |
| Exercise, acute | Decaying uptake state, prior mean from T1DEXI | Prior SD from T1DEXI | Updated session by session |
| Exercise, delayed sensitivity | None (amplitude prior mean 0) | Extra sensitivity variance for hours, plus a late-low flag | After enough sessions |
| Illness, stress, alcohol, menstrual cycle | None | A user flag raises sensitivity variance and sets the trust to degraded | Not in v1 |

### Time of day and the dawn phenomenon

The baseline drift is glucose change per minute with no meal and no extra insulin on board. It captures a basal rate that is slightly too high or low, the dawn rise, and the evening fall, all relative to the reference basal.

```latex
\mu(\tau) = d_0 + \sum_{k=1}^{2}\Bigl[a_k\cos\frac{2\pi k\tau}{1440} + b_k\sin\frac{2\pi k\tau}{1440}\Bigr] \quad [\mathrm{mg/dL/min}], \qquad \theta_\mu=(d_0,a_1,b_1,a_2,b_2)\sim\mathcal N(0,\sigma_\mu^2 I)
```

Two harmonics resolve features of about 3 to 4 hours, enough for a dawn rise of several hours. A third harmonic is added only if it improves held-out error. The prior σ\_μ = 0.1 mg/dL/min is an engineering default (0.1 mg/dL/min is 6 mg/dL per hour) to be refitted.

**Clean windows** are the only data used to fit μ: no meal in the previous 5 h, no bolus in the previous t\_d, no exercise in the previous 24 h, and CGM present. In them, the smoothed rate of change of CGM glucose (corrected for the sensor lag) estimates μ(τ) plus noise. Fitting is ridge regression with a robust loss (Huber). The posterior standard deviation of μ and the variance of clean-window rates around it, binned by time of day and shrunk to the pooled value, give σ\_d²(τ). This variance enters the rate disturbance in Section 7. It carries the night-to-night variability: dawn rise was present in all tested subjects but in a median of only 56% of nights, so the profile describes the average night, and the filter handles the rest.

Insulin sensitivity by time of day comes from the user's clinic segments ISF\_0(τ) and ICR(τ). There is no second learned sensitivity profile in v1. Visentin's circadian work models one with 7 classes and deviations up to 40% (the 40% is the simulator's choice, not a clinical measurement). A learned sensitivity profile is a v2 candidate, because it competes with μ for the same overnight data.

DST and time zones: τ is computed from the stored offset of each timestamp. After travel the profile keeps its local-time shape and the filter absorbs the mismatch. A shift of more than 3 hours between the offset of recent data and the learned profile sets the trust to degraded for 3 days.

### Sleep

One night of 4 hours of sleep lowered peripheral insulin sensitivity by about 21% in 7 people with type 1 diabetes (Donga 2010), against a night of about 8 hours in a laboratory study. Free-living size, dose-response and persistence are not known. In v1 sleep changes only uncertainty:

```latex
\delta_{sleep} = \min\!\Bigl(\frac{\max(0,\;T_{ref} - T_{sleep})}{4},\;1\Bigr),\qquad c_{S,eff}^{2} = c_S^{2} + (c_{sl}\,\delta_{sleep})^{2} + (c_x\,w(t))^{2} + (c_{ill}\,I_{flag})^{2}
```

T\_ref is the person's median sleep over the previous 14 nights (a personal norm, not a population 8 hours), T\_sleep is the last night in hours, and c\_sl = 0.2 takes its size from the published 21% as a standard deviation. After at least 5 nights with a deficit of more than 1 hour and 5 without, a shrunk regression of the next day's sensitivity residual on δ\_sleep can give a personal mean effect. That belongs to the calibration stage (Section 8). Sleep timing, quality and stages are not used.

### Exercise

Two states respond to an intensity signal e(t), the fraction of heart-rate reserve when a heart-rate stream exists, otherwise a class mapped to 0.3 (light), 0.5 (moderate) or 0.75 (vigorous). These mappings follow common exercise-physiology bands and are engineering defaults, not verified here.

```latex
\begin{aligned}
\dot u_x &= \frac{e(t) - u_x}{\tau_a}, & \frac{d\,\Delta G_{ex}}{dt} &= -\kappa_{type}\,u_x(t) \quad [\mathrm{mg/dL/min}]\\
\dot w &= -\frac{w}{\tau_{sx}} + \frac{\int e\,dt\ (\text{session})}{L_{med}}\,\delta(t - t_{end}), & s_x(t) &= \beta_x\,w(t)
\end{aligned}
```

u\_x is the insulin-independent acute uptake, which rises within minutes and decays with τ\_a = 20 min. w is a dimensionless recent-load state: each session adds its load relative to the user's median session load L\_med (1 for a typical session) and the state decays with τ\_sx = 12 h (bounds 3 to 36 h). s\_x enters ISF as exp(s\_x) in Section 3, with amplitude β\_x whose prior mean is 0 in v1. The decay times are engineering values: the evidence says hours to a day or more, with most late-onset lows at 15 to 24 hours, and no time constant is established.

For the acute term, κ\_type is initialised so that a typical session of the user (or 30 minutes at moderate intensity if there is no history) produces the T1DEXI mean change, with the T1DEXI standard deviation as prior SD:

| Type | Mean change in a session | Prior SD | Sign certain? |
| --- | --- | --- | --- |
| Aerobic | −18 mg/dL | 39 | No: SD is more than twice the mean |
| Interval | −14 mg/dL | 32 | No |
| Resistance | −9 mg/dL | 36 | No: SD is four times the mean |

The prior is almost uninformative, and that is the honest reading of T1DEXI: the data support "lowers on average", not a number for one person. Each logged session therefore updates κ\_type by shrunk regression (Section 8) and the first few sessions dominate.

Two limits are deliberate. First, the acute effect does not depend on insulin on board or starting glucose, although the consensus guidance on reducing insulin before exercise implies such a dependence. Insulin-dependent effects can enter only through s\_x, whose mean is 0 in v1. Second, the late-onset lows are handled as a flag and a wider lower tail, not a mean shift. When w > 0.3 within 36 hours of a session, the app raises a late-low-risk flag, and the quantile scaling uses its own bin for post-exercise windows (Section 7).

### Parameters

| Parameter | Start | Bounds | Tier | Identifiable? |
| --- | --- | --- | --- | --- |
| θ\_μ (5 coefficients) | 0 | ±0.3 mg/dL/min each | L | Yes, with about 14 days of clean nights |
| σ\_μ | 0.1 mg/dL/min | fixed | E | Prior scale |
| c\_sl | 0.2 | fixed | L | No |
| κ\_aero, κ\_int, κ\_res | from T1DEXI means | prior mean ± 2 prior SD, so the sign can flip | L | Weakly, one data point per session |
| τ\_a | 20 min | 10 to 40 | E | No |
| β\_x, τ\_sx | 0, 12 h | 0 to 0.3; 3 to 36 h | L / N | β\_x after enough sessions; τ\_sx not |
| c\_x, c\_ill | 0.2, 0.3 | fixed | E | No |

Bounds, starting uncertainty scales and decay times in this table are my choices, not measurements. The ablations in Section 11 decide which of them survive.

## Online state estimation

### State and model

The filter state is x = \[IG, z, r\]: sensor glucose, residual level, and residual rate in mg/dL/min. The nominal path m(t) from Section 3 is a known input, so the system is linear and the Kalman filter is exact under Gaussian noise.

```latex
\begin{aligned}
\dot{IG} &= \frac{m(t) + z - IG}{\tau_s}, \qquad \dot z = r + w_z, \qquad \dot r = -\frac{r}{\tau_r} + w_r\\
y_k &= IG(t_k) + v_k, \qquad v_k \sim \mathcal N(0, R_k)
\end{aligned}
```

The residual rate r is a damped trend: a persistent disturbance of the rate of change, decaying with τ\_r (start 30 min). It is also where input uncertainty enters. Exact discretisation over Δ = 5 min with m held at its step midpoint m̄\_k = (m\_k + m\_{k+1})/2, which is accurate to second order in Δ:

```latex
\begin{aligned}
x_{k+1} &= F\,x_k + g\,\bar m_k + w_k, \qquad F=\begin{pmatrix} a & 1-a & c\\ 0 & 1 & \tau_r(1-\rho)\\ 0 & 0 & \rho\end{pmatrix}, \qquad g=\begin{pmatrix}1-a\\0\\0\end{pmatrix}\\
a &= e^{-\Delta/\tau_s}, \quad \rho = e^{-\Delta/\tau_r}, \quad c = \tau_r\Bigl[(1-a) - \frac{\rho - a}{1 - \tau_s/\tau_r}\Bigr]\\
Q_k &= q_z\,Q_z + q_{r,k}\,Q_r, \qquad Q_z, Q_r \text{ from unit-intensity noise on } z \text{ and } r
\end{aligned}
```

Q\_z and Q\_r are constant for a given (τ\_s, τ\_r, Δ): compute them once per parameter set with the Van Loan matrix-exponential method, using a 3×3 matrix exponential (a scaled Taylor series is exact to machine precision at these sizes). I checked the closed form of F against the matrix exponential to 3e-15. With the defaults τ\_s = 8 min and τ\_r = 30 min:

|  | Value |
| --- | --- |
| F | \[\[0.535261, 0.464739, 1.210418\], \[0, 1, 4.605548\], \[0, 0, 0.846482\]\] |
| Q\_z | \[\[0.418164, 1.282091, 0\], \[1.282091, 5, 0\], \[0, 0, 0\]\] (closed forms: Δ = 5; Δ − τ\_s(1−a) = 1.2821; Δ − 2τ\_s(1−a) + (τ\_s/2)(1−a²) = 0.4182) |
| Q\_r | \[\[1.596163, 7.456607, 1.901657\], \[7.456607, 36.840451, 10.605537\], \[1.901657, 10.605537, 4.252030\]\] |

These are golden vectors for the port. For Q\_r, Q\_r\[2,2\] / (1 − ρ²) = τ\_r / 2 = 15, the stationary variance of a unit-intensity damped rate.

**Process noise carries the physics of uncertainty.** The rate disturbance has variance

```latex
\sigma_{rate,k}^{2} = \sigma_{r0}^{2} + (c_C\,CSF\,Ra_k)^{2} + (c_{S,eff}\,ISF\,Act_k)^{2} + \bigl(0.29\,CSF\,(\alpha_P^{max}P + \alpha_F^{max}F)\,f_{FP,k}\bigr)^{2} + \sigma_d^{2}(\tau_k), \qquad q_{r,k} = \frac{2\,\sigma_{rate,k}^{2}}{\tau_r}
```

in (mg/dL/min)². The terms are the unexplained part of the rate of change when no input is active (σ\_r0), carbohydrate-count error times the meal appearance rate (Section 4), sensitivity error times insulin activity (Sections 5 and 6), the delayed fat and protein amplitude uncertainty (Section 4), and the time-of-day variability (Section 6). The factor 2/τ\_r makes the stationary variance of r equal σ²\_rate. Starting values q\_z = 0.02 mg²/dL² per min and σ\_r0 = 0.05 mg/dL/min are engineering defaults.

**Measurement noise.** R\_k = σ\_v² with a starting σ\_v = 3 mg/dL, estimated as Var(second difference of y) / 6 in quiet clean windows (for white noise the second difference has variance 6σ²). A MARD of 8 to 9% (Garg 2022 for the G7) is not used as a white-noise level: MARD also contains slowly varying bias, and treating that as independent from reading to reading would let the filter trust repeated readings too much. An autoregressive bias state is the extension if innovation autocorrelation shows it is needed.

### Recursions

```latex
\begin{aligned}
&\textbf{predict:}\quad x^- = F x + g\,\bar m_k, \qquad P^- = F P F^{\top} + Q_k\\
&\textbf{update:}\quad S = P^-_{00} + R_k, \quad \nu = y_{k+1} - x^-_0, \quad K = P^-_{:,0}/S\\
&x = x^- + K\nu, \qquad P = (I-KH)P^-(I-KH)^{\top} + K R_k K^{\top}, \qquad H=(1\ 0\ 0)
\end{aligned}
```

**Initialisation.** x\_0 = \[y\_0, y\_0, 0\] (because m\_0 = 0), with level standard deviation 25 mg/dL on both IG and z and fully correlated, and rate standard deviation 0.3 mg/dL/min.

**Missing data.** A missing reading means predict only. After a gap of more than 3 hours the filter restarts at the next reading. Libre-style sensors that give 1-minute or 15-minute data are mapped to the 5-minute grid by taking the last reading in each bin.

**Outliers and compression artefacts.** If |ν| > 4√S the reading is skipped. If three readings in a row are skipped (15 minutes) and the next one is also outside the gate, it is taken as a real level change: the filter adds a variance of 50² (mg/dL)² to IG and z together, fully correlated, and accepts the reading. A reading inside the gate after skips is processed normally. Updates that used the level jump are kept out of the NIS statistic.

**Late, edited and deleted entries.** There is no special handling: store the event with the time the user states, and replay the window. At 144 steps this costs very little.

**Forecast.** From the filtered x\_K and P\_K, run the predict step for j = 1 to 36 with the known events (past doses still acting, logged future doses, any what-if event). The predictive distribution of the CGM reading at h = 5j minutes is N(x\_0, P\_00 + R).

### Why a linear Kalman filter, and when something else

| Estimator | Use when | Cost | Verdict here |
| --- | --- | --- | --- |
| Linear Kalman filter | Linear in the state given parameters (this model) | Tiny; exact | **v1** |
| EKF | Mild nonlinearity: glucose-dependent uptake, renal loss, Hovorka's bilinear terms | Jacobians; tuning | Only if a nonlinear core is adopted |
| UKF | Stronger nonlinearity, no Jacobians (published with Hovorka) | 2n+1 model runs per step | Comparator in validation |
| Particle filter | Multimodal posteriors, discrete hypotheses such as an unannounced meal | Heavy, random | Only for a future meal-detection state |
| Joint state and parameter filtering | Parameters drift fast and are identifiable | Fragile | Not v1 (identifiability, Section 8) |

### State updates versus parameter updates

|  | State | Parameter |
| --- | --- | --- |
| Examples | IG, z, r | ISF, ICR, t\_p, τ\_m, μ coefficients, κ, c\_C, c\_S |
| Time scale | Every reading or event | Daily to weekly |
| Method | Kalman filter | Bounded, shrunk, rate-limited estimation (Section 8) |
| Reason | The residual absorbs short-term model error | Parameters confounded in one meal-plus-bolus pair cannot be separated online |

### Calibrated uncertainty

1. The filter gives ŷ\_h and σ\_h² = P\_00 + R at each horizon.
2. For every past forecast, store the standardised error e\_i(h) = (y\_{t\_i+h} − ŷ\_i(h)) / σ\_i(h) once the outcome is known.
3. Quantiles of e over the last 60 days (at least 500 per horizon, newest weighted more) give the interval: ŷ + q\_p σ. Using signed quantiles keeps the interval asymmetric when errors are skewed.
4. Bins: post-meal (COB > 0), post-bolus without meal, fasting or night, post-exercise (w > 0.3), high start glucose. If a bin has too few errors, back off to the horizon-only quantile.
5. Monitor coverage per horizon over rolling 7 days. If the nominal 80% interval covers less than 70% or more than 90%, the trust level is degraded and the quantile scale is re-tracked.

The guarantee behind split-conformal intervals needs exchangeable errors. Forecast errors from one person's glucose are autocorrelated and nonstationary, so the engine claims no finite-sample coverage. Rolling windows, bins and monitoring are mitigations, and the validation plan measures coverage rather than assuming it.

My synthetic implementation test (Section 11) shows why the recalibration step exists: with deliberately mismatched true parameters, nominal Gaussian 90% intervals covered 94%, 90%, 83%, 78%, 73% and 66% at 15, 30, 60, 90, 120 and 180 minutes, and the standard deviation of the standardised error grew from 0.84 to 1.78. That world is generated from the same model family, so it shows the mechanism, not real-world coverage.

### Output structure

```json
{
  "issued_at": "2026-10-16T17:40:00Z", "anchor_time": "2026-10-16T17:35:00Z",
  "model_version": "b-min-1.0", "param_version": "u123-2026-10-15",
  "units": "mg/dL", "grid_min": 5, "horizon_min": 180,
  "points": [ {"h": 5, "mean": 143.1, "q05": 136.0, "q25": 140.2, "q50": 143.0, "q75": 146.1, "q95": 151.0}, "... one per 5 min ..." ],
  "key_horizons": {"15": {}, "30": {}, "45": {}, "60": {}, "90": {}, "120": {}, "180": {}},
  "components_mg_dl": {"insulin": [], "meal": [], "context": [], "residual": []},
  "state": {"iob_u": 2.7, "cob_g": 18.0, "insulin_activity_u_per_min": 0.021, "residual_level": 4.2, "residual_rate": 0.05},
  "risk": {"p_below_70": {"30": 0.01, "60": 0.04}, "p_below_54": {}, "p_above_250": {}, "late_low_flag": false},
  "trust": {"level": "normal", "reasons": [], "nis_ewma": 1.1, "cgm_coverage_6h": 0.97, "clipped": false},
  "inputs_used": {"boluses": 3, "meals": 1, "exercise": 0, "sleep_last_night_h": 6.5}
}
```

Probabilities such as p\_below\_70 come from the calibrated quantile curve by interpolating the empirical distribution of the standardised error, and they are not reported below 2.5% or above 97.5% because the tails are not resolved. The component arrays let the app explain a forecast ("mostly the meal you logged, offset by 2.7 U on board") instead of showing a bare line.

### Failure modes and loss of trust

| Failure | Signature | Detection | Response |
| --- | --- | --- | --- |
| CGM gaps | Missing readings | Coverage in last 6 h; gap length | Over 15 min or coverage below 70%: degraded. Over 60 min: unreliable. Over 3 h: restart |
| Compression lows, sensor artefact | Sudden fall, fast recovery | Gated innovations | Skip; a fourth outlier in a row is accepted with a level jump |
| Sensor drift or noise | Innovation variance up | NIS EWMA outside \[0.3, 2.5\] for 30 min | Degraded; log device |
| Meal or bolus not logged | Unexplained rise or fall | Standardised rate over 2.5 SD for 45 min with no matching event | Prompt the user; degraded beyond 60 min |
| Wrong carb count | Post-meal error grows with absorption | Residual rate sign after 60 min | Already widened by c\_C; flag a pattern after 3 meals |
| Infusion-site or delivery failure | Persistent rise despite boluses | Positive r above 0.5 mg/dL/min for 90 min with IOB > 0 | Informational flag |
| Basal or profile change | Drift changes shape | μ residual by hour | Re-reference μ, shrink it halfway to 0 |
| Illness, stress, alcohol, unlogged exercise | Persistent bias or late low | Innovation CUSUM over two meals | User flag raises c\_S; degraded |
| Time zone or clock error | Events offset | Offset change of 3 h or more | Degraded for 3 days |
| Entry typos, duplicates | Implausible dose; double entries from two sources | Caps and de-duplication by type, time ±2 min, amount | Ask to confirm; drop duplicates |
| Parameter drift (weight, new insulin) | Slow bias | Rolling bias by horizon; champion–challenger | Recalibrate (Section 8) |

The trust level is one of **normal** (full forecast), **degraded** (full forecast with a flag and the reasons) and **unreliable** (only the short-term trend up to 30 minutes, with the reason). Thresholds in this table are engineering starting values: the synthetic test gave a mean NIS of 0.52 in a misspecified world, so a low NIS is also a warning (intervals too wide), which is why the monitor is two-sided.

## Personalization plan

### What is calibrated, and how

The nonlinear search covers only **four parameters**. Everything else is either fixed, or fitted by a separate linear or statistical step that uses the right kind of data.

| Parameter | Meaning | Method | Data it needs | Prior and bounds |
| --- | --- | --- | --- | --- |
| s\_ISF | Scale on the clinic ISF profile | Bounded MAP search | Correction boluses | log s \~ N(0, 0.3²), 0.6 to 1.6 |
| s\_CSF | Scale on CSF = ISF\_0 / ICR | Bounded MAP search | Rescue carbohydrate; meals with bolus | log s \~ N(0, 0.3²), 0.6 to 1.6 |
| t\_p | Insulin peak | Bounded MAP search | Correction boluses | N(prior, 10² min), per Section 5 bounds |
| τ\_m | Meal timing | Bounded MAP search | Rescue carbohydrate; low-fat meals | log-normal around 40 min, sd 0.25, 25 to 80 |
| θ\_μ | Drift profile (5 coefficients) | Ridge regression, Huber loss | Clean windows | Section 6 |
| κ\_aero, κ\_int, κ\_res | Acute exercise gain | Shrunk regression on session residuals | Logged sessions | Section 6 |
| α\_P, α\_F | Fat and protein amplitude | Shrunk non-negative regression on late residuals | At least 10 meals with substantial fat or protein | Section 4 |
| β\_x, β\_sleep | Delayed sensitivity effects | Shrunk regression on next-day ISF residual | Enough contrasting days | Section 6 |
| c\_C, c\_S, σ\_r0, q\_z, σ\_v, τ\_r | Noise and persistence | Innovation and standardised-error statistics | Any data | Section 7 |
| t\_d, τ\_s, d\_FP, τ\_FP, class ratios, τ\_a | Not identifiable | **Fixed** |  |  |

The prior widths and the 0.6 to 1.6 bounds are my engineering choices. The bounds are a guardrail against a bad fit, in the spirit of the ±40% deviations the UVA/Padova simulator uses, not a measured limit.

The user-facing settings follow from the scales: ISF\_eff = s\_ISF · ISF\_0, CSF\_eff = s\_CSF · CSF\_0, and therefore ICR\_eff = ICR\_0 · s\_ISF / s\_CSF. These are *effective* values. s\_CSF also absorbs the user's average carbohydrate-counting bias, so it is a property of the person together with the way they count, not pure physiology. If the way of counting changes (a photo app instead of a label), expect a bias in post-meal residuals and a recalibration.

### Objective: fit the forecast, not the one-step innovation

One-step (5-minute) innovations are dominated by sensor noise and are almost insensitive to ISF or CSF. The filter also hides parameter error in z and r. So parameters are fitted on **multi-step forecast error from the full engine**:

```latex
L(\theta) = \sum_{i \in \text{anchors}}\ \sum_{h \in \{30,60,90,120,180\}} w_i\, \rho_H\!\Bigl(\frac{y_{t_i+h} - \hat y_i(h;\theta)}{\sigma_h}\Bigr) \;+\; \tfrac12\sum_j \frac{(\theta_j - \theta_{0,j})^2}{\sigma_{\theta,j}^2}
```

Here ρ\_H is the Huber loss with threshold 1.5, σ\_h is the per-horizon scale of past errors, w\_i weights newer anchors more (half-life 14 days), and anchors are taken every 15 minutes over the last 28 days, with a minimum of 14. Optimisation is bounded Nelder–Mead or L-BFGS-B on the four log-parameters. A parameter-set evaluation replays the window, which at this size takes well under a second in compiled or vectorised code. Alternate once: fit θ with noise parameters fixed, then refit noise parameters from the standardised errors with θ fixed.

### Data conditions that make a parameter identifiable

| Window type | Definition | Identifies |
| --- | --- | --- |
| Correction | Bolus of at least 1 U, no carbohydrate from 60 min before to 240 min after, start glucose above 140 mg/dL, no exercise in 12 h | s\_ISF, t\_p |
| Rescue carbohydrate | At least 10 g with no bolus for the previous 3 h and next 1 h | s\_CSF, τ\_m (fast class) |
| Meal with bolus | Carbohydrate and bolus within 20 min of each other | Only the net of the two gains; it separates them weakly through the different shapes of A and F |
| Clean night or fasting | Section 6 | θ\_μ |

The thresholds are engineering starting values. Rescue-carbohydrate episodes are natural experiments for the carbohydrate gain because the insulin effect is already in the past, and they are rare, which is why s\_CSF usually moves slowly.

**Confounded pairs and what is done about them**

| Pair | Why confounded | Treatment |
| --- | --- | --- |
| s\_ISF and s\_CSF | A paired meal and bolus gives one net curve | Fit by window type; information gate below |
| t\_p and τ\_m | Both shift the timing of the net effect | Prior-heavy; τ\_m also informed by rescue carbohydrate |
| μ and the residual level z | Both are slow offsets | μ fitted only in clean windows, z only filtered |
| s\_ISF and delayed sensitivity effects | Both scale insulin action | Delayed effects have prior mean 0 and are fitted on the residual of the calibrated s\_ISF |
| α (fat, protein) and s\_CSF | Both scale late carbohydrate effect | α fitted on the late residual of meals after s\_CSF is set |
| τ\_s and t\_p, τ\_m | All delays add | τ\_s fixed by device |

### Guardrails

1. **Information gate.** From the Gauss–Newton approximation Σ\_post = (JᵀWJ + Σ\_prior⁻¹)⁻¹, compute for each parameter the information ratio 1 − Σ\_post,jj / Σ\_prior,jj. If it is below 0.3, keep the previous value. The data did not say enough.
2. **Rate limit.** No log-parameter moves more than 0.1 per week, so the nightly run is limited to 0.1/7.
3. **Champion and challenger.** The new set is scored on the last 3 days, which were not used to fit, and replaces the current one only if RMSE at 60 and 120 minutes improves by at least 3% and interval coverage is not worse. Thresholds are placeholders to be fixed in the validation protocol before any user data are touched.
4. **Rollback.** Keep the last three parameter sets. If rolling 7-day RMSE at 60 minutes is more than 15% worse than the champion's own history, roll back and flag.
5. **Data sufficiency.** Update only with at least 70% CGM coverage and, for the nonlinear search, at least 8 qualifying windows of the relevant type.

### Cold start and fallbacks

- Days 0 to 7: clinic ISF and ICR by time of day, insulin-type defaults, μ = 0, default noise. No calibration. The interval table is the population quantile table (from the validation datasets), blended with the user's own by weight n / (n + 200).
- If the user has no clinic ISF or ICR, the common rules of thumb are ISF\_0 = 1800 / TDD and ICR\_0 = 500 / TDD in mg/dL and grams, with TDD the total daily insulin dose. I treat them as engineering fallbacks, I did not verify their sources, and the app should ask the user to confirm them.
- Population priors for the four core parameters and the noise parameters come from the validation datasets (Section 11), with per-user values shrunk toward them by empirical Bayes.

### Where it runs

The core search has four parameters and replays at most 28 days, so it can run on the phone in the TypeScript port. The server runs the identical code for research and for evaluating challengers.

## Pseudocode

Language-neutral, Python-flavoured. Units are in the comments. I wrote a runnable reference of the kernels, the filter matrices and the three-state filter (about 150 lines of Python) to check the equations; it leaves out the context terms, fat and protein, and calibration, which are specified here only.

### 1. Kernels and the nominal path

```python
DT, H = 5.0, 36                       # grid step [min]; forecast steps (180 min)

def insulin_consts(tp, td):           # [min]; requires 0 < tp < td/2
    tau = tp * (1 - tp/td) / (1 - 2*tp/td)
    b   = 2 * tau / td
    S   = 1 / (1 - b + (1 + b) * exp(-td/tau))
    return tau, b, S

def A(s, tp, td):                     # cumulative insulin action [-]
    if s <= 0:  return 0.0
    if s >= td: return 1.0
    tau, b, S = insulin_consts(tp, td)
    return S*(1-b) * ((s*s/(tau*td*(1-b)) - s/tau - 1) * exp(-s/tau) + 1)

def act(s, tp, td):                   # activity a(s) [1/min]; used for plots and checks
    if s <= 0 or s >= td: return 0.0
    tau, b, S = insulin_consts(tp, td)
    return S / tau**2 * s * (1 - s/td) * exp(-s/tau)

def F_meal(s, tau_m):                 # cumulative meal absorption [-]
    return 0.0 if s <= 0 else 1 - (1 + s/tau_m) * exp(-s/tau_m)

def effects(ev, p, t_w, n):           # nominal path m (n+1 values) and per-step inputs, all mg/dL, U, g
    m, mbar, ACT, RA, FPRA = [0.0], [], [], [], []
    for k in range(n):
        t0, t1 = t_w + k*DT, t_w + (k+1)*DT
        tmid   = t0 + DT/2
        tod    = local_minutes_of_day(tmid, ev.tz_offset_at(t0))
        isf0, icr = clinic_isf(tod), clinic_icr(tod)          # clinic profiles by time of day
        isf = p.s_isf * isf0 * exp(ctx.s_x(tmid))             # sensitivity modifiers multiply insulin only
        csf = p.s_csf * isf0 / icr                             # never the modifier
        dU  = sum(u * (A(t1-tj, tpj, p.td) - A(t0-tj, tpj, p.td)) for tj, u, tpj in ev.insulin)       # [U]
        dC  = sum(c * (F_meal(t1-tm, tau) - F_meal(t0-tm, tau)) for tm, c, tau in ev.meals)             # [g]
        dE  = sum(E * (F_meal(t1-tm-D_FP, T_FP) - F_meal(t0-tm-D_FP, T_FP)) for tm, E in ev.fp)      # [g carb-equiv]
        dX  = (mu(tod) - ctx.uptake(tmid)) * DT                # drift minus acute exercise uptake [mg/dL]
        m.append(m[-1] - isf*dU + csf*(dC + dE) + dX)
        mbar.append(0.5 * (m[-2] + m[-1]))
        ACT.append(dU/DT);  RA.append(dC/DT);  FPRA.append(dE/DT)
    return m, mbar, ACT, RA, FPRA
```

### 2. Reconstruct, filter and forecast

```python
LEVEL_JUMP = 50**2 * [[1,1,0],[1,1,0],[0,0,0]]               # level jump added to IG and z together

def sigma_rate2(k, p, eff, tod):                              # (mg/dL/min)^2, Section 7
    csf, isf = p.s_csf*clinic_isf(tod)/clinic_icr(tod), p.s_isf*clinic_isf(tod)
    return (p.sigma_r0**2
          + (p.c_C * csf * eff.RA[k])**2
          + (c_S_eff(k, p) * isf * eff.ACT[k])**2
          + (0.29 * csf * fp_load_max(k, p) * eff.FPRA_unit[k])**2   # amplitude-uncertainty term
          + sigma_d2(tod))

def run(now, cgm, ev, p):
    t_w  = grid_floor(now) - 720.0                            # 12 h window
    n    = int((grid_floor(now) - t_w) / DT)
    y    = bin_to_grid(cgm, t_w, n + 1)                       # last reading per bin; NaN if none
    eff  = effects(ev.load(from_time=t_w - 360.0), p, t_w, n + H)
    Fm, Qz, Qr = cached_matrices(p.tau_s, p.tau_r)            # Van Loan, once per parameter set
    g    = [1 - exp(-DT/p.tau_s), 0.0, 0.0]
    x, P = [y[0], y[0], 0.0], init_cov(level_sd=25.0, rate_sd=0.3)
    skips, nis = 0, []
    for k in range(n):                                        # replay history
        x = Fm @ x + g * eff.mbar[k]
        P = Fm @ P @ Fm.T + p.q_z*Qz + (2*sigma_rate2(k, p, eff, tod(k)) / p.tau_r) * Qr
        if not isnan(y[k+1]):
            S, nu = P[0,0] + p.sigma_v**2, y[k+1] - x[0]
            outlier = abs(nu) > 4*sqrt(S)
            if outlier and skips < 3:
                skips += 1                                    # gate outlier or compression artefact
                continue
            if outlier:                                       # persistent change is real
                P = P + LEVEL_JUMP;  S = P[0,0] + p.sigma_v**2
            K = P[:,0] / S;  x = x + K*nu
            IKH = I - outer(K, [1,0,0]);  P = IKH @ P @ IKH.T + outer(K,K) * p.sigma_v**2
            skips = 0
            if not outlier:  nis.append(nu*nu / S)           # level-jump updates stay out of NIS
    mean, sd = [], []
    for j in range(H):                                        # propagate with known future events
        k = n + j
        x = Fm @ x + g * eff.mbar[k]
        P = Fm @ P @ Fm.T + p.q_z*Qz + (2*sigma_rate2(k, p, eff, tod(k)) / p.tau_r) * Qr
        mean.append(x[0]);  sd.append(sqrt(P[0,0] + p.sigma_v**2))
    return mean, sd, nis, eff
```

### 3. Intervals, trust and daily calibration

```python
def calibrated_interval(mean, sd, bin_, store, probs):          # Section 7, steps 2 to 4
    out = []
    for j in range(H):
        h = 5 * (j + 1)
        e = store.std_errors(h, bin_, days=60, min_n=500) or store.std_errors(h, 'all', days=60, min_n=500)
        out.append({q: mean[j] + weighted_quantile(e, q) * sd[j] for q in probs})
    return out

def trust_level(nis, cgm_cov_6h, gap_min, cov_7d, flags):
    reasons = []
    if gap_min > 15 or cgm_cov_6h < 0.70:  reasons.append('cgm_gap')
    if not (0.3 <= ewma(nis, lam=0.1) <= 2.5):  reasons.append('innovation_out_of_range')
    if not (0.70 <= cov_7d['80%'] <= 0.90):     reasons.append('coverage_drift')
    reasons += flags                                           # clipped, tz_shift, illness flag, plausibility
    if gap_min > 60:  return 'unreliable', reasons             # short-term trend only (<= 30 min)
    return ('degraded' if reasons else 'normal'), reasons

def calibrate(user, now):                                      # nightly; Section 8
    data = user.last_days(28)
    if data.cgm_coverage < 0.70 or data.n_windows() < 8:  return user.params
    th0  = user.params.core()                                  # (log s_isf, log s_csf, log tp, log tau_m)
    th   = bounded_minimize(lambda t: loss(t, data), th0, BOUNDS)   # multi-horizon Huber + prior
    Sig  = inv(J(th).T @ W @ J(th) + inv(SIG_PRIOR))
    for j in range(4):                                         # information gate and rate limit (STEP = 0.1/7 per run)
        info = 1 - Sig[j,j] / SIG_PRIOR[j,j]
        th[j] = th0[j] if info < 0.3 else clip(th[j], th0[j] - STEP[j], th0[j] + STEP[j])
    cand = user.params.with_core(th).with_side_fits(data)      # mu, kappa, alpha, noise
    if beats(cand, user.params, data.last_days(3), min_gain=0.03, horizons=(60, 120)):
        user.push_params(cand)                                 # keep last 3 for rollback
    return user.params
```

The function `fp_load_max` is α\_P,max · P + α\_F,max · F for the meal that produced step k, `c_S_eff` is the combined sensitivity uncertainty of Section 6, and `sigma_d2` is the time-of-day variance of Section 6.

## Implementation roadmap

### Phases

Each phase has an exit criterion, and nothing moves on until it is met. The pass thresholds belong in a validation protocol written before any user data is touched (Section 11).

| Phase | What is built | Exit criterion |
| --- | --- | --- |
| P0. Data contract | Event schema (UTC seconds, stored time-zone offset, type, id, insulin type, source), CGM-to-grid mapping, de-duplication, unit conversion, input sanity caps | Replaying the same stored history twice gives byte-identical engine inputs |
| P1. Approach A | Kernels, nominal path, anchored simulator, offline evaluation harness on OhioT1DM, baselines (persistence, constant-rate extrapolation) | Kernel and G1 golden vectors pass; harness reproduces baseline RMSE by horizon |
| P2. Approach B core | Three-state filter, Van Loan matrices, noise fit, calibrated intervals, trust monitor | B beats A and the baselines at every horizon on held-out time for a pre-registered share of people |
| P3. TypeScript port | Same engine in TypeScript, golden-vector CI, offline use on the phone | Parity tolerances below pass in CI on every commit |
| P4. Personalisation | Four-parameter calibration with gates, side fits, champion and challenger, rollback | Improves held-out final weeks against no calibration, with no regression in coverage |
| P5. Context | Drift μ, exercise, sleep uncertainty, fat and protein, each as an ablation | Each feature stays only if held-out error or coverage improves |
| P6. Shadow mode | Live forecasts logged and scored without being shown | Prospective coverage and RMSE match offline results within pre-registered margins |
| P7. Approach C | One extra latent state at a time (per-meal carbohydrate error first) | Gate in Section 11 passed on a named failure mode |

### Module map

- **core**: pure functions with no I/O: kernels, effects, filter, intervals, trust monitor. This is what must match across languages.
- **calib**: batch loss, optimiser, side fits. Same code on server and phone, parity to looser tolerance.
- **data**: source adapters, canonicalisation, de-duplication, grid mapping.
- **eval**: dataset loaders, metrics, ablation runner.

The API is a pure function of (CGM history, events, parameter set, now), so the server and the offline phone call the same entry point and return the output structure of Section 7.

### Python and TypeScript parity

1. **One source of truth.** This specification, with Python as the research implementation and TypeScript ported from it. Shared JSON fixtures live in one repository: inputs (events, CGM, parameters, now) and expected outputs, all generated by Python.
2. **Numerics.** float64 only (a JavaScript `number` is float64; never a `Float32Array`). Integer seconds for event times, converted to minutes by one division. No `Date` object inside the core, because daylight-saving rules differ between runtimes: time of day comes from the stored integer offset. Sum events in ascending time order in both languages.
3. **Matrices.** F in closed form (Section 7). Q\_z and Q\_r from a scaled Taylor-series matrix exponential, with the same scaling rule and term count in both languages, checked against the golden values below. Do not call library `inv` or `expm` in one language and a hand-written version in the other.
4. **Tolerances.** Kernels: relative 1e-9. Nominal path and filter state: absolute 1e-6 mg/dL. Calibrated parameters (search is iterative): relative 1e-3. Bit equality is not expected, because `exp` may differ by one unit in the last place between runtimes.
5. **Determinism.** No random numbers in the engine. Calibration uses fixed starting points, fixed tolerances and a fixed iteration cap.

### Golden vectors

| ID | Content | Where |
| --- | --- | --- |
| G0 | Kernel values and constants for (75, 300), (55, 300), (75, 360) | Section 5 |
| G1 | 4 U + 40 g nominal path at 30 to 300 min | Section 3 |
| G2 | F, Q\_z, Q\_r for τ\_s = 8, τ\_r = 30 | Section 7 |
| G3 | Full pipeline on a small fixture, below | this section |

**G3.** Defaults: ISF 50, ICR 10, t\_p 75, t\_d 300, τ\_m 40, τ\_s 8, τ\_r 30, σ\_v 3, q\_z 0.02, σ\_r0 0.05, c\_C 0.25, c\_S 0.25, no context terms, no fat or protein, outlier gate 4, initial level SD 25 mg/dL and rate SD 0.3 mg/dL/min. Events: 4 U bolus and 40 g meal at minute 0. CGM readings y\_k = 120 + 30 sin(πk/30) for k = 0 to 30 (150 minutes of history, no gaps).

| Output | Expected |
| --- | --- |
| Filtered state \[IG, z, r\] at k = 30 | \[120.500869, 84.602411, −0.141434\] |
| h = 15 min: mean, sd | 112.416177, 5.039328 |
| h = 30 min | 105.181542, 7.044914 |
| h = 60 min | 93.431746, 10.558903 |
| h = 120 min | 80.893276, 14.099406 |
| h = 180 min | 79.787077, 15.186277 |

The fixture is for parity only. The sine-shaped CGM trace was chosen to be reproducible by formula, not to look like glucose.

### Test suite

- **Unit**: kernel integrates to 1; IOB = 1 − A; activity peaks at t\_p; F equals the matrix exponential; covariance stays symmetric with minimum eigenvalue at least −1e-9; parameter validation rejects t\_p ≥ t\_d / 2.
- **Property and metamorphic**: with no events and zero drift coefficients, the forecast depends only on the CGM trace; event order does not matter; doubling every logged dose while halving both ISF and ICR (so CSF is unchanged) leaves the nominal path unchanged; replaying after a late entry equals running from scratch with the entry present; missing data patterns never produce NaN.
- **Regression**: G0 to G3 in CI for both languages.
- **Fuzz**: random gaps, outliers, simultaneous events, extreme but legal doses.
- **Performance target** (to be measured, not yet measured): a full run in under 20 ms on a laptop and under 100 ms on a mid-range phone.

### Scope of the reference code I ran

The reference script implements the kernels, the nominal path, the three-state filter with Van Loan matrices, the forecast, and a synthetic test. It does not implement the outlier override after three skips, the context terms, fat and protein, calibration, intervals or the trust monitor. Its closed-form F matches the matrix exponential to 3e-15, and its G1 values are the ones in Section 3.

## Validation plan

### Questions the validation must answer

1. At each horizon (15, 30, 45, 60, 90, 120, 180 minutes), does B beat persistence, constant-rate extrapolation and A on data it has not seen?
2. Are the intervals calibrated: does the nominal 80% interval cover about 80%, at every horizon and in every context bin?
3. Is hypoglycemia and hyperglycemia prediction useful at the event level, with an acceptable number of false alarms per day?
4. Which components earn their place (ablations), and does anything fail in a subgroup?
5. Do the failure detectors fire when inputs are wrong?

### Datasets and their roles

| Dataset | Role | Check before use |
| --- | --- | --- |
| OhioT1DM (12 people, 8 weeks) | Development: build the harness, tune noise, run ablations | Fields logged; I understand it holds pump insulin, carbohydrate estimates, self-reported events and wearable signals but did not verify against its data dictionary. No fat or protein |
| DiaTrend (54 people with type 1 diabetes) | Held-out test | Which insulin, meal and exercise fields exist |
| T1DEXI (497 adults, structured exercise) | Exercise and, if present, macronutrient logs; held-out test | Data dictionary for meal macronutrients and wearable streams |
| App data in shadow mode | Prospective test | Consent and logging quality |
| HUPA-UCM | Not used | I saw only an excerpt |

Tuning happens only on the development set. The held-out sets are touched once per pre-registered analysis.

### Splits

- **Within-person forward chaining**: calibrate on the first 60 to 70% of a person's time, test on the rest, with at least a 6-hour gap. This is how the engine will be used. Never shuffle time.
- **Leave-people-out**: for the population defaults (priors, interval table) and for the cold-start performance of new users.
- Evaluate **every** anchor that has a CGM reading and a known outcome, not a selection of interesting ones, then report strata.

### Baselines

Persistence, constant-rate extrapolation capped at 30 minutes, the anchored simulator A, B and each ablation. Add a simple linear autoregressive model on CGM, insulin and carbohydrate as a floor for what data-driven methods can do. Re-run published methods on the same splits instead of comparing numbers across papers, since protocols differ (I could not open a recent machine-learning meta-analysis, so I give no reference figures).

### Metrics

| Group | Metrics |
| --- | --- |
| Point accuracy | RMSE, MAE, MARD and bias by horizon |
| Clinical accuracy | Clarke error grid zones and CG-EGA, implemented from the original definitions (I did not open them) |
| Events | Hypoglycemia (below 70 and 54 mg/dL) and hyperglycemia (above 180 and 250): sensitivity, precision, false alarms per day and lead time, by horizon and threshold |
| Probabilistic | Pinball loss and CRPS from the quantiles, coverage and width by horizon and bin, probability integral transform, reliability curve and Brier score of p\_below\_70 |
| Strata | Post-meal, post-correction, night, post-exercise, low start (below 90), high start (above 250), meal-size class, high fat or protein, sleep deficit, data-quality tier |

Two cautions. The reference is the CGM, not plasma glucose, so every forecast inherits the sensor's own error (MARD about 8 to 9% for a current sensor) and no method can beat that floor at short horizons. RMSE is dominated by high-glucose excursions, so report MARD and per-person distributions alongside pooled numbers, and use a block bootstrap by person and by day for confidence intervals.

### Ablations

| Removed or changed | Question |
| --- | --- |
| Filter (A) | What does online correction add? |
| Lag state | Does the explicit lag help beyond the trend state? |
| Heteroscedastic noise | Does tying rate noise to active inputs beat a constant? |
| Drift μ | Does a learned time-of-day profile help overnight and early morning? |
| Exercise, sleep, fat and protein, timing classes | Does each earn its place? |
| Calibration; personal t\_p | Does the personal fit beat clinic settings and priors? |
| Interval recalibration | Does it fix coverage without widening too much? |
| Added state C1 (per-meal carbohydrate error) | The first Approach C candidate |

A feature is kept only if held-out RMSE at 60 and 120 minutes improves by at least 3% or coverage improves, and nothing else gets worse by more than 1%. These thresholds are my proposals, to be fixed before looking at held-out data.

### Gates

- **B passes** if on held-out data its RMSE at 60 and 120 minutes is at least 5% below the better of persistence and A for at least 70% of people, the 80% interval covers between 70 and 90% at every horizon, and the hypoglycemia detector reaches a pre-agreed sensitivity at a pre-agreed false-alarm rate. The 5% and 70% are proposals, not evidence-based values.
- **A new latent state (C) passes** if it improves held-out RMSE by at least 5% in its target stratum (for C1, 60 to 180 minutes after a meal) without worsening other strata by more than 1% or coverage, and its parameters pass the information gate of Section 8.

### Fault injection

Replay held-out data with faults inserted, and check that the trust level changes within a stated time:

| Fault | Expected response |
| --- | --- |
| Delete a logged bolus | Unexplained-rise prompt within 45 minutes; degraded |
| Double a carbohydrate entry | Residual bias flagged after three meals |
| Shift all timestamps by 20 minutes | Larger innovations; degraded if persistent |
| Remove 60 minutes of CGM | Degraded at 15 minutes, unreliable at 60 |
| Insert compression-low artefacts | Skipped by the gate; no change in forecast |
| Change the time-zone offset by 3 hours | Degraded for 3 days |
| Add a duplicate source of the same meal | Removed by de-duplication |

### Shadow mode and stop rules

In P6, log live forecasts, score them when outcomes arrive, and publish the same metric table. Stop displaying a horizon if its rolling 7-day coverage leaves the 70 to 90% band for the 80% interval, or if the rolling 7-day RMSE at 60 minutes is more than 15% worse than offline results.

### Synthetic implementation test (what I ran)

This checks the code, not the clinic. I simulated 14 days with true parameters that differ from the model's: ISF 38 against 50, ICR 9 against 10, insulin peak 95 against 75 min, meal τ 55 against 40 min, true carbohydrate 30% above what was logged, a damped random disturbance plus a pull back toward 110 mg/dL (neither is in the model), an 8-minute sensor lag (the same value the filter assumes, so lag mismatch is not tested), autoregressive sensor noise (the filter assumes independent noise) and 2% dropouts. Logged boluses followed the logged carbohydrate and the model's ICR of 10. The filter ran with default parameters and no calibration. Evaluation used 2139 anchors with no logged event in the next 190 minutes.

| Horizon (min) | Persistence | Constant-rate | A: anchored simulator | B: Kalman | Nominal 90% interval coverage | sd of standardised error |
| --- | --- | --- | --- | --- | --- | --- |
| 15 | 7.3 | 5.4 | 5.1 | 4.0 | 94% | 0.84 |
| 30 | 13.6 | 10.6 | 8.6 | 6.2 | 90% | 0.94 |
| 60 | 23.7 | 18.8 | 14.3 | 10.7 | 83% | 1.14 |
| 90 | 29.4 | 25.8 | 19.0 | 14.9 | 78% | 1.35 |
| 120 | 31.6 | 29.9 | 22.6 | 18.4 | 73% | 1.53 |
| 180 | 32.8 | 34.6 | 26.1 | 23.1 | 66% | 1.78 |

RMSE in mg/dL. Constant-rate extends the slope of the last 15 minutes for at most 30 minutes and then holds; A is the last reading plus the simulator's own change since then; B is the Kalman forecast. B beats A, A beats the extrapolations, and the filter's Gaussian intervals under-cover at long horizons, so the recalibration layer is needed. The mean normalised innovation squared was 0.52, below the ideal 1, so the assumed noise is more than this world needs at one step (part of that comes from the autocorrelated sensor noise, which the filter treats as independent). Because the data come from the same model family, **these numbers say nothing about real accuracy**. Their only use is as a sanity check on the code.

## Research bibliography

**How to read this list.** *Opened* means I read the page or code. *Excerpt* means I saw only a search-result excerpt and used only what it states. *Secondary* is a reproduction by another author. Every identifier below came from a page or search result I saw, not from memory. For example, a search for Wolpert 2013 also surfaced 10.2337/dc13-1464, which is the authors' reply to a comment on the paper, so the article's own DOI, taken from its PMC page, is the one listed. PubMed pages were blocked by a browser check, which I did not try to bypass, so PMIDs were not re-confirmed against the page. Where I captured no identifier I say so, and the author-year-journal-pages citation is what to resolve. The last column gives the sections where the source is used.

### Models, insulin kinetics and kernels

| Reference | Link or identifier | Seen as | Sections |
| --- | --- | --- | --- |
| Hovorka R et al. Physiol Meas 2004;25(4):905–920 | [PMID 15382830](https://pubmed.ncbi.nlm.nih.gov/15382830/) | Excerpt | 2, 3 |
| Hovorka R et al. Am J Physiol Endocrinol Metab 2002;282:E992–E1007 | No identifier captured | Cited through Boiroux | 2 |
| Boiroux D et al. DYCOPS 2010, paper MoAT1-02 (Hovorka equations and parameters) | [PDF](https://skoge.folk.ntnu.no/prost/proceedings/dycops-2010/Papers_DYCOPS2010/MoAT1-02.pdf) | Opened; secondary | 2, 3, 4, 5, 7 |
| Wilinska ME et al. IEEE Trans Biomed Eng 2005;52(1):3–12 | [PMID 15651559](https://pubmed.ncbi.nlm.nih.gov/15651559/) | Excerpt | 2 |
| Bergman RN et al. Am J Physiol 1979;236(6):E667 | [10.1152/ajpendo.1979.236.6.E667](https://doi.org/10.1152/ajpendo.1979.236.6.E667) | Excerpt | 2 |
| Bergman RN. Front Endocrinol 2021 (review of the minimal model) | [10.3389/fendo.2020.583016](https://doi.org/10.3389/fendo.2020.583016) | Excerpt | 2 |
| Dalla Man C et al. IEEE TBME 2006 (oral glucose absorption) and 2007 (meal model) | No identifier captured | Excerpt | 2, 4 |
| Dalla Man C et al. UVA/Padova S2013 simulator. J Diabetes Sci Technol 2014 | [PMC4454102](https://pmc.ncbi.nlm.nih.gov/articles/PMC4454102/) | Excerpt | 2 |
| Visentin R et al. Circadian variability of insulin sensitivity. Diabetes Technol Ther 2015 | [10.1089/dia.2014.0192](https://doi.org/10.1089/dia.2014.0192), [PMC4074748](https://pmc.ncbi.nlm.nih.gov/articles/PMC4074748/) | Excerpt | 2, 6 |
| Visentin R et al. IEEE TBME 2016 | [10.1109/TBME.2016.2535241](https://doi.org/10.1109/TBME.2016.2535241) | Excerpt | 2 |
| Visentin R et al. Single-day UVA/Padova simulator. J Diabetes Sci Technol 2018 | [PMC5851236](https://pmc.ncbi.nlm.nih.gov/articles/PMC5851236/) | Excerpt | 2 |
| oref0 `lib/iob/calculate.js` | [GitHub](https://github.com/openaps/oref0/blob/master/lib/iob/calculate.js) | Opened (code) | 2, 5 |
| Maksimovic, exponential insulin curve, as cited in the oref0 code | [Loop issue 388 comment](https://github.com/LoopKit/Loop/issues/388#issuecomment-317938473) | Link taken from the code | 2, 5 |
| OpenAPS documentation on IOB and insulin curves | docs.openaps.org; page URL not recorded | Read | 2, 5 |
| Ellingsen C et al. J Diabetes Sci Technol 2009;3(3):536–544 | Probably [PMC2769860](https://pmc.ncbi.nlm.nih.gov/articles/PMC2769860) (first search hit, blocked by a browser check, so unconfirmed) | Opened earlier in this research | 2, 5 |
| Heise T et al. Clin Pharmacokinet 2017 (faster-acting insulin aspart) | [10.1007/s40262-017-0514-8](https://doi.org/10.1007/s40262-017-0514-8) | Excerpt | 2, 5 |
| Heise T et al. Diabetes Obes Metab 2017 | [10.1111/dom.12803](https://doi.org/10.1111/dom.12803) | Excerpt | 2, 5 |
| Rapid-acting insulin time-action summary; insulin variability reviews | [PMC7366348](https://pmc.ncbi.nlm.nih.gov/articles/PMC7366348/), [PMC8069884](https://pmc.ncbi.nlm.nih.gov/articles/PMC8069884/), [PMC2771503](https://pmc.ncbi.nlm.nih.gov/articles/PMC2771503/) | Excerpt | 2, 5 |

### Meals, fat, protein and glycemic index

| Reference | Link or identifier | Seen as | Sections |
| --- | --- | --- | --- |
| Wolpert HA et al. Dietary fat acutely increases glucose concentrations and insulin requirements in patients with type 1 diabetes. Diabetes Care 2013;36(4):810–816 | [10.2337/dc12-0092](https://doi.org/10.2337/dc12-0092), [PMC3609492](https://pmc.ncbi.nlm.nih.gov/articles/PMC3609492/) | Page opened for citation details; findings from excerpt | 2, 4 |
| Smart CE et al. Diabetes Care 2013 (protein and fat additive) | [10.2337/dc13-1195](https://doi.org/10.2337/dc13-1195) | Excerpt | 2, 4 |
| Paterson MA et al., protein studies | No identifier captured | Excerpt | 2, 4 |
| Paterson MA et al. Curr Diab Rep 2015 | [10.1007/s11892-015-0630-5](https://doi.org/10.1007/s11892-015-0630-5) | Excerpt | 2, 4 |
| Bell KJ et al. Systematic review of fat, protein and GI. Diabetes Care 2015 | [PMID 25998293](https://pubmed.ncbi.nlm.nih.gov/25998293/) | Excerpt | 2, 4 |
| Bozzetto L et al. Diabetes Care 2016 | [10.2337/dc15-2189](https://doi.org/10.2337/dc15-2189) | Excerpt | 2 |
| Matthan NR et al. Am J Clin Nutr 2016 (GI reliability) | [10.3945/ajcn.116.137208](https://doi.org/10.3945/ajcn.116.137208) | Excerpt | 2, 4 |
| Diabetes Care 2007;30(6):1412 (GI reproducibility) | No identifier captured | Excerpt | 2, 4 |
| Zeevi D et al. Cell 2015 (personalised glycemic responses) | [10.1016/j.cell.2015.11.001](https://doi.org/10.1016/j.cell.2015.11.001) | Excerpt | 2, 4 |

### Exercise

| Reference | Link or identifier | Seen as | Sections |
| --- | --- | --- | --- |
| Riddell MC et al. Exercise management in type 1 diabetes: consensus statement. Lancet Diabetes Endocrinol 2017 | [10.1016/S2213-8587(17)30014-1](<https://doi.org/10.1016/S2213-8587(17)30014-1>) | Excerpt | 2, 6 |
| Riddell MC et al. T1DEXI. Diabetes Care 2023 | [10.2337/dc22-1721](https://doi.org/10.2337/dc22-1721) | Excerpt | 2, 6, 11 |
| Dalla Man C et al. 2009 (exercise model) | [PMC2769836](https://pmc.ncbi.nlm.nih.gov/articles/PMC2769836/) | Excerpt | 2, 6 |
| Schiavon M et al. 2013 | [PMC3876324](https://pmc.ncbi.nlm.nih.gov/articles/PMC3876324/) | Excerpt | 2, 6 |
| Resalat N et al. 2019 | [PMC6657828](https://pmc.ncbi.nlm.nih.gov/articles/PMC6657828/) | Excerpt | 2, 6 |
| Romeres D et al. 2021 | [PMC8321821](https://pmc.ncbi.nlm.nih.gov/articles/PMC8321821/) | Excerpt | 2, 6 |
| Deichmann J et al. Front Endocrinol 2021 | [10.3389/fendo.2021.723812](https://doi.org/10.3389/fendo.2021.723812) | Excerpt | 2, 6 |
| Deichmann J et al. 2023 | [PMC9974135](https://pmc.ncbi.nlm.nih.gov/articles/PMC9974135/) | Excerpt | 2, 6 |
| Heart-rate-driven exercise model | [arXiv 2307.07923](https://arxiv.org/abs/2307.07923) | Excerpt | 2, 6 |
| Hypoglycemia after morning or afternoon exercise. J Diabetes Sci Technol 2015;9(3):619–624 | [PMID 25555390](https://pubmed.ncbi.nlm.nih.gov/25555390/) | Excerpt | 2, 6 |

### Sleep, circadian rhythm, dawn

| Reference | Link or identifier | Seen as | Sections |
| --- | --- | --- | --- |
| Donga E et al. Diabetes Care 2010;33(7):1573–1577 (one night of 4 h sleep, type 1 diabetes) | [PMC2890361](https://pmc.ncbi.nlm.nih.gov/articles/PMC2890361/) | Excerpt | 2, 6 |
| Donga E et al. J Clin Endocrinol Metab 2010 (healthy subjects) | [10.1210/jc.2009-2430](https://doi.org/10.1210/jc.2009-2430) | Excerpt | 2, 6 |
| Sleep-restriction summary table | [PMC4674464](https://pmc.ncbi.nlm.nih.gov/articles/PMC4674464/) | Excerpt | 2 |
| Dawn phenomenon study (all subjects, median 56% of nights) | [PMID 25100389](https://pubmed.ncbi.nlm.nih.gov/25100389/) | Excerpt | 2, 6 |
| Diurnal and nocturnal glucose metabolism: Saad A et al., Diurnal pattern to insulin secretion and insulin action in healthy individuals, Diabetes (second link, year not captured); Nocturnal glucose metabolism in type 1 diabetes, single versus dual tracer approaches, Diabetes Technol Ther (first link, 16 subjects, authors and year not captured) | [PMC4528985](https://pmc.ncbi.nlm.nih.gov/articles/PMC4528985/), [PMC3478548](https://pmc.ncbi.nlm.nih.gov/articles/PMC3478548/) | Excerpt | 2, 6 |
| Analysis of prevalence, magnitude and timing of the dawn phenomenon in adults and adolescents with type 1 diabetes: descriptive analysis of 2 insulin pump trials. Can J Diabetes 2020;44:229–235 | No identifier captured | Seen in another paper's reference list | 2, 6 |

### State estimation, CGM error, identifiability

| Reference | Link or identifier | Seen as | Sections |
| --- | --- | --- | --- |
| Facchinetti A et al. 2010 (EKF with a CGM model) and 2014 (CGM error model) | No identifier captured | Excerpt | 2, 7 |
| Facchinetti A et al. Sensors 2019;19(23):5320 | No identifier captured | Excerpt | 2, 7 |
| Facchinetti A et al., Kalman-based sensor failure detection | No identifier captured | Excerpt | 2, 7 |
| Sparacino G et al. IEEE TBME 2007;54(5):931–937 | No identifier captured | Excerpt | 2, 7 |
| Sparacino G et al. 2008 | [10.2174/157339908785294361](https://doi.org/10.2174/157339908785294361) | Excerpt | 2 |
| Plasma-to-interstitium lag tracer study (literature range 4 to 50 min); authors not captured | [PMC3837059](https://pmc.ncbi.nlm.nih.gov/articles/PMC3837059/) | Excerpt | 2, 7 |
| Modeling the error of the Medtronic Enlite sensor (mean lag 9.4 ± 6.5 min); authors not captured | [PMC5492301](https://pmc.ncbi.nlm.nih.gov/articles/PMC5492301/) | Excerpt | 2, 7 |
| Vettoretti M et al. ATTD 2020 (time constants 5.96 and 12.31 min) | No identifier captured | Excerpt | 2, 7 |
| Garg SK et al. Diabetes Technol Ther 2022;24(6):373–380 (G7 MARD) | [PMC9208857](https://pmc.ncbi.nlm.nih.gov/articles/PMC9208857/) | Excerpt | 2, 7 |
| UKF with the Hovorka model | [boa.unimib.it/handle/10281/440165](https://boa.unimib.it/handle/10281/440165) | Excerpt | 2, 7 |
| Staal OM et al. 2019 (identifiability) | No identifier captured | Excerpt | 2, 8 |
| MI-OMM (Bayesian priors, identifiability) | [escholarship.org/uc/item/4zm3c05s](https://escholarship.org/uc/item/4zm3c05s) | Excerpt | 2, 8 |

### Datasets

| Reference | Link or identifier | Seen as | Sections |
| --- | --- | --- | --- |
| Marling C, Bunescu R. OhioT1DM. CEUR Workshop Proceedings vol. 2675, pp. 71–74 (2020) | [PMC7881904](https://pmc.ncbi.nlm.nih.gov/articles/PMC7881904/) | Excerpt | 2, 11 |
| DiaTrend. Scientific Data 2023;10:556 | [arXiv 2304.06506](https://arxiv.org/abs/2304.06506); access [10.7303/syn38187184](https://doi.org/10.7303/syn38187184) | Excerpt | 2, 11 |
| T1DEXI | See Riddell 2023 above | Excerpt | 2, 11 |
| HUPA-UCM | arXiv excerpt only; identifier not captured | Excerpt | 2, 11 |

### Named in the text but not opened

The Clarke error grid and CG-EGA original definitions, split-conformal prediction theory, and a recent machine-learning glucose-prediction meta-analysis (blocked by a browser check). The report names the first two as things to implement from the originals and quotes no figures from any of them.

### Companion code from this work

`forecast_core.py` (kernels, nominal path, three-state filter, G1 and G3) and `test_synth.py` (the synthetic implementation test). They check the equations and are not a validated product.
