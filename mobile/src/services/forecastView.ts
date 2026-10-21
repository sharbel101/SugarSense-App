import type { ForecastOkDisplay } from '../api/forecastContract';

/**
 * Display text and prompts derived from the server's forecast numbers. Pure. Nothing here
 * computes insulin on board, carbs on board or any ratio: it only formats what the server sent.
 */

type Availability = ForecastOkDisplay['mealAware']['availability'];

export type OnBoardChip = { label: string; value: string; caption: string; known: boolean };

/** `null` is "unknown", never 0. A 0 reads as "0.0 U" only when the person confirmed none was taken. */
export function formatInsulinOnBoard(a: Pick<Availability, 'insulinOnBoardUnits' | 'insulin'>): OnBoardChip {
  const label = 'Insulin on board';
  if (a.insulinOnBoardUnits === null) {
    return { label, value: 'unknown', caption: captionFor(a.insulin), known: false };
  }
  if (a.insulinOnBoardUnits === 0 && a.insulin === 'none_recorded') {
    // A number that says "zero" while nothing was logged would be a fabricated "none".
    return { label, value: 'unknown', caption: captionFor(a.insulin), known: false };
  }
  return { label, value: `${a.insulinOnBoardUnits.toFixed(1)} U`, caption: captionFor(a.insulin), known: true };
}

function captionFor(insulin: Availability['insulin']): string {
  switch (insulin) {
    case 'logged':
      return 'from the doses you logged';
    case 'confirmed_none':
      return 'none taken (you confirmed)';
    case 'none_recorded':
      return 'no insulin logged recently';
  }
}

export function formatCarbsOnBoard(a: Pick<Availability, 'carbsOnBoardGrams'>): OnBoardChip {
  const label = 'Carbs on board';
  if (a.carbsOnBoardGrams === null) return { label, value: 'none logged', caption: 'from your entries', known: false };
  return { label, value: `${Math.round(a.carbsOnBoardGrams)} g`, caption: 'from your entries', known: true };
}

export const ON_BOARD_EXPLAINER =
  'Insulin on board is the part of the doses you logged that is still to act, from a standard action curve. ' +
  'Carbs on board is the part of logged meals not yet absorbed. Estimates from your entries only.';

export type PromptKind = 'set_ratio';

export type ForecastPrompt = {
  kind: PromptKind;
  text: string;
  /** Event the prompt is about, when it is one specific entry. */
  eventId: string | null;
};

/** Banners telling the person what the model is missing, in priority order. Empty when nothing applies. */
export function forecastPrompts(f: ForecastOkDisplay): ForecastPrompt[] {
  const a = f.mealAware.availability;
  const out: ForecastPrompt[] = [];

  if (a.therapySettings === 'unavailable' && (a.mealsNotUsed > 0 || a.insulinDosesUsed + a.insulinDosesRangeOnly > 0)) {
    out.push({
      kind: 'set_ratio',
      text: 'Set your insulin-to-carb ratio so logged meals can be used.',
      eventId: null,
    });
  }
  // A meal with no insulin recorded is NOT prompted any more (it was a red banner on every such meal): the server
  // already widens the range for it. A dose with no meal recorded, or one that could belong to two meals, is
  // not prompted either.
  return out;
}

/** The id of a meal the server is still waiting to hear insulin for (used by the quick-add choice, not a banner). */
export function mealWaitingForInsulinId(f: ForecastOkDisplay): string | null {
  if (f.mealAware.availability.mealsRangeOnly <= 0) return null;
  return f.mealAware.events.find((e) => e.type === 'meal' && e.role === 'range_only' && e.reason === 'insulin_not_recorded')?.id ?? null;
}

/** "Saved. Forecast updated." only when the server really returned a refreshed forecast. */
export function savedMessage(forecastReturned: boolean): string {
  return forecastReturned ? 'Saved. Forecast updated.' : 'Saved. The forecast will update on the next reading.';
}
export const PENDING_MESSAGE = 'Not sent yet - we will retry.';
