/**
 * The last good glucose reading and the last on-board amounts, kept (and saved on the device) so Home is never
 * blank when readings stop arriving. Pure: React and storage live in LastKnownSync.tsx.
 *
 * What is shown from here is always LABELLED as old: "measured 9:02 PM (45 min ago)" for the reading and
 * "as of 9:02 PM" for the on-board amounts. It is never presented as current, never feeds a forecast or a dose,
 * and an unknown value stays unknown (never 0).
 */
import type { InsulinAvailability } from '../api/forecastContract.ts';

export interface LastKnownGlucose {
  mgdl: number;
  /** ISO UTC time the reading was taken. */
  measuredAt: string;
}

export interface LastKnownOnBoard {
  insulinUnits: number | null;
  insulin: InsulinAvailability;
  carbsGrams: number | null;
  /**
   * ISO UTC `generatedAt` of the forecast that supplied these: when it was built. This (not the glucose reading time)
   * decides which forecast is newer, so a forecast recomputed after a save with the SAME glucose reading still wins.
   */
  generatedAt: string;
}

export interface LastKnown {
  glucose: LastKnownGlucose | null;
  onBoard: LastKnownOnBoard | null;
  /**
   * Something was saved and no newer forecast has arrived yet, so `onBoard` predates it. Not saved to disk. While
   * true the screen shows on-board as unknown instead of the old amounts.
   */
  newEntrySinceForecast?: boolean;
}

export const EMPTY_LAST_KNOWN: LastKnown = { glucose: null, onBoard: null };

const isIso = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function serializeLastKnown(v: LastKnown): string {
  return JSON.stringify({ glucose: v.glucose, onBoard: v.onBoard });
}

/** Anything unreadable, or an implausible glucose, gives nothing (a missing value is better than a wrong one). */
export function deserializeLastKnown(raw: string | null): LastKnown {
  if (!raw) return EMPTY_LAST_KNOWN;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    let glucose: LastKnownGlucose | null = null;
    const g = o.glucose as Record<string, unknown> | null | undefined;
    if (g && typeof g === 'object' && isIso(g.measuredAt)) {
      const mgdl = numOrNull(g.mgdl);
      if (mgdl !== null && mgdl >= 20 && mgdl <= 600) glucose = { mgdl, measuredAt: g.measuredAt };
    }
    let onBoard: LastKnownOnBoard | null = null;
    const b = o.onBoard as Record<string, unknown> | null | undefined;
    // `asOf` is the name an older version saved this under.
    const gen = isIso(b?.generatedAt) ? b?.generatedAt : isIso(b?.asOf) ? b?.asOf : null;
    if (b && typeof b === 'object' && gen !== null && (b.insulin === 'logged' || b.insulin === 'confirmed_none' || b.insulin === 'none_recorded')) {
      onBoard = { insulinUnits: numOrNull(b.insulinUnits), insulin: b.insulin, carbsGrams: numOrNull(b.carbsGrams), generatedAt: gen };
    }
    return { glucose, onBoard };
  } catch {
    return EMPTY_LAST_KNOWN;
  }
}

/** Keep only newer information: an older reading never replaces a newer one. */
export function mergeGlucose(cur: LastKnown, next: LastKnownGlucose): LastKnown {
  if (cur.glucose && Date.parse(cur.glucose.measuredAt) >= Date.parse(next.measuredAt)) return cur;
  return { ...cur, glucose: next };
}

/**
 * A newer forecast replaces an older one; only a STRICTLY older `generatedAt` loses. Two forecasts with the same
 * glucose reading but different `generatedAt` (one before a meal was logged, one after) must show the later one.
 */
export function mergeOnBoard(cur: LastKnown, next: LastKnownOnBoard): LastKnown {
  if (cur.onBoard && Date.parse(cur.onBoard.generatedAt) > Date.parse(next.generatedAt)) return cur;
  return { ...cur, onBoard: next, newEntrySinceForecast: false };
}

/** Call when an event was saved: the stored on-board amounts no longer reflect everything the person logged. */
export function markEntrySaved(cur: LastKnown): LastKnown {
  return cur.newEntrySinceForecast ? cur : { ...cur, newEntrySinceForecast: true };
}
