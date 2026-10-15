import { API_URL } from '../config';
import { ngrokBypassHeaders } from './requestHeaders';

/**
 * Meal-photo analysis client. Talks to the backend's `POST /meals/analyze` only - the mobile app
 * never calls a vision model directly and never holds a Gemini (or any vision-model) API key. Per
 * root CLAUDE.md section 4: "Vision-model credentials live only in backend/. Never ship them in
 * the app."
 *
 * This type contract mirrors `backend/src/meals/meal-analysis-response.ts` and
 * `backend/src/meals/dto/analyze-meal-request.schema.ts` field-for-field (camelCase, a JSON body
 * carrying base64 image data, and a discriminated union on `status` where the two failure variants
 * structurally cannot carry a nutrition number) - that is the real, implemented, tested contract,
 * not the snake_case/multipart shape an earlier design pass described. If the backend's contract
 * changes, update both this file and `backend/src/meals/README.md` together.
 */

export type MealConfidence = 'high' | 'medium' | 'low';
/** GI can never be "high" confidence from a single photo - enforced structurally on the backend too. */
export type GlycemicIndexConfidence = 'medium' | 'low';
export type SupportedImageMimeType = 'image/jpeg' | 'image/png' | 'image/webp';

export type MealAnalysisItem = {
  name: string;
  portionDescription: string;
  estimatedGrams: number;
  netCarbsG: number;
  caloriesKcal: number;
  confidence: MealConfidence;
};

export type MealAnalysisOkResponse = {
  status: 'ok';
  items: MealAnalysisItem[];
  totalNetCarbsG: number;
  totalCarbsRangeLowG: number;
  totalCarbsRangeHighG: number;
  totalCaloriesKcal: number;
  /** Absorption-profile inputs (CLAUDE.md section 9) - not shown in the UI, per the backend's own note. */
  totalFatG: number | null;
  totalProteinG: number | null;
  totalFiberG: number | null;
  /**
   * SAFETY: display-only, rough, never certain. Never read this field anywhere near a bolus or
   * dosing calculation (root CLAUDE.md section 2: "No forecast or model output is an input to the
   * bolus dose" - the same rule applies here even though GI isn't literally a forecast).
   */
  estimatedGlycemicIndex: number | null;
  glycemicIndexConfidence: GlycemicIndexConfidence | null;
  analysisNotes: string | null;
  promptVersion: string;
  modelVersion: string;
};

export type MealAnalysisNoFoodResponse = {
  status: 'no_food_detected';
  reason: string;
  promptVersion: string;
  modelVersion: string;
};

export type MealAnalysisNeedsManualEntryResponse = {
  status: 'needs_manual_entry';
  reason: string;
  promptVersion: string;
  modelVersion: string;
};

export type MealAnalysisResponse =
  | MealAnalysisOkResponse
  | MealAnalysisNoFoodResponse
  | MealAnalysisNeedsManualEntryResponse;

/** A photo ready to upload, regardless of whether it came from the camera or the gallery. */
export type CapturedPhoto = {
  /** Local URI for the on-screen preview only - the request body carries `base64`, not this. */
  uri: string;
  /** Raw base64, no `data:` URI prefix - matches `analyzeMealImageSchema.base64Data` exactly. */
  base64: string;
  mimeType: SupportedImageMimeType;
};

/**
 * Client-side cap on the base64 payload, comfortably under the backend's own
 * `MAX_BASE64_IMAGE_CHARS` (12,000,000 chars) and its 15 MB JSON body limit, so an oversized photo
 * fails fast with a clear message instead of a slow upload that the server would reject anyway.
 */
export const MAX_BASE64_CHARS = 10_000_000;

export type MealAnalysisError =
  | { kind: 'network'; message: string }
  | { kind: 'http'; status: number; message: string };

export class MealAnalysisFailure extends Error {
  readonly info: MealAnalysisError;
  constructor(info: MealAnalysisError) {
    super(info.message);
    this.name = 'MealAnalysisFailure';
    this.info = info;
  }
}

/**
 * Uploads a meal photo to the backend and returns its carb/calorie/GI analysis. Throws
 * `MealAnalysisFailure` on any network error or non-2xx response; never fabricates a result.
 */
export async function analyzeMeal(
  photo: CapturedPhoto,
  options?: { userNote?: string; signal?: AbortSignal },
): Promise<MealAnalysisResponse> {
  const body = JSON.stringify({
    images: [{ base64Data: photo.base64, mimeType: photo.mimeType }],
    ...(options?.userNote ? { userNote: options.userNote } : null),
  });

  let response: Response;
  try {
    response = await fetch(`${API_URL}/meals/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ngrokBypassHeaders(API_URL) },
      body,
      signal: options?.signal,
    });
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'AbortError') throw cause;
    throw new MealAnalysisFailure({ kind: 'network', message: 'Could not reach the server. Check your connection.' });
  }

  if (!response.ok) {
    throw new MealAnalysisFailure({
      kind: 'http',
      status: response.status,
      message: `The server could not analyze this photo (HTTP ${response.status}).`,
    });
  }

  return (await response.json()) as MealAnalysisResponse;
}
