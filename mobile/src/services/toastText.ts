/**
 * The words and the rules for in-app toasts. Pure: no React, no DOM, no sileo, so plain Node can test it.
 *
 * A toast says that something happened (a meal or dose saved, a forecast updated, an alert). It never gives a dose
 * or a diagnosis, uses "predicted" (not "will"), and adds no number that the app does not already show.
 */
import type { ForecastOkDisplay } from '../api/forecastContract.ts';
import { formatIsoTime12 } from './clock12.ts';
import type { LoggedEvent } from './events.ts';
import type { AlertNotification } from './riskAlerts.ts';

export type ToastTone = 'success' | 'info' | 'warning' | 'error';
export type ToastSpec = { tone: ToastTone; title: string; description?: string; /** Replaces an earlier toast with the same key. */ key: string; durationMs?: number };

const grams = (n: number) => `${Math.round(n * 10) / 10} g`;
const units = (n: number) => `${Math.round(n * 100) / 100} U`;

/** "Carbs saved" / "Insulin saved", with what was saved and whether the forecast was refreshed with it. */
export function savedToast(event: LoggedEvent, forecastReturned: boolean): ToastSpec {
  const when = formatIsoTime12(event.occurredAtUtc);
  const tail = forecastReturned ? 'Forecast updated.' : 'The forecast updates on the next reading.';
  if (event.kind === 'meal') {
    return { tone: 'success', key: 'saved', title: 'Carbs saved', description: `${grams(event.carbsG)} at ${when}. ${tail}` };
  }
  if (event.unitsAdministered === 0) {
    return { tone: 'success', key: 'saved', title: 'No insulin recorded', description: `You confirmed none was taken (${when}). ${tail}` };
  }
  return { tone: 'success', key: 'saved', title: 'Insulin saved', description: `${units(event.unitsAdministered)} at ${when}. ${tail}` };
}

export function failedToast(reason: string | null): ToastSpec {
  return { tone: 'error', key: 'failed', title: "Couldn't save this entry", description: reason ?? 'It was not saved. Open it to try again.', durationMs: 8000 };
}

export function editedToast(removed: boolean): ToastSpec {
  return removed
    ? { tone: 'info', key: 'edited', title: 'Entry removed', description: 'It no longer counts in your forecast.' }
    : { tone: 'success', key: 'edited', title: 'Entry updated', description: 'Forecast updated.' };
}

/** A new forecast. Only shown when it rests on a NEW glucose reading (never for a repeat of the same one). */
export function forecastToast(f: ForecastOkDisplay): ToastSpec {
  return {
    tone: 'info',
    key: 'forecast',
    title: 'Forecast updated',
    description: `New reading ${Math.round(f.anchor.glucoseMgdl)} mg/dL at ${formatIsoTime12(f.anchor.measuredAt)}. Estimate only.`,
    durationMs: 3500,
  };
}

/** The first forecast of a session is not an update; so is the same reading seen again. */
export function shouldToastForecast(lastAnchor: string | null, f: ForecastOkDisplay): boolean {
  return lastAnchor !== null && lastAnchor !== f.anchor.measuredAt;
}

/** The same words as the browser notification, so the two never disagree. */
export function alertToast(n: AlertNotification): ToastSpec {
  const tone: ToastTone = n.type === 'cleared' ? 'success' : 'warning';
  return { tone, key: n.tag, title: n.title, description: n.body, durationMs: 10_000 };
}
