import {
  MealVisionApiError,
  type MealVisionProvider,
  type MealVisionRawResult,
  type MealVisionRequest,
} from './meal-vision.provider.js';

export type FakeMealVisionStep =
  | { kind: 'raw'; rawText: string; modelVersion?: string }
  | { kind: 'error'; error: Error };

/**
 * Test double for `MealVisionProvider`. Never calls the network. Returns each queued step in order,
 * one per call to `analyzeMealPhoto`, so a test can script e.g. "schema failure, then a good result"
 * to exercise the retry loop deterministically. Records every request it was called with.
 */
export class FakeMealVisionProvider implements MealVisionProvider {
  readonly calls: MealVisionRequest[] = [];
  private readonly steps: FakeMealVisionStep[];
  private cursor = 0;

  constructor(steps: FakeMealVisionStep[]) {
    if (steps.length === 0) {
      throw new Error('FakeMealVisionProvider needs at least one scripted step.');
    }
    this.steps = steps;
  }

  async analyzeMealPhoto(request: MealVisionRequest): Promise<MealVisionRawResult> {
    this.calls.push(request);
    // Once the script is exhausted, repeat the last step - most tests only care about the first
    // one or two calls and this avoids an out-of-bounds surprise if a retry loop calls one extra time.
    const step = this.steps[Math.min(this.cursor, this.steps.length - 1)];
    this.cursor += 1;
    if (step.kind === 'error') {
      throw step.error;
    }
    return { rawText: step.rawText, modelVersion: step.modelVersion ?? 'fake-model-v0' };
  }
}

export function fakeNetworkError(message = 'simulated network failure'): FakeMealVisionStep {
  return { kind: 'error', error: new MealVisionApiError(message) };
}
