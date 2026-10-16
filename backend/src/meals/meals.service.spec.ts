import { describe, expect, it, vi } from 'vitest';
import { MAX_ANALYSIS_ATTEMPTS, MealsService, type SleepFn } from './meals.service.js';
import { FakeMealVisionProvider, fakeNetworkError } from './providers/fake-meal-vision.provider.js';
import { MealVisionApiError } from './providers/meal-vision.provider.js';
import type { AnalyzeMealRequest } from './dto/analyze-meal-request.schema.js';

const request: AnalyzeMealRequest = {
  images: [{ base64Data: 'ZmFrZQ==', mimeType: 'image/jpeg' }],
};

const detectedRawText = JSON.stringify({
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
  analysisNotes: null,
});

const noFoodRawText = JSON.stringify({
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
});

const unidentifiedRawText = JSON.stringify({ ...JSON.parse(noFoodRawText), foodStatus: 'unidentified' });

// Instant "sleep" so retry tests don't actually wait out the exponential backoff, but still records
// what delay the service asked for.
function instantSleep(): { sleep: SleepFn; delays: number[] } {
  const delays: number[] = [];
  const sleep: SleepFn = async (ms) => {
    delays.push(ms);
  };
  return { sleep, delays };
}

describe('MealsService.analyzeMeal', () => {
  it('waits much longer before retrying after an overload (503) than after another failure', async () => {
    const delays: number[] = [];
    const provider = new FakeMealVisionProvider([
      { kind: 'error', error: new MealVisionApiError('Gemini API error (status 503).', 503) },
      { kind: 'raw', rawText: detectedRawText },
    ]);
    const service = new MealsService(provider, async (ms) => void delays.push(ms));
    const res = await service.analyzeMeal({ images: [{ base64Data: 'ZmFrZQ==', mimeType: 'image/jpeg' }] });
    expect(res.status).toBe('ok');
    expect(delays).toEqual([4000]);
  });

  it('returns status "ok" on a clean first attempt, with prompt/model version attached', async () => {
    const provider = new FakeMealVisionProvider([{ kind: 'raw', rawText: detectedRawText, modelVersion: 'm1' }]);
    const { sleep } = instantSleep();
    const service = new MealsService(provider, sleep);

    const result = await service.analyzeMeal(request);

    expect(result.status).toBe('ok');
    expect(result.promptVersion).toBeTruthy();
    expect(result.modelVersion).toBe('m1');
    expect(provider.calls).toHaveLength(1);
    if (result.status === 'ok') {
      expect(result.totalNetCarbsG).toBe(45);
      expect(result.items).toHaveLength(1);
    }
  });

  it('maps a "no_food" model result to status "no_food_detected" without retrying', async () => {
    const provider = new FakeMealVisionProvider([{ kind: 'raw', rawText: noFoodRawText, modelVersion: 'm1' }]);
    const { sleep } = instantSleep();
    const service = new MealsService(provider, sleep);

    const result = await service.analyzeMeal(request);

    expect(result.status).toBe('no_food_detected');
    expect(provider.calls).toHaveLength(1); // not a gate failure - no retry
    expect('items' in result).toBe(false); // never carries nutrition fields
  });

  it('maps an "unidentified" model result to status "needs_manual_entry" without retrying', async () => {
    const provider = new FakeMealVisionProvider([{ kind: 'raw', rawText: unidentifiedRawText, modelVersion: 'm1' }]);
    const { sleep } = instantSleep();
    const service = new MealsService(provider, sleep);

    const result = await service.analyzeMeal(request);

    expect(result.status).toBe('needs_manual_entry');
    expect(provider.calls).toHaveLength(1);
    expect('items' in result).toBe(false);
  });

  it('retries once after a Gate 1 (schema) failure, then succeeds', async () => {
    const provider = new FakeMealVisionProvider([
      { kind: 'raw', rawText: '{"not": "the right shape"}', modelVersion: 'm1' },
      { kind: 'raw', rawText: detectedRawText, modelVersion: 'm1' },
    ]);
    const { sleep, delays } = instantSleep();
    const service = new MealsService(provider, sleep);

    const result = await service.analyzeMeal(request);

    expect(result.status).toBe('ok');
    expect(provider.calls).toHaveLength(2);
    expect(delays).toEqual([500]); // one backoff wait between attempt 1 and attempt 2
  });

  it('retries once after a Gate 2 (semantic sanity) failure, then succeeds', async () => {
    const badSum = JSON.stringify({ ...JSON.parse(detectedRawText), totalNetCarbsG: 999 });
    const provider = new FakeMealVisionProvider([
      { kind: 'raw', rawText: badSum, modelVersion: 'm1' },
      { kind: 'raw', rawText: detectedRawText, modelVersion: 'm1' },
    ]);
    const { sleep } = instantSleep();
    const service = new MealsService(provider, sleep);

    const result = await service.analyzeMeal(request);

    expect(result.status).toBe('ok');
    expect(provider.calls).toHaveLength(2);
  });

  it('retries once after a provider/network error, then succeeds', async () => {
    const provider = new FakeMealVisionProvider([
      fakeNetworkError('simulated timeout'),
      { kind: 'raw', rawText: detectedRawText, modelVersion: 'm1' },
    ]);
    const { sleep } = instantSleep();
    const service = new MealsService(provider, sleep);

    const result = await service.analyzeMeal(request);

    expect(result.status).toBe('ok');
    expect(provider.calls).toHaveLength(2);
  });

  it('gives up after MAX_ANALYSIS_ATTEMPTS schema failures and returns needs_manual_entry, never fabricating numbers', async () => {
    const provider = new FakeMealVisionProvider([{ kind: 'raw', rawText: '{"bad": true}', modelVersion: 'm1' }]);
    const { sleep } = instantSleep();
    const service = new MealsService(provider, sleep);

    const result = await service.analyzeMeal(request);

    expect(result.status).toBe('needs_manual_entry');
    expect(provider.calls).toHaveLength(MAX_ANALYSIS_ATTEMPTS);
    expect('items' in result).toBe(false);
    if (result.status === 'needs_manual_entry') {
      expect(result.modelVersion).toBe('m1'); // a raw response DID come back, just failed validation
    }
  });

  it('gives up after MAX_ANALYSIS_ATTEMPTS network errors and reports modelVersion "unknown"', async () => {
    const provider = new FakeMealVisionProvider([fakeNetworkError('down')]);
    const { sleep } = instantSleep();
    const service = new MealsService(provider, sleep);

    const result = await service.analyzeMeal(request);

    expect(result.status).toBe('needs_manual_entry');
    expect(provider.calls).toHaveLength(MAX_ANALYSIS_ATTEMPTS);
    if (result.status === 'needs_manual_entry') {
      expect(result.modelVersion).toBe('unknown'); // never a fabricated/guessed model string
    }
  });

  it('never exceeds MAX_ANALYSIS_ATTEMPTS calls to the provider', async () => {
    const provider = new FakeMealVisionProvider([fakeNetworkError('down')]);
    const analyzeSpy = vi.spyOn(provider, 'analyzeMealPhoto');
    const { sleep } = instantSleep();
    const service = new MealsService(provider, sleep);

    await service.analyzeMeal(request);

    expect(analyzeSpy).toHaveBeenCalledTimes(MAX_ANALYSIS_ATTEMPTS);
  });
});
