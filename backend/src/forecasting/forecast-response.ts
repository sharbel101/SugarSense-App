/**
 * Frontend contract for the forecast routes. Only display fields: no parameter values, no ICR/ISF, no
 * raw model output, no database detail. Units are mg/dL and minutes; times are UTC ISO strings.
 * `null` means "not available" and is never a zero.
 */

export interface ForecastPointDisplay {
  minutes: number;
  time: string;
  /** Glucose-only model; null after its 120-minute horizon. */
  baseline: number | null;
  /** With the logged meals and insulin taken into account (equals baseline when nothing changed). */
  adjusted: number;
  /** Bounds of the 80% predicted range. */
  low: number;
  high: number;
  /** True after the glucose-only model's horizon: only logged events move the line. */
  extension: boolean;
  /**
   * Insulin on board (U) and carbs on board (g) at this time, estimated from LOGGED entries only, so the
   * graph can show how they run down. null = unknown (nothing logged), never 0 by default.
   */
  insulinOnBoardUnits: number | null;
  carbsOnBoardGrams: number | null;
}

export type EventRoleDisplay = 'used' | 'range_only' | 'not_used' | 'excluded';

export interface ForecastEventDisplay {
  id: string;
  type: 'meal' | 'insulin';
  time: string;
  role: EventRoleDisplay;
  /** Fixed machine-readable reason, e.g. insulin_not_recorded, carbs_unknown, dose_without_recorded_meal. */
  reason: string;
}

export interface MealAwareDisplay {
  /** True when logged events moved the central line away from the glucose-only forecast. */
  changedForecast: boolean;
  /** True for the "what if these meals had not been eaten" view. Not a prediction of what will happen. */
  counterfactual: boolean;
  excludedMealIds: string[];
  availability: {
    mealsUsed: number;
    mealsRangeOnly: number;
    mealsNotUsed: number;
    insulin: 'logged' | 'confirmed_none' | 'none_recorded';
    insulinDosesUsed: number;
    insulinDosesRangeOnly: number;
    /** Insulin on board from LOGGED doses. null = unknown (nothing recorded), never 0 by default. */
    insulinOnBoardUnits: number | null;
    carbsOnBoardGrams: number | null;
    therapySettings: 'available' | 'unavailable';
  };
  events: ForecastEventDisplay[];
}

export interface ForecastOkDisplay {
  status: 'ok';
  anchor: { measuredAt: string; glucoseMgdl: number; ageMinutes: number };
  generatedAt: string;
  horizonMin: number;
  stepMin: 5;
  intervalLevel: 0.8;
  points: ForecastPointDisplay[];
  mealAware: MealAwareDisplay;
  models: {
    baseline: string | null;
    eventLayer: string;
    /**
     * What the stored outcomes say about the event layer: none_yet / supports / against / mixed, with the number of
     * scored forecasts behind it. Show it next to the adjusted line ("not yet validated" while none_yet).
     */
    eventLayerEvidence: { status: 'none_yet' | 'supports' | 'against' | 'mixed'; samples: number };
  };
  /** Whether this forecast was written to the database (false for what-if views or if saving failed). */
  saved: boolean;
  /** Plain-language limits that apply to this forecast. */
  notes: string[];
  disclaimer: string;
}

export interface ForecastBaselineUnavailableDisplay {
  status: 'baseline_unavailable';
  anchor: { measuredAt: string; glucoseMgdl: number; ageMinutes: number };
  reason: string;
  /**
   * No glucose line is drawn, but what the person logged is still accounted for: insulin / carbs on board
   * now and the list of logged events with their role, so a saved meal or dose never looks like it vanished.
   * Absent only when logged events could not be read.
   */
  mealAware?: MealAwareDisplay;
  notes: string[];
  disclaimer: string;
}

export interface ForecastStaleDisplay {
  status: 'stale';
  reason: string;
  lastMeasuredAt: string | null;
}

export interface ForecastUnavailableDisplay {
  status: 'unavailable';
  reason: string;
}

export type ForecastDisplay =
  | ForecastOkDisplay
  | ForecastBaselineUnavailableDisplay
  | ForecastStaleDisplay
  | ForecastUnavailableDisplay;

export const FORECAST_DISCLAIMER =
  'Estimated range based on your glucose history and what you logged. Not medical advice; it does not tell you how much insulin to take.';
