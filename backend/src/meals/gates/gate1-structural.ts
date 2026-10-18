import {
  ABSORPTION_CLASSES,
  CARB_QUALITIES,
  CONFIDENCE_LEVELS,
  MEAL_FORMS,
  NEW_FEATURE_KEYS,
  PREPARATIONS,
  mealAnalysisResultSchema,
  type MealAnalysisResult,
} from '../schema/meal-analysis.schema.js';

/**
 * Gate 1 (PDF Sec 5 / HANDOFF-BACKEND-AI.md section 5): structural validation only.
 *
 * The model's raw text must be valid JSON, and that JSON must match `mealAnalysisResultSchema`
 * exactly. Any mismatch - wrong type, missing required field, an enum value we didn't ask for - is a
 * hard failure that goes to the retry path, never a partial accept. Semantic/business-rule checks
 * (sums, ranges, placeholder names) are deliberately NOT here; see `gate2-semantic.ts`.
 */

export type Gate1Result =
  | { ok: true; data: MealAnalysisResult }
  | { ok: false; reason: 'invalid_json' | 'schema_mismatch'; detail: string };

const isOneOf = (list: readonly string[], v: unknown): boolean => typeof v === 'string' && list.includes(v);

/**
 * Backward compatibility and graceful degradation for the absorption features ONLY (the carbohydrate numbers keep the strict
 * rules above). A response without the new keys (an older prompt, a fallback model) is read as "not provided" (null); a label
 * outside the allowed set is also read as "not provided" instead of discarding an otherwise good carbohydrate estimate. The
 * downstream model then falls back to its existing meal-class / macronutrient logic.
 */
export function withAbsorptionDefaults(parsed: unknown): unknown {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed;
  const o = { ...(parsed as Record<string, unknown>) };
  for (const k of NEW_FEATURE_KEYS) if (!(k in o) || o[k] === undefined) o[k] = null;
  if (!isOneOf(ABSORPTION_CLASSES, o.absorptionClass)) o.absorptionClass = null;
  if (o.absorptionClass === null || !isOneOf(CONFIDENCE_LEVELS, o.absorptionConfidence)) {
    // a class needs a stated confidence; without one it is the weakest evidence, not a confident class
    o.absorptionConfidence = o.absorptionClass === null ? null : 'low';
  }
  const f = o.preparationAndMixtureFactors;
  if (f !== null) {
    const ok =
      f !== null &&
      typeof f === 'object' &&
      isOneOf(MEAL_FORMS, (f as Record<string, unknown>).form) &&
      isOneOf(CARB_QUALITIES, (f as Record<string, unknown>).carbohydrateQuality) &&
      isOneOf(PREPARATIONS, (f as Record<string, unknown>).preparation) &&
      (typeof (f as Record<string, unknown>).mixedMeal === 'boolean' || (f as Record<string, unknown>).mixedMeal === null);
    if (!ok) o.preparationAndMixtureFactors = null;
  }
  return o;
}

export function runGate1Structural(rawText: string): Gate1Result {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawText);
  } catch (err) {
    return {
      ok: false,
      reason: 'invalid_json',
      detail: err instanceof Error ? err.message : 'Response was not valid JSON.',
    };
  }

  const result = mealAnalysisResultSchema.safeParse(withAbsorptionDefaults(parsedJson));
  if (!result.success) {
    // z.prettifyError gives a compact, human-readable summary; never echoes raw model text back
    // (the detail is a description of the schema mismatch, not the offending content).
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return { ok: false, reason: 'schema_mismatch', detail };
  }

  return { ok: true, data: result.data };
}
