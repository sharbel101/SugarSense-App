import { mealAnalysisResultSchema } from './meal-analysis.schema.js';

/**
 * The JSON Schema handed to Gemini via `GenerateContentConfig.responseJsonSchema`.
 *
 * Generated once, at module load, directly from `mealAnalysisResultSchema` - see the header comment
 * on that file for why this is derived rather than hand-written a second time. `unrepresentable:
 * 'throw'` means adding a Zod construct Gemini's JSON Schema subset cannot express (e.g. a
 * `.refine()`) fails at startup, not silently, matching CLAUDE.md's "fail loudly" rule.
 *
 * Per https://ai.google.dev/gemini-api/docs (GenerateContentConfig.responseJsonSchema doc comment
 * in `@google/genai`'s own types.ts), the supported keyword subset is: $id, $defs, $ref, $anchor,
 * type, format, title, description, enum, items, prefixItems, minItems, maxItems, minimum, maximum,
 * anyOf, oneOf, properties, additionalProperties, required, and the non-standard propertyOrdering.
 * `draft-2020-12` is the closest match to that list (it is where `prefixItems`/`$anchor` come from).
 * Gate 1 (`../gates/gate1-structural.ts`) re-validates the model's response against the *original*
 * Zod schema regardless, so any keyword Gemini's server silently ignores is still enforced locally.
 */
export const GEMINI_MEAL_ANALYSIS_JSON_SCHEMA = mealAnalysisResultSchema.toJSONSchema({
  target: 'draft-2020-12',
  unrepresentable: 'throw',
});
