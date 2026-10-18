import { describe, expect, it } from 'vitest';
import { mealAnalysisResultSchema } from './meal-analysis.schema.js';
import { GEMINI_MEAL_ANALYSIS_JSON_SCHEMA } from './to-gemini-json-schema.js';

const validDetectedResult = {
  foodStatus: 'detected',
  items: [
    {
      name: 'steamed white rice',
      portionDescription: '1 cup',
      estimatedGrams: 158,
      netCarbsG: 45,
      caloriesKcal: 205,
      confidence: 'medium',
    },
  ],
  totalNetCarbsG: 45,
  totalCarbsRangeLowG: 38,
  totalCarbsRangeHighG: 55,
  totalCaloriesKcal: 205,
  totalFatG: 0.4,
  totalProteinG: 4.3,
  totalFiberG: 0.6,
  estimatedGlycemicIndex: 73,
  glycemicIndexConfidence: 'medium',
  absorptionClass: 'moderate_fast',
  absorptionConfidence: 'medium',
  preparationAndMixtureFactors: { form: 'solid', carbohydrateQuality: 'refined_or_simple', preparation: 'boiled_or_steamed', mixedMeal: false },
  analysisNotes: null,
};

const validNoFoodResult = {
  foodStatus: 'no_food',
  items: [],
  totalNetCarbsG: null,
  totalCarbsRangeLowG: null,
  totalCarbsRangeHighG: null,
  totalCaloriesKcal: null,
  totalFatG: null,
  totalProteinG: null,
  totalFiberG: null,
  estimatedGlycemicIndex: null,
  glycemicIndexConfidence: null,
  absorptionClass: null,
  absorptionConfidence: null,
  preparationAndMixtureFactors: null,
  analysisNotes: null,
};

describe('mealAnalysisResultSchema', () => {
  it('accepts a well-formed "detected" result', () => {
    const result = mealAnalysisResultSchema.safeParse(validDetectedResult);
    expect(result.success).toBe(true);
  });

  it('accepts a well-formed "no_food" result with every nutrition field null', () => {
    const result = mealAnalysisResultSchema.safeParse(validNoFoodResult);
    expect(result.success).toBe(true);
  });

  it('rejects a missing required field', () => {
    const { foodStatus: _unused, ...withoutFoodStatus } = validDetectedResult;
    const result = mealAnalysisResultSchema.safeParse(withoutFoodStatus);
    expect(result.success).toBe(false);
  });

  it('rejects an unknown foodStatus value', () => {
    const result = mealAnalysisResultSchema.safeParse({ ...validDetectedResult, foodStatus: 'maybe' });
    expect(result.success).toBe(false);
  });

  it('rejects "high" as a glycemicIndexConfidence value (structurally excluded, not just discouraged)', () => {
    const result = mealAnalysisResultSchema.safeParse({
      ...validDetectedResult,
      glycemicIndexConfidence: 'high',
    });
    expect(result.success).toBe(false);
  });

  it('rejects totalNetCarbsG above 400g', () => {
    const result = mealAnalysisResultSchema.safeParse({ ...validDetectedResult, totalNetCarbsG: 401 });
    expect(result.success).toBe(false);
  });

  it('rejects a negative item confidence-adjacent numeric field (estimatedGrams)', () => {
    const result = mealAnalysisResultSchema.safeParse({
      ...validDetectedResult,
      items: [{ ...validDetectedResult.items[0], estimatedGrams: -5 }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects wrong-typed JSON entirely (not an object)', () => {
    const result = mealAnalysisResultSchema.safeParse('not an object');
    expect(result.success).toBe(false);
  });
});

describe('GEMINI_MEAL_ANALYSIS_JSON_SCHEMA', () => {
  it('is generated without throwing and exposes the top-level required fields', () => {
    expect(GEMINI_MEAL_ANALYSIS_JSON_SCHEMA.type).toBe('object');
    expect(GEMINI_MEAL_ANALYSIS_JSON_SCHEMA.properties).toHaveProperty('foodStatus');
    expect(GEMINI_MEAL_ANALYSIS_JSON_SCHEMA.properties).toHaveProperty('items');
    expect(GEMINI_MEAL_ANALYSIS_JSON_SCHEMA.required).toContain('foodStatus');
  });

  it('never lists "high" among the JSON-schema-level glycemicIndexConfidence values (but item confidence allows it)', () => {
    const giConfidenceSchema = GEMINI_MEAL_ANALYSIS_JSON_SCHEMA.properties?.glycemicIndexConfidence as {
      anyOf?: Array<{ enum?: string[] }>;
    };
    const giEnumValues = giConfidenceSchema.anyOf?.flatMap((branch) => branch.enum ?? []) ?? [];
    expect(giEnumValues).not.toContain('high');
    expect(giEnumValues.sort()).toEqual(['low', 'medium']);

    const itemsSchema = GEMINI_MEAL_ANALYSIS_JSON_SCHEMA.properties?.items as {
      items?: { properties?: { confidence?: { enum?: string[] } } };
    };
    expect(itemsSchema.items?.properties?.confidence?.enum).toContain('high');
  });
});
