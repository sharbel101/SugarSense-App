import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { MealForecastFlow, sha256Hex } from '../forecasting/meal-forecast-flow.js';
import type { AnalyzeMealRequest } from './dto/analyze-meal-request.schema.js';
import { runGate1Structural } from './gates/gate1-structural.js';
import { runGate2SemanticSanity } from './gates/gate2-semantic.js';
import type { MealAnalysisResponse } from './meal-analysis-response.js';
import { PROMPT_VERSION } from './prompt/meal-analysis-prompt.js';
import {
  MEAL_VISION_PROVIDER,
  MealVisionApiError,
  type MealVisionProvider,
} from './providers/meal-vision.provider.js';
import { isTransientStatus } from './providers/gemini-meal-vision.provider.js';
import type { MealAnalysisResult } from './schema/meal-analysis.schema.js';

/** "Retry with exponential backoff, max 2 attempts" (CLAUDE.md section 9 / HANDOFF section 5). */
export const MAX_ANALYSIS_ATTEMPTS = 2;
const BASE_BACKOFF_MS = 500;
/** After an overload (429 / 5xx) half a second is far too short; wait long enough for a short spike to pass. */
const OVERLOAD_BACKOFF_MS = 4000;

export type SleepFn = (ms: number) => Promise<void>;
export const MEAL_ANALYSIS_SLEEP_FN = 'MEAL_ANALYSIS_SLEEP_FN';
export const realSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reported only when every attempt failed before a model ever produced a response at all. */
const UNKNOWN_MODEL_VERSION = 'unknown';

@Injectable()
export class MealsService {
  private readonly logger = new Logger(MealsService.name);

  constructor(
    @Inject(MEAL_VISION_PROVIDER) private readonly provider: MealVisionProvider,
    @Inject(MEAL_ANALYSIS_SLEEP_FN) private readonly sleep: SleepFn,
    @Optional() @Inject(MealForecastFlow) private readonly forecastFlow?: MealForecastFlow,
  ) {}

  /**
   * Photo -> validated analysis (unchanged) -> meal event + updated forecast in the same response.
   * The forecasting step is additive and never alters or withholds the analysis result.
   */
  async analyzeMeal(request: AnalyzeMealRequest): Promise<MealAnalysisResponse> {
    const analysis = await this.analyzeCore(request);
    if (!this.forecastFlow) return analysis;
    if (analysis.status === 'ok') {
      const extra = await this.forecastFlow.afterAnalysis(analysis, {
        imageSha256: sha256Hex(request.images[0]?.base64Data ?? ''),
        clientId: request.clientId,
        eatenAt: request.eatenAt,
        userNote: request.userNote,
      });
      return { ...analysis, ...extra };
    }
    return { ...analysis, ...(await this.forecastFlow.afterFailedAnalysis()) };
  }

