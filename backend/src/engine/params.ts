import type { EngineParams, TimeClass } from './types.js';

/**
 * Defaults and hard bounds for the meal-aware layer. Every number here is either quoted from the
 * forecasting-engine specification (tier in the comment) or an engineering default that the spec
 * itself labels as such. NONE of them is a personal physiological parameter: the person's ICR and ISF
 * come from their stored therapy settings, and the only personal quantities the layer learns are the
 * two bounded scales mCsf and mIsf (spec section 8: s_CSF, s_ISF).
 */

export const ENGINE_LAYER_VERSION = 'meal-aware-0.1';

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
