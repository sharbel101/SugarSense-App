import type { EngineParams, TimeClass } from './types.js';

/**
 * Defaults and hard bounds for the meal-aware layer. Every number here is either quoted from the
 * forecasting-engine specification (tier in the comment) or an engineering default that the spec
 * itself labels as such. NONE of them is a personal physiological parameter: the person's ICR and ISF
 * come from their stored therapy settings, and the only personal quantities the layer learns are the
 * two bounded scales mCsf and mIsf (spec section 8: s_CSF, s_ISF).
 */

/** Incumbent: every meal absorbs as ONE gamma(2) component (tau = tauM x the person's speed class). */
export const ENGINE_LAYER_VERSION = 'meal-aware-0.1';
/** Candidate (0.2 was the first absorption profile, 0.3 strengthens the fibre effect): meals absorb with the early/delayed absorption profile of absorption.ts (class, GI as weak evidence, fat, protein, fibre). */
export const ABSORPTION_LAYER_VERSION = 'meal-aware-0.3';
/** Stored model_version of a SHADOW forecast contains this marker; shadow rows are never used for learning, evidence or display. */
export const SHADOW_MARKER = '-shadow';

export const DEFAULT_ENGINE_PARAMS: EngineParams = {
  tauMMin: 40, // spec section 4: Hovorka gut time constant (tier L)
  tpRapidMin: 75, // spec section 5: rapid-acting default peak (tier E)
  tpUltraMin: 55, // spec section 5: ultra-rapid default peak (tier E)
  tdMin: 300, // spec section 5: end of action, fixed
  mCsf: 1,
  mIsf: 1,
  alphaP: 0, // spec section 4: population value is NOT a mean shift
  alphaF: 0,
  cC: 0.25, // spec section 4: engineering default for carbohydrate-count error
  cS: 0.25, // spec section 5: engineering default for sensitivity error
  uncertainDoseRel: 0.5, // engineering default for a dose the user marked uncertain (not from the spec)
  trendOverlap: true, // remove what the glucose-only model already extrapolates from event-driven glucose movement
};

export const PARAM_BOUNDS = {
  mCsf: { min: 0.6, max: 1.6 }, // spec section 8: log s ~ N(0, 0.3^2), 0.6 to 1.6
  mIsf: { min: 0.6, max: 1.6 },
  tauMMin: { min: 25, max: 80 },
  cC: { min: 0.1, max: 0.5 },
} as const;

/** Spec section 4: timing classes change tau_m only, never the total carbohydrate effect. */
export const TIME_CLASS_RATIO: Record<TimeClass, number> = { fast: 0.5, medium: 1, slow: 1.5 };

/** Spec section 4: delayed fat/protein component, fixed because not identifiable. */
export const FAT_PROTEIN = {
  delayMin: 60,
  tauMin: 90,
  alphaPMax: 0.5,
  alphaFMax: 0.2,
  /** Standard deviation of a uniform amplitude on [0, max] = max / sqrt(12). */
  amplitudeSdFactor: 0.29,
} as const;

/** Normal quantile for the central 80% interval (10th to 90th percentile). */
export const Z80 = 1.2816;
export const INTERVAL_LEVEL = 0.8;

/** Displayed forecast is clipped to this range and flagged (spec section 3). */
export const DISPLAY_MIN_MGDL = 20;
export const DISPLAY_MAX_MGDL = 500;

/** Meal-to-insulin association window (spec section 8: meal and bolus within ~20 min; pre-bolus allowed). */
export const LINK_WINDOW = { beforeMin: 30, afterMin: 20 } as const;

/** Engineering default: an insulin dose marked uncertain may have been given this many minutes off. */
export const UNCERTAIN_INSULIN_TIMING_MIN = 15;

/** Horizons whose predictions are persisted and scored (minutes). */
export const TRACKED_HORIZONS_MIN = [15, 30, 45, 60, 120, 180] as const;

/** The deployed glucose-only model forecasts this far; beyond it only the event layer extends. */
export const BASELINE_HORIZON_MIN = 120;
export const MAX_HORIZON_MIN = 180;
export const STEP_MIN = 5;

/**
 * Prior 1-sigma of the glucose-only baseline error by horizon. Source: measured RMSE of the deployed
 * model on this user's own record, ~/forecast/realworld_metrics.json generated 2026-10-16
 * (n about 5,000 predictions per horizon, 5 to 60 min). Beyond 60 min nothing has been measured, so the
 * curve is extended linearly with its last measured slope and flagged as extrapolated. It is replaced,
 * horizon by horizon, by the empirical error from stored outcomes as those accumulate.
 */
export const BASELINE_SIGMA_PRIOR: ReadonlyArray<readonly [minutes: number, rmse: number]> = [
  [0, 0],
  [5, 8.9],
  [15, 20.74],
  [30, 29.52],
  [45, 35.66],
  [60, 40.24],
];
export const BASELINE_SIGMA_MEASURED_UP_TO_MIN = 60;

/**
 * How strongly the frozen glucose-only model (direct_120) extrapolates the recent trend, by forecast horizon.
 *
 * MEASURED, not assumed: ordinary-least-squares fit of the model's own stored outputs on its stored inputs,
 *   (forecast_h - g0) = a_h + b_h * (g0 - 145) + k_h * slope15,   slope15 = (g0 - glucose 15 min ago) / 15
 * over 5,171 live predictions (2026-09-09 to 2026-10-16, ~/forecast/forecast_history.db, read-only), R^2 0.28 at
 * +5 min rising to 0.92 at +120 min. Units: minutes (mg/dL of forecast change per mg/dL/min of slope).
 * Index i is the horizon 5*(i+1) minutes. Re-fit if the glucose-only model is ever replaced.
 *
 * Why it matters: the model cannot tell WHY glucose is moving, so the part of the current slope that is caused by a
 * logged meal or dose is already in its forecast. The event layer removes that part (k_h * event-driven slope)
 * before adding its own explicit increment, so the same rise is not counted twice.
 */
export const BASELINE_TREND_RESPONSE_MIN: readonly number[] = [
  2.09, 3.591, 4.643, 5.386, 5.96, 6.493, 6.815, 7.01, 7.137, 7.252, 7.058, 7.127, 7.036, 6.843, 6.644, 6.423, 6.14,
  5.887, 5.518, 5.296, 5.016, 4.833, 4.621, 4.222,
];
/** Window over which the slope is measured in the fit above (minutes). */
export const TREND_SLOPE_WINDOW_MIN = 15;

/** k_h by linear interpolation; below +5 min scaled toward 0, beyond +120 min held at the +120 value. */
export function trendResponseAt(minutes: number): number {
  const t = BASELINE_TREND_RESPONSE_MIN;
  if (minutes <= 5) return (t[0] as number) * (minutes / 5);
  if (minutes >= 120) return t[t.length - 1] as number;
  const pos = minutes / 5 - 1;
  const i = Math.floor(pos);
  const f = pos - i;
  return (t[i] as number) * (1 - f) + (t[i + 1] as number) * f;
}