  private async analyzeCore(request: AnalyzeMealRequest): Promise<MealAnalysisResponse> {
    let lastFailureSummary = 'no attempts were made';
    let lastKnownModelVersion = UNKNOWN_MODEL_VERSION;
    let lastWasOverload = false;

    for (let attempt = 1; attempt <= MAX_ANALYSIS_ATTEMPTS; attempt += 1) {
      if (attempt > 1) {
        // Exponential backoff between attempts (2^(attempt-2) * base; with 2 total attempts this is
        // just one wait of BASE_BACKOFF_MS, but the formula generalises if MAX_ANALYSIS_ATTEMPTS grows).
        await this.sleep((lastWasOverload ? OVERLOAD_BACKOFF_MS : BASE_BACKOFF_MS) * 2 ** (attempt - 2));
      }

      let rawText: string;
      let modelVersion: string;
      try {
        const raw = await this.provider.analyzeMealPhoto({
          images: request.images,
          userNote: request.userNote,
        });
        rawText = raw.rawText;
        modelVersion = raw.modelVersion;
        lastKnownModelVersion = modelVersion;
      } catch (err) {
        // Cause 1 of 3: API/network failure. Logged distinctly from the two gate failures below
        // (task point 5: "don't collapse them into one generic error").
        lastWasOverload = err instanceof MealVisionApiError && isTransientStatus(err.cause);
        const message = err instanceof MealVisionApiError ? err.message : 'unexpected provider error';
        this.logger.warn(
          `meals.analyze attempt ${attempt}/${MAX_ANALYSIS_ATTEMPTS}: API/network failure - ${message}`,
        );
        lastFailureSummary = 'the vision provider call failed';
        continue;
      }

      const gate1 = runGate1Structural(rawText);
      if (!gate1.ok) {
        // Cause 2 of 3: structural (Gate 1 / schema) failure.
        this.logger.warn(
          `meals.analyze attempt ${attempt}/${MAX_ANALYSIS_ATTEMPTS}: Gate 1 schema failure ` +
            `(${gate1.reason}) - ${gate1.detail}`,
        );
        lastFailureSummary = 'the response did not match the expected structure';
        continue;
      }

      const gate2 = runGate2SemanticSanity(gate1.data);
      if (!gate2.ok) {
        // Cause 3 of 3: semantic (Gate 2 / sanity) failure.
        this.logger.warn(
          `meals.analyze attempt ${attempt}/${MAX_ANALYSIS_ATTEMPTS}: Gate 2 sanity failure - ` +
            gate2.reasons.join('; '),
        );
        lastFailureSummary = 'the response failed a semantic sanity check';
        continue;
      }

      return buildResponse(gate1.data, PROMPT_VERSION, modelVersion);
    }

    this.logger.error(
      `meals.analyze: exhausted ${MAX_ANALYSIS_ATTEMPTS} attempts; last failure: ${lastFailureSummary}`,
    );
    return {
      status: 'needs_manual_entry',
      reason: `Automatic analysis failed after ${MAX_ANALYSIS_ATTEMPTS} attempts (${lastFailureSummary}). Please enter this meal manually.`,
      promptVersion: PROMPT_VERSION,
      modelVersion: lastKnownModelVersion,
    };
  }
}

/**
 * Maps a Gate-1/Gate-2-passing result to the client response contract (task point 9). `no_food` and
 * `unidentified` are legitimate outcomes of a *successful* analysis (both gates passed - the model
 * correctly reported it found no food, or found food it couldn't identify) - they are not retried,
 * unlike an actual gate failure above. Never fabricate: neither branch carries nutrition numbers.
 */
function buildResponse(
  data: MealAnalysisResult,
  promptVersion: string,
  modelVersion: string,
): MealAnalysisResponse {
  if (data.foodStatus === 'no_food') {
    return {
      status: 'no_food_detected',
      reason: 'No food was detected in the photo.',
      promptVersion,
      modelVersion,
    };
  }

  if (data.foodStatus === 'unidentified') {
    return {
      status: 'needs_manual_entry',
      reason: 'The food in the photo could not be identified with any usable confidence.',
      promptVersion,
      modelVersion,
    };
  }

  // foodStatus === 'detected': Gate 2 already guarantees these required fields are non-null.
  return {
    status: 'ok',
    items: data.items,
    totalNetCarbsG: data.totalNetCarbsG as number,
    totalCarbsRangeLowG: data.totalCarbsRangeLowG as number,
    totalCarbsRangeHighG: data.totalCarbsRangeHighG as number,
    totalCaloriesKcal: data.totalCaloriesKcal as number,
    totalFatG: data.totalFatG,
    totalProteinG: data.totalProteinG,
    totalFiberG: data.totalFiberG,
    estimatedGlycemicIndex: data.estimatedGlycemicIndex,
    glycemicIndexConfidence: data.glycemicIndexConfidence,
    analysisNotes: data.analysisNotes,
    promptVersion,
    modelVersion,
  };
}
