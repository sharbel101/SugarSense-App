/**
 * Provider abstraction for the meal-photo vision call (HANDOFF-BACKEND-AI.md section 10: "behind a
 * provider interface, with a fake provider first"). `MealsService` depends on this interface only,
 * never on `@google/genai` directly, so Gate 1/Gate 2/retry logic can be fully unit-tested with
 * `FakeMealVisionProvider` before any real API key is used.
 */

export const MEAL_VISION_PROVIDER = 'MEAL_VISION_PROVIDER';

export type SupportedImageMimeType = 'image/jpeg' | 'image/png' | 'image/webp';

export interface MealVisionImageInput {
  /** Raw base64 image data, no `data:` URI prefix. */
  base64Data: string;
  mimeType: SupportedImageMimeType;
}

export interface MealVisionRequest {
  /**
   * One image today. An array, not a single field, so a second (oblique-angle) photo can be added
   * later - see CLAUDE.md section 9 "Guided two-photo capture" - without a breaking change to this
   * interface. Only a single image is accepted for now (point 10 of the task brief); the two-photo
   * capture UX/backend logic is explicitly out of scope here.
   */
  images: MealVisionImageInput[];
  /** Optional free-text note from the user, e.g. "no dressing on the salad". */
  userNote?: string;
}

/** The model's raw, pre-Gate-1 response: text expected to be JSON, plus which model produced it. */
export interface MealVisionRawResult {
  rawText: string;
  /** The exact model string actually used for this call (CLAUDE.md invariant 4: reproducibility). */
  modelVersion: string;
}

/**
 * Thrown for anything that is not a structural (Gate 1) or semantic (Gate 2) failure of the
 * response content: network errors, HTTP/API errors, timeouts, auth failures. Never carries API key
 * material - see `GeminiMealVisionProvider` for the sanitisation this is built from.
 */
export class MealVisionApiError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'MealVisionApiError';
  }
}

export interface MealVisionProvider {
  analyzeMealPhoto(request: MealVisionRequest): Promise<MealVisionRawResult>;
}
