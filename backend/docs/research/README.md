# Research notes for the backend / ML agent

## `glucose-forecasting-engine-spec.md`

Research and specification for a physiology-based glucose forecasting engine, dated 2026-10-16
(1,086 lines; copied verbatim from the author's file, do not edit it - add your own notes beside it).

**Status: a proposal. None of it is implemented.** There is no `engine` module in `backend/` and no
event-history storage yet. Treat the document as the design to build on, and its own caveats as binding:

- The author found no published validation of a kernel-plus-Kalman forecaster at 180 minutes in
  free-living type 1 diabetes. **Expected accuracy is unknown until it runs on real data.**
- The only numbers the author produced are checks of their own reference code (kernels, filter matrices,
  worked example, synthetic test). They show internal consistency, not clinical evidence.
- It is a forecasting-engine spec, not a dosing algorithm.

### In one paragraph

Approach B ("simulator + online correction + bounded calibration"): a deterministic simulator turns the
timestamped event history (insulin, meals, context) into a nominal glucose path; a 3-state linear Kalman
filter (sensor glucose, level, damped trend) anchors it to the CGM trace; a few personal parameters
(ISF scale, carb-sensitivity scale, insulin peak, meal tau) are recalibrated daily inside hard bounds;
interval widths are rescaled per horizon from past errors. No neural network, no ODE integrator. The forecast
is a pure function of (CGM history, events, parameters, now), which is what makes Python/TypeScript parity
testable and makes late/edited/deleted entries a simple replay.

### How it relates to what exists today

| | Running now (VM) | This spec |
|---|---|---|
| Model | GRU `direct_120`, glucose-only, frozen | Simulator + Kalman filter, event-driven |
| Horizon | 120 min | 180 min |
| Inputs | CGM readings only | CGM + insulin doses + meals (+ exercise, sleep context) |
| Needs | nothing extra | **Event data that nothing stores yet** (phase P0 below) |
| Where | `~/forecast` on the VM, served via `GET /glucose` | Not built; designed to run on server and phone from the same entry point |

Consequences to keep in mind:

- The spec cannot run until insulin and meal events are captured and stored. That depends on the persistence
  decision (see `../../HANDOFF-BACKEND-AI.md` and root `CLAUDE.md` section 15 open decisions) and respects
  invariants 3-6 of `CLAUDE.md` section 3 (suggested vs administered, reproducible predictions, missingness as
  data, `edited` flag).
- Earlier research on the VM (`~/SugarSense/docs/multimodal_dataset_research_report.md`) found carbs+insulin
  features cut MAE only about 1.1% at 30 min and 2.3% at 60 min in a leave-one-subject-out ablation (18 MDI
  subjects). Do not assume a large accuracy gain; the spec's own validation plan (Section 11) is the gate.
- The live GRU, the hypo/hyper heads and `hyper_excursion` are frozen safety infrastructure. This engine is
  built **beside** them and starts in shadow mode (spec phase P6), never replacing them without the user's
  explicit approval (`CLAUDE.md` section 14, backend master prompt section 10).
- **Safety rules in `CLAUDE.md` section 2 still win.** No forecast or model output feeds a bolus calculation;
  missing data is shown as missing; uncertainty stays visible. If the spec and the safety rules ever disagree,
  stop and ask the user.
- Horizon: the app and API contract currently say 2 hours. A 3-hour output would be a contract change
  (`backend/src/glucose/README.md`) coordinated with the UI chat.

### Section map (line numbers in the spec file)

| Section | Starts at line |
|---|---|
| Executive recommendation (what v1 includes and excludes, A/B/C verdict) | 5 |
| Literature review and evidence ledger (tiers V/L/E/N) | 72 |
| Equation specification (units, decomposition, discrete form) | 140 |
| Meal absorption specification | 269 |
| Insulin model specification | 343 |
| Context: exercise, sleep, circadian rhythm | 408 |
| Online state estimation (Kalman filter, CGM lag, intervals, trust monitor) | 487 |
| Personalization plan (bounded calibration) | 618 |
| Pseudocode | 691 |
| Implementation roadmap (phases P0-P7, module map, Python/TypeScript parity, golden vectors G0-G3, test suite) | 822 |
| Validation plan | 890 |
| Bibliography (marks sources as opened vs seen in an excerpt) | 987 |

### Suggested order of work

1. Read the Executive recommendation, Implementation roadmap and Validation plan first.
2. **P0 data contract** (event schema: UTC seconds, stored time-zone offset, type, id, insulin type, source;
   CGM-to-grid mapping; de-duplication; unit conversion; input sanity caps). This is the real prerequisite and
   overlaps the open persistence decision - raise it with the user before writing tables.
3. **P1 offline**: kernels, nominal path, baselines (persistence, constant-rate extrapolation) and an
   evaluation harness in `ml/` first. Reproduce the golden vectors G0-G3 from the spec before anything else.
4. Only then the filter (P2), the TypeScript port (P3), personalisation (P4), context features as ablations
   (P5), and shadow mode (P6).

Honour the project's ML discipline (`CLAUDE.md` section 14): blocked temporal splits, leave-one-subject-out,
no leakage, versioned artefacts, results written down with the evidence tier of each claim.
