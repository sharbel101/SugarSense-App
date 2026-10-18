import { describe, expect, it } from 'vitest';
import { runGate1Structural, withAbsorptionDefaults } from './gates/gate1-structural.js';
import { runGate2SemanticSanity } from './gates/gate2-semantic.js';
import { MealsService, glycemicLoad } from './meals.service.js';
import { FEATURE_SCHEMA_VERSION, PROMPT_VERSION, buildMealAnalysisSystemPrompt } from './prompt/meal-analysis-prompt.js';
import { FakeMealVisionProvider } from './providers/fake-meal-vision.provider.js';
import { ABSORPTION_CLASSES } from './schema/meal-analysis.schema.js';
import { GEMINI_MEAL_ANALYSIS_JSON_SCHEMA } from './schema/to-gemini-json-schema.js';

const base = {
  foodStatus: 'detected',
  items: [{ name: 'pepperoni pizza slice', portionDescription: '2 slices', estimatedGrams: 220, netCarbsG: 60, caloriesKcal: 640, confidence: 'medium' }],
  totalNetCarbsG: 60,
  totalCarbsRangeLowG: 50,
  totalCarbsRangeHighG: 72,
  totalCaloriesKcal: 640,
  totalFatG: 30,
  totalProteinG: 26,
  totalFiberG: 3,
  estimatedGlycemicIndex: null,
  glycemicIndexConfidence: null,
  analysisNotes: 'Cheese and oil amounts are not visible.',
};
const withFeatures = {
  ...base,
  absorptionClass: 'slow_delayed',
  absorptionConfidence: 'medium',
  preparationAndMixtureFactors: { form: 'solid', carbohydrateQuality: 'refined_or_simple', preparation: 'baked_or_roasted', mixedMeal: true },
};
const gate1 = (o: unknown) => runGate1Structural(JSON.stringify(o));

describe('Gate 1 - the absorption features', () => {
  it('accepts a response with every new field and keeps them', () => {
    const r = gate1(withFeatures);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.absorptionClass).toBe('slow_delayed');
      expect(r.data.absorptionConfidence).toBe('medium');
      expect(r.data.preparationAndMixtureFactors).toEqual(withFeatures.preparationAndMixtureFactors);
    }
  });

  it('an OLDER response without the new keys is still valid: they read as "not provided" (null)', () => {
    const r = gate1(base);
    expect(r.ok).toBe(true);
    if (r.ok) expect([r.data.absorptionClass, r.data.absorptionConfidence, r.data.preparationAndMixtureFactors]).toEqual([null, null, null]);
  });

  it.each(['quick', 'SLOW_DELAYED', '', 42, ['fast']])('an unexpected class label %j becomes "not provided" instead of discarding the carbohydrate estimate', (label) => {
    const r = gate1({ ...withFeatures, absorptionClass: label });
    expect(r.ok).toBe(true);
    if (r.ok) expect([r.data.absorptionClass, r.data.absorptionConfidence]).toEqual([null, null]);
  });

  it('a class without a valid confidence is read as LOW confidence, never as a confident class', () => {
    for (const conf of [null, undefined, 'certain', 7]) {
      const r = gate1({ ...withFeatures, absorptionConfidence: conf });
      expect(r.ok).toBe(true);
      if (r.ok) expect([r.data.absorptionClass, r.data.absorptionConfidence]).toEqual(['slow_delayed', 'low']);
    }
  });

  it('malformed factors become null; well-formed ones survive; a confidence without a class is dropped', () => {
    for (const bad of ['solid', 3, { form: 'gas' }, { form: 'solid', carbohydrateQuality: 'mixed', preparation: 'raw' }, []]) {
      const r = gate1({ ...withFeatures, preparationAndMixtureFactors: bad });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.data.preparationAndMixtureFactors).toBeNull();
    }
    const r = gate1({ ...base, absorptionClass: null, absorptionConfidence: 'high' });
    if (r.ok) expect(r.data.absorptionConfidence).toBeNull();
  });

  it('the carbohydrate fields stay strict: a bad number or malformed JSON is still rejected', () => {
    expect(gate1({ ...withFeatures, totalNetCarbsG: 'lots' }).ok).toBe(false);
    expect(gate1({ ...withFeatures, totalFatG: -4 }).ok).toBe(false); // invalid macronutrient
    expect(gate1({ ...withFeatures, totalNetCarbsG: 900 }).ok).toBe(false); // extreme portion
    expect(runGate1Structural('{not json').ok).toBe(false);
    expect(withAbsorptionDefaults('text')).toBe('text'); // non-objects pass through to the schema's own rejection
  });
});

describe('Gate 2 - the absorption features', () => {
  it('a no_food / unidentified result must not carry any absorption feature', () => {
    const none = { foodStatus: 'no_food', items: [], totalNetCarbsG: null, totalCarbsRangeLowG: null, totalCarbsRangeHighG: null, totalCaloriesKcal: null, totalFatG: null, totalProteinG: null, totalFiberG: null, estimatedGlycemicIndex: null, glycemicIndexConfidence: null, analysisNotes: null };
    const clean = gate1(none);
    expect(clean.ok && runGate2SemanticSanity(clean.data).ok).toBe(true);
    const leaking = gate1({ ...none, absorptionClass: 'fast', absorptionConfidence: 'high' });
    expect(leaking.ok && runGate2SemanticSanity(leaking.data).ok).toBe(false);
  });

  it('a detected result with the new fields passes', () => {
    const r = gate1(withFeatures);
    expect(r.ok && runGate2SemanticSanity(r.data).ok).toBe(true);
  });
});

