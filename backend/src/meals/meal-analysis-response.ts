import type { ForecastDisplay } from '../forecasting/forecast-response.js';
import type {
  AbsorptionClass,
  ConfidenceLevel,
  GlycemicIndexConfidence,
  MealAnalysisItem,
  MealFactors,
} from './schema/meal-analysis.schema.js';

/**
 * Added when the forecasting layer is available (additive: older clients ignore these). The photo
 * analysis is stored as a meal event and the updated forecast comes back in the same response. When the
 * analysis could not be used, the glucose-only forecast is still returned with a note saying why the meal is
 * absent. None of these fields carries the raw model response or any internal parameter.
 */
export interface PhotoForecastFields {
  /** Id of the stored meal event (use it to correct the estimate or to build a what-if view); null if not saved. */
  mealEventId?: string | null;
  forecast?: ForecastDisplay | null;
  forecastNote?: string;
}

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

export interface MealAnalysisOkResponse extends PhotoForecastFields {
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
  /** Added with feature schema meal-features-v2 (additive; null when not provided or not assessable). */
  absorptionClass?: AbsorptionClass | null;
  absorptionConfidence?: ConfidenceLevel | null;
  preparationAndMixtureFactors?: MealFactors | null;
  /** GI x carbohydrate / 100, computed here (never asked of the model) and only when GI and the carbohydrate range are reliable enough. */
  glycemicLoadEstimate?: number | null;
  featureSchemaVersion?: string;
  promptVersion: string;
  modelVersion: string;
}

export interface MealAnalysisNoFoodResponse extends PhotoForecastFields {
  status: 'no_food_detected';
  reason: string;
  promptVersion: string;
  modelVersion: string;
}

export interface MealAnalysisNeedsManualEntryResponse extends PhotoForecastFields {
  status: 'needs_manual_entry';
  reason: string;
  promptVersion: string;
  modelVersion: string;
}

export type MealAnalysisResponse =
  | MealAnalysisOkResponse
  | MealAnalysisNoFoodResponse
  | MealAnalysisNeedsManualEntryResponse;
