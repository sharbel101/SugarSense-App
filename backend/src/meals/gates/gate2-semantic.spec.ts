import { describe, expect, it } from 'vitest';
import { runGate2SemanticSanity } from './gate2-semantic.js';
import type { MealAnalysisResult } from '../schema/meal-analysis.schema.js';

function detectedResult(overrides: Partial<MealAnalysisResult> = {}): MealAnalysisResult {
  return {
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
    ...overrides,
  };
}

function nonDetectedResult(foodStatus: 'no_food' | 'unidentified'): MealAnalysisResult {
  return {
    foodStatus,
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
}

describe('runGate2SemanticSanity', () => {
  it('passes a well-formed "detected" result', () => {
    expect(runGate2SemanticSanity(detectedResult())).toEqual({ ok: true });
  });

  it('passes a well-formed "no_food" result', () => {
    expect(runGate2SemanticSanity(nonDetectedResult('no_food'))).toEqual({ ok: true });
  });

  it('passes a well-formed "unidentified" result', () => {
    expect(runGate2SemanticSanity(nonDetectedResult('unidentified'))).toEqual({ ok: true });
  });

  it('rule 1: rejects when the sum of item netCarbsG is not within 5% of totalNetCarbsG', () => {
    const result = detectedResult({ totalNetCarbsG: 100 }); // item sum is still 45
    const gate2 = runGate2SemanticSanity(result);
    expect(gate2.ok).toBe(false);
    if (!gate2.ok) expect(gate2.reasons.some((r) => r.includes('sum of item netCarbsG'))).toBe(true);
  });

  it('rule 2: rejects when totalCarbsRangeLowG > totalNetCarbsG', () => {
    const gate2 = runGate2SemanticSanity(detectedResult({ totalCarbsRangeLowG: 200 }));
    expect(gate2.ok).toBe(false);
    if (!gate2.ok) expect(gate2.reasons.some((r) => r.includes('totalCarbsRangeLowG'))).toBe(true);
  });

  it('rule 2: rejects when totalNetCarbsG > totalCarbsRangeHighG', () => {
    const gate2 = runGate2SemanticSanity(detectedResult({ totalCarbsRangeHighG: 1 }));
    expect(gate2.ok).toBe(false);
    if (!gate2.ok) expect(gate2.reasons.some((r) => r.includes('totalCarbsRangeHighG'))).toBe(true);
  });

  it('rule 3: rejects totalNetCarbsG of 0 (must be > 0, not just >= 0)', () => {
    const gate2 = runGate2SemanticSanity(
      detectedResult({
        totalNetCarbsG: 0,
        totalCarbsRangeLowG: 0,
        totalCarbsRangeHighG: 0,
        items: [{ ...detectedResult().items[0], netCarbsG: 0 }],
      }),
    );
    expect(gate2.ok).toBe(false);
    if (!gate2.ok) expect(gate2.reasons.some((r) => r.includes('outside 0-400'))).toBe(true);
  });

  it('rule 3: rejects totalNetCarbsG above 400g', () => {
    // Bypass the Zod .max(400) by constructing the object directly (Gate 2 is meant to also catch
    // this independently, per the task brief listing it as its own Gate-2 rule).
    const gate2 = runGate2SemanticSanity(
      detectedResult({
        totalNetCarbsG: 450,
        totalCarbsRangeLowG: 400,
        totalCarbsRangeHighG: 500,
        items: [{ ...detectedResult().items[0], netCarbsG: 450 }],
      }),
    );
    expect(gate2.ok).toBe(false);
    if (!gate2.ok) expect(gate2.reasons.some((r) => r.includes('outside 0-400'))).toBe(true);
  });

  it('rule 4: rejects an empty/placeholder item name', () => {
    const gate2 = runGate2SemanticSanity(
      detectedResult({ items: [{ ...detectedResult().items[0], name: 'food item' }] }),
    );
    expect(gate2.ok).toBe(false);
    if (!gate2.ok) expect(gate2.reasons.some((r) => r.includes('placeholder name'))).toBe(true);
  });

  it('rule 5: rejects estimatedGlycemicIndex above 100', () => {
    const gate2 = runGate2SemanticSanity(detectedResult({ estimatedGlycemicIndex: 150 }));
    expect(gate2.ok).toBe(false);
    if (!gate2.ok) expect(gate2.reasons.some((r) => r.includes('estimatedGlycemicIndex'))).toBe(true);
  });

  it('rule 5: a null estimatedGlycemicIndex is fine (GI is optional)', () => {
    const gate2 = runGate2SemanticSanity(
      detectedResult({ estimatedGlycemicIndex: null, glycemicIndexConfidence: null }),
    );
    expect(gate2).toEqual({ ok: true });
  });

  it('additional check: rejects a "detected" result with zero items', () => {
    const gate2 = runGate2SemanticSanity(detectedResult({ items: [] }));
    expect(gate2.ok).toBe(false);
    if (!gate2.ok) expect(gate2.reasons.some((r) => r.includes('items is empty'))).toBe(true);
  });

  it('additional check: rejects a "detected" result with a null required numeric field', () => {
    const gate2 = runGate2SemanticSanity(detectedResult({ totalCaloriesKcal: null }));
    expect(gate2.ok).toBe(false);
    if (!gate2.ok) expect(gate2.reasons.some((r) => r.includes('totalCaloriesKcal'))).toBe(true);
  });

  it('additional check: rejects a "no_food" result that still carries nutrition numbers', () => {
    const leaky = runGate2SemanticSanity({ ...nonDetectedResult('no_food'), totalNetCarbsG: 0 });
    expect(leaky.ok).toBe(false);
    if (!leaky.ok) expect(leaky.reasons.some((r) => r.includes('nutrition fields or items'))).toBe(true);
  });

  it('additional check: rejects an "unidentified" result that still carries items', () => {
    const leaky = runGate2SemanticSanity({
      ...nonDetectedResult('unidentified'),
      items: [detectedResult().items[0]],
    });
    expect(leaky.ok).toBe(false);
  });
});
