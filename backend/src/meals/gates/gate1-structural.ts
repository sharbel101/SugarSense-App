import { mealAnalysisResultSchema, type MealAnalysisResult } from '../schema/meal-analysis.schema.js';

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

  const result = mealAnalysisResultSchema.safeParse(parsedJson);
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
