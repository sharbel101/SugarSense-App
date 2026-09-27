import {
  analyzeMeal,
  CapturedPhoto,
  MAX_BASE64_CHARS,
  MealAnalysisFailure,
  MealAnalysisItem,
  MealAnalysisOkResponse,
} from '../api/mealsApi';

/**
 * Orchestrates one meal-photo analysis: a client-side size gate, the upload, and mapping the
 * backend's response onto the three UI states `MealReviewScreen` needs (root CLAUDE.md section 9:
 * "on failure: retry ... then partial result + MANUAL ENTRY") plus the per-item edit path every
 * AI-produced number needs (section 3, invariant 6: "No AI-produced number without an edit path
 * and an `edited` flag").
 */

export type EditableMealItem = MealAnalysisItem & { edited: boolean };

export type EditableMealAnalysis = Omit<MealAnalysisOkResponse, 'items'> & {
  items: EditableMealItem[];
  /** True once the user has changed any item - the AI's original total and range no longer apply. */
  edited: boolean;
};

export function toEditable(response: MealAnalysisOkResponse): EditableMealAnalysis {
  return { ...response, items: response.items.map((item) => ({ ...item, edited: false })), edited: false };
}

/** Pure: replaces one item's carb estimate and marks it (and the analysis) edited. */
export function editItemCarbsG(analysis: EditableMealAnalysis, itemIndex: number, netCarbsG: number): EditableMealAnalysis {
  const items = analysis.items.map((item, index) =>
    index === itemIndex ? { ...item, netCarbsG, edited: true } : item,
  );
  return { ...analysis, items, edited: true };
}

/** The number the headline should show: the AI's total until the user edits an item, then the live sum. */
export function displayTotalCarbsG(analysis: EditableMealAnalysis): number {
  if (!analysis.edited) return analysis.totalNetCarbsG;
  return analysis.items.reduce((sum, item) => sum + item.netCarbsG, 0);
}

/** A short, human name for the meal from its detected items, in the app's existing "A + B" style. */
export function mealLabel(itemNames: string[]): string {
  if (itemNames.length === 0) return 'Your meal';
  const shown = itemNames.slice(0, 2).join(' + ');
  return itemNames.length > 2 ? `${shown} + more` : shown;
}

/** What PostMealScreen needs, regardless of whether the meal came from a photo or manual entry. */
export type ConfirmedMeal = {
  label: string;
  totalCarbsG: number;
  rangeLowG: number | null;
  rangeHighG: number | null;
  edited: boolean;
  source: 'photo' | 'manual';
};

export function toConfirmedMeal(analysis: EditableMealAnalysis): ConfirmedMeal {
  return {
    label: mealLabel(analysis.items.map((item) => item.name)),
    totalCarbsG: displayTotalCarbsG(analysis),
    // The original range described the AI's total; once the user has corrected an item it no
    // longer bounds anything real, so it is dropped rather than shown against a different number.
    rangeLowG: analysis.edited ? null : analysis.totalCarbsRangeLowG,
    rangeHighG: analysis.edited ? null : analysis.totalCarbsRangeHighG,
    edited: analysis.edited,
    source: 'photo',
  };
}

export function manualConfirmedMeal(totalCarbsG: number): ConfirmedMeal {
  return { label: 'Meal (entered manually)', totalCarbsG, rangeLowG: null, rangeHighG: null, edited: false, source: 'manual' };
}

export type MealReviewState =
  | { kind: 'uploading' }
  | { kind: 'result'; analysis: EditableMealAnalysis }
  | { kind: 'no_food_detected'; reason: string }
  | { kind: 'needs_manual_entry'; reason: string }
  | { kind: 'too_large'; base64Chars: number }
  | { kind: 'error'; message: string };

/** Uploads `photo` and maps the outcome onto the state `MealReviewScreen` renders. Never throws,
 * except to propagate a caller-initiated `AbortError` so an unmounted screen doesn't call setState. */
export async function runMealAnalysis(photo: CapturedPhoto, signal?: AbortSignal): Promise<MealReviewState> {
  if (photo.base64.length > MAX_BASE64_CHARS) {
    return { kind: 'too_large', base64Chars: photo.base64.length };
  }

  try {
    const response = await analyzeMeal(photo, { signal });
    if (response.status === 'no_food_detected') return { kind: 'no_food_detected', reason: response.reason };
    if (response.status === 'needs_manual_entry') return { kind: 'needs_manual_entry', reason: response.reason };
    return { kind: 'result', analysis: toEditable(response) };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    if (error instanceof MealAnalysisFailure) return { kind: 'error', message: error.message };
    return { kind: 'error', message: 'Something went wrong. Please try again.' };
  }
}
