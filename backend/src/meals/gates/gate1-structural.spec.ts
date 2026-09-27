import { describe, expect, it } from 'vitest';
import { runGate1Structural } from './gate1-structural.js';

const validPayload = {
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
  analysisNotes: null,
};

describe('runGate1Structural', () => {
  it('accepts valid JSON matching the schema', () => {
    const result = runGate1Structural(JSON.stringify(validPayload));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.foodStatus).toBe('no_food');
    }
  });

  it('rejects text that is not valid JSON at all (e.g. the model added prose or markdown fences)', () => {
    const result = runGate1Structural('```json\n' + JSON.stringify(validPayload) + '\n```');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid_json');
    }
  });

  it('rejects valid JSON that does not match the schema, distinguishing the reason from invalid_json', () => {
    const result = runGate1Structural(JSON.stringify({ ...validPayload, foodStatus: 'sort-of' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('schema_mismatch');
      expect(result.detail).toContain('foodStatus');
    }
  });

  it('rejects an empty string', () => {
    const result = runGate1Structural('');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid_json');
    }
  });
});
