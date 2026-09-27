import type { GlycemicIndexConfidence, MealAnalysisItem } from './schema/meal-analysis.schema.js';

/**
 * The HTTP response contract for POST /meals/analyze (task point 9: "the full schema above plus
 * { prompt_version, model_version, status }"). A discriminated union on `status`, not one object with
 * optional fields - task point 6 requires the three states (successful estimate / no food detected /
 * analysis failed) to be things the client can tell apart, and requires that a failure state never be
 * "a zero-value FoodData object indistinguishable from a real '0 carbs' result". Making `items` and
 * every nutrition number simply *absent* from the two non-"ok" variants (rather than present-as-null
 * or present-as-zero) makes that a property of the TypeScript type, not just a runtime convention the
 * client has to trust.
 */

export interface MealAnalysisOkResponse {
  status: 'ok';
  items: MealAnalysisItem[];
  totalNetCarbsG: number;
  totalCarbsRangeLowG: number;
  totalCarbsRangeHighG: number;
  totalCaloriesKcal: number;
  totalFatG: number | null;
  totalProteinG: number | null;
  totalFiberG: number | null;
  estimatedGlycemicIndex: number | null;
  glycemicIndexConfidence: GlycemicIndexConfidence | null;
  analysisNotes: string | null;
  promptVersion: string;
  modelVersion: string;
}

export interface MealAnalysisNoFoodResponse {
  status: 'no_food_detected';
  reason: string;
  promptVersion: string;
  modelVersion: string;
}

export interface MealAnalysisNeedsManualEntryResponse {
  status: 'needs_manual_entry';
  reason: string;
  promptVersion: string;
  modelVersion: string;
}

export type MealAnalysisResponse =
  | MealAnalysisOkResponse
  | MealAnalysisNoFoodResponse
  | MealAnalysisNeedsManualEntryResponse;
