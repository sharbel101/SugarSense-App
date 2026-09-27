import { z } from 'zod';

/**
 * Structural contract for the vision model's meal-photo analysis output.
 *
 * This is the ONLY place this shape is defined. Gate 1 (structural validation, see
 * `../gates/gate1-structural.ts`) parses the model's raw JSON text against this schema directly.
 * The JSON Schema we send to Gemini as `responseJsonSchema` (see `./to-gemini-json-schema.ts`) is
 * *generated from this same schema* with `z.toJSONSchema`, not hand-duplicated - so the two can
 * never drift apart. CLAUDE.md section 9 / HANDOFF-BACKEND-AI.md section 5 call this "Gate 1:
 * schema parse (Zod) - structure is guaranteed or rejected"; a hand-duplicated second schema would
 * be exactly the kind of divergence PDF Sec 13 warns about for `packages/sim`.
 *
 * Design notes (see backend/src/meals/README.md for the full rationale):
 * - `foodStatus` is a 3-way discriminator, not a boolean, so the model has an explicit place to
 *   say "there is food here but I cannot identify it" (`unidentified`) distinct from "no food is
 *   present" (`no_food`) and a normal result (`detected`). Never store 0 g of carbs as a proxy for
 *   either failure mode (CLAUDE.md section 2, "never store or show a fabricated number").
 * - Every nutrition field is `null` unless `foodStatus === 'detected'`. This makes a "no food" or
 *   "unidentified" result structurally impossible to confuse with a genuine 0 g estimate.
 * - `total_carbs_range_*_g` is a required range, not just a point estimate with a separate sigma -
 *   the model must commit to explicit low/high bounds it believes the true value falls within.
 * - `glycemicIndexConfidence` deliberately has no `'high'` member. GI cannot be read off a photo
 *   with high confidence; excluding the value from the enum makes that a Gate-1 structural
 *   guarantee instead of a prompt suggestion the model can ignore.
 */

export const CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

// Deliberately excludes 'high': glycaemic index cannot be read off a photo with high confidence.
// See "GI never high confidence" in the task brief - enforced here structurally, not just by prompt.
export const GI_CONFIDENCE_LEVELS = ['medium', 'low'] as const;
export type GlycemicIndexConfidence = (typeof GI_CONFIDENCE_LEVELS)[number];

export const FOOD_STATUS_VALUES = ['detected', 'no_food', 'unidentified'] as const;
export type FoodStatus = (typeof FOOD_STATUS_VALUES)[number];

export const mealAnalysisItemSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe(
      'Specific food name, e.g. "steamed white rice", not a placeholder like "food" or "item".',
    ),
  portionDescription: z
    .string()
    .min(1)
    .describe('Human-readable portion, e.g. "1 cup" or "1 medium slice".'),
  estimatedGrams: z.number().positive().describe('Estimated portion weight in grams.'),
  netCarbsG: z.number().min(0).describe('Estimated net (digestible) carbohydrate grams for this item.'),
  caloriesKcal: z.number().min(0).describe('Estimated calories for this item.'),
  confidence: z.enum(CONFIDENCE_LEVELS),
});
export type MealAnalysisItem = z.infer<typeof mealAnalysisItemSchema>;

export const mealAnalysisResultSchema = z.object({
  foodStatus: z
    .enum(FOOD_STATUS_VALUES)
    .describe(
      "'detected' = ordinary result with items below; 'no_food' = the image shows no food at all " +
        "(empty plate, unrelated object); 'unidentified' = food is visible but cannot be identified " +
        'or estimated with any usable confidence (e.g. an unrecognisable blur or mixture).',
    ),

  items: z
    .array(mealAnalysisItemSchema)
    .describe('Per-item breakdown. Empty unless foodStatus is "detected".'),

  totalNetCarbsG: z
    .number()
    .min(0)
    .max(400)
    .nullable()
    .describe('Sum of item net carbs, in grams. Null unless foodStatus is "detected".'),
  totalCarbsRangeLowG: z
    .number()
    .min(0)
    .nullable()
    .describe(
      'Low end of an honest uncertainty range around totalNetCarbsG - not a hedge, a genuine bound.',
    ),
  totalCarbsRangeHighG: z
    .number()
    .min(0)
    .nullable()
    .describe('High end of the uncertainty range. Widen this for portion sizes you are unsure of.'),
  totalCaloriesKcal: z.number().min(0).nullable(),
  totalFatG: z.number().min(0).nullable().describe('Total fat, grams. Used for absorption timing, not display.'),
  totalProteinG: z
    .number()
    .min(0)
    .nullable()
    .describe('Total protein, grams. Used for absorption timing, not display.'),
  totalFiberG: z.number().min(0).nullable(),

  estimatedGlycemicIndex: z
    .number()
    .min(0)
    .max(100)
    .nullable()
    .describe('Estimated overall glycaemic index, 0-100. Null when it cannot be estimated at all.'),
  glycemicIndexConfidence: z
    .enum(GI_CONFIDENCE_LEVELS)
    .nullable()
    .describe('Never "high" - GI cannot be read off a photo with high confidence. Null with a null GI.'),

  analysisNotes: z
    .string()
    .nullable()
    .describe(
      'Optional one or two sentences on material assumptions or sources of uncertainty ' +
        '(e.g. "sauce may contain added sugar not visible in the photo"). Null if none.',
    ),
});
export type MealAnalysisResult = z.infer<typeof mealAnalysisResultSchema>;