describe('glycaemic load (derived, never asked of the model)', () => {
  const g = (over: Partial<Parameters<typeof glycemicLoad>[0]>) => glycemicLoad({ estimatedGlycemicIndex: 70, glycemicIndexConfidence: 'medium', totalNetCarbsG: 50, totalCarbsRangeLowG: 42, totalCarbsRangeHighG: 58, ...over });
  it('GL = GI x carbohydrate / 100 when GI is medium-confidence and the carbohydrate range is tight', () => {
    expect(g({})).toBe(35);
    expect(g({ estimatedGlycemicIndex: 55, totalNetCarbsG: 33 , totalCarbsRangeLowG: 30, totalCarbsRangeHighG: 36 })).toBe(18.2);
  });
  it('is null whenever an input is missing or unreliable', () => {
    expect(g({ estimatedGlycemicIndex: null })).toBeNull();
    expect(g({ glycemicIndexConfidence: 'low' })).toBeNull();
    expect(g({ glycemicIndexConfidence: null })).toBeNull();
    expect(g({ totalNetCarbsG: null })).toBeNull();
    expect(g({ totalNetCarbsG: 0 })).toBeNull();
    expect(g({ totalCarbsRangeLowG: 10, totalCarbsRangeHighG: 90 })).toBeNull(); // very wide range: not reliable
  });
});

describe('prompt and Gemini JSON schema', () => {
  it('the prompt is versioned and instructs the model on the absorption fields without inventing GI', () => {
    expect(PROMPT_VERSION).toBe('meal-analysis-v2');
    expect(FEATURE_SCHEMA_VERSION).toBe('meal-features-v2');
    const p = buildMealAnalysisSystemPrompt();
    for (const word of ['absorptionClass', 'absorptionConfidence', 'preparationAndMixtureFactors', 'moderate_fast', 'slow_delayed', 'moderate_mixed']) expect(p).toContain(word);
    expect(p).toMatch(/NEVER GUESS SILENTLY/);
    expect(p).toMatch(/GLYCAEMIC INDEX IS OPTIONAL AND NEVER HIGH CONFIDENCE/);
    expect(p).toMatch(/Do NOT choose the class from a food name alone/);
    expect(p).toMatch(/never mention insulin units/);
  });

  it('the schema sent to Gemini carries the four classes and the factor enums, derived from the same Zod schema', () => {
    const props = (GEMINI_MEAL_ANALYSIS_JSON_SCHEMA as { properties: Record<string, unknown> }).properties;
    for (const k of ['absorptionClass', 'absorptionConfidence', 'preparationAndMixtureFactors']) expect(props).toHaveProperty(k);
    const text = JSON.stringify(props.absorptionClass);
    for (const c of ABSORPTION_CLASSES) expect(text).toContain(c);
    expect(ABSORPTION_CLASSES).toEqual(['fast', 'moderate_fast', 'moderate_mixed', 'slow_delayed']);
  });
});

describe('MealsService - the response contract', () => {
  const svc = (raw: unknown) => new MealsService(new FakeMealVisionProvider([{ kind: 'raw', rawText: JSON.stringify(raw) }]), async () => {});
  const photo = { images: [{ base64Data: 'ZmFrZQ==', mimeType: 'image/jpeg' as const }] };

  it('returns the new fields, the derived glycaemic load and the feature schema version', async () => {
    const res = await svc({ ...withFeatures, estimatedGlycemicIndex: 60, glycemicIndexConfidence: 'medium' }).analyzeMeal(photo);
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res).toMatchObject({ absorptionClass: 'slow_delayed', absorptionConfidence: 'medium', glycemicLoadEstimate: 36, featureSchemaVersion: 'meal-features-v2', promptVersion: 'meal-analysis-v2' });
    expect(res.preparationAndMixtureFactors?.mixedMeal).toBe(true);
    // existing contract fields are untouched
    expect(res.totalNetCarbsG).toBe(60);
    expect(res.items[0]?.name).toBe('pepperoni pizza slice');
  });

  it('an older-style response still works end to end: new fields are null, nothing is invented', async () => {
    const res = await svc(base).analyzeMeal(photo);
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect([res.absorptionClass, res.absorptionConfidence, res.preparationAndMixtureFactors, res.glycemicLoadEstimate]).toEqual([null, null, null, null]);
  });

  it('an unknown food with no GI: GI and GL stay null, the class may still describe the profile', async () => {
    const res = await svc({ ...withFeatures, items: [{ ...base.items[0], name: 'homemade stew with dumplings' }] }).analyzeMeal(photo);
    expect(res.status === 'ok' && [res.estimatedGlycemicIndex, res.glycemicLoadEstimate]).toEqual([null, null]);
  });

  it('no food and unidentified responses carry no absorption features at all', async () => {
    const none = { foodStatus: 'no_food', items: [], totalNetCarbsG: null, totalCarbsRangeLowG: null, totalCarbsRangeHighG: null, totalCaloriesKcal: null, totalFatG: null, totalProteinG: null, totalFiberG: null, estimatedGlycemicIndex: null, glycemicIndexConfidence: null, analysisNotes: null };
    const res = await svc(none).analyzeMeal(photo);
    expect(res.status).toBe('no_food_detected');
    expect(res).not.toHaveProperty('absorptionClass');
    // a model that wrongly fills the features for "no food" is rejected by Gate 2 and ends in manual entry (never a fabricated profile)
    const leak = await svc({ ...none, absorptionClass: 'fast', absorptionConfidence: 'high' }).analyzeMeal(photo);
    expect(leak.status).toBe('needs_manual_entry');
  });
});
