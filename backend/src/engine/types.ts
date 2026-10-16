/**
 * Plain data types for the meal-aware layer. The layer is a pure function of these; the Nest services
 * normalise database rows into them. UTC seconds everywhere (no Date objects inside the core).
 */

export type TimeClass = 'fast' | 'medium' | 'slow';
export type CarbProvenance = 'estimated' | 'user_corrected' | 'user_entered';
export type InsulinConfirmation = 'confirmed' | 'uncertain' | 'planned';

/** How a meal relates to recorded rapid-acting insulin. Never inferred when ambiguous. */
export type LinkStatus =
  | 'linked_declared' // user tied the dose to this meal
  | 'linked_auto' // exactly one unambiguous bolus in the meal window
  | 'confirmed_none' // user confirmed that no insulin was taken
  | 'none_recorded' // nothing recorded - NOT the same as none taken
  | 'ambiguous'; // the dose could belong to more than one meal, or the meal to more than one dose

export interface MealInput {
  id: string;
  revision: number;
  tSec: number;
  /** null = unknown. 0 = confirmed zero. */
  carbsG: number | null;
  /** 1-sigma of the carbohydrate estimate in grams; null when carbs are unknown. */
  carbsSigmaG: number | null;
  fatG: number | null;
  proteinG: number | null;
  provenance: CarbProvenance | null;
  timeClass: TimeClass;
  /** +/- minutes the stated meal time may be off; 0 = trusted. */
  timingUncertaintyMin: number;
  /** ICR (g/U) and ISF (mg/dL/U) valid at the meal time; null = not set. */
  icrGPerU: number | null;
  isfMgdlPerU: number | null;
}

export interface InsulinInput {
  id: string;
  revision: number;
  tSec: number;
  /** Delivered units; planned doses never reach the engine. */
  units: number;
  kind: 'bolus' | 'correction';
  ultraRapid: boolean;
  /** true when the user marked the dose or its timing as uncertain. */
  uncertain: boolean;
  isfMgdlPerU: number | null;
  declaredMealId: string | null;
}

export interface MealLink {
  mealId: string;
  status: LinkStatus;
  insulinIds: string[];
  /** Sum of delivered units linked to the meal; null unless status is linked_* or confirmed_none (0). */
  unitsTotal: number | null;
}

export interface EngineParams {
  /** Meal time constant for the medium class (min). */
  tauMMin: number;
  /** Insulin peak/end for rapid and ultra-rapid (min). */
  tpRapidMin: number;
  tpUltraMin: number;
  tdMin: number;
  /** Personal scale on the carbohydrate glucose effect (s_CSF) and on insulin sensitivity (s_ISF). */
  mCsf: number;
  mIsf: number;
  /** Fat / protein amplitudes of the delayed appearance component; 0 = no mean shift (spec default). */
  alphaP: number;
  alphaF: number;
  /** Relative carbohydrate-count error and insulin-sensitivity error (spec section 4 and 5 defaults). */
  cC: number;
  cS: number;
  /** Extra relative dose uncertainty for doses the user marked uncertain (engineering default). */
  uncertainDoseRel: number;
}

export type EventRole = 'applied' | 'scenario_only' | 'ignored' | 'excluded';

export interface EventDisposition {
  eventType: 'meal' | 'insulin';
  id: string;
  role: EventRole;
  reason: string;
}

export interface StepSeries {
  /** Minutes after the anchor for each step. */
  minutes: number[];
  /** Unscaled (m = 1) mean glucose effect increments since the anchor, mg/dL, magnitudes >= 0. */
  mealEffect: number[];
  insulinEffect: number[];
  /** Scale-applied versions actually added to / subtracted from the baseline. */
  mealApplied: number[];
  insulinApplied: number[];
  /** 1-sigma components (mg/dL), independent. */
  sigmaCarb: number[];
  sigmaInsulin: number[];
  sigmaTiming: number[];
  sigmaFatProtein: number[];
  /** One-sided scenario extensions of the interval (mg/dL, >= 0). */
  scenarioUp: number[];
  scenarioDown: number[];
  /** Insulin on board (U) / carbs on board (g) at each step from the logged entries; null = unknown. */
  iobUnits: (number | null)[];
  cobGrams: (number | null)[];
}

export interface EventLayerResult {
  series: StepSeries;
  dispositions: EventDisposition[];
  /** Carbs not yet absorbed from applied + scenario meals at the anchor (g); null when unknown. */
  cobG: number | null;
  /** Insulin on board from delivered logged rapid-acting doses (U); null when insulin history is unknown. */
  iobU: number | null;
  appliedMeals: number;
  appliedInsulin: number;
  featureConfig: 'glucose_only' | 'meal+insulin' | 'meal_only' | 'insulin_only';
}
