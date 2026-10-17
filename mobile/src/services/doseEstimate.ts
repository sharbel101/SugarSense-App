/**
 * Meal dose and combined dose, the standard bolus-calculator arithmetic (root CLAUDE.md section 10):
 *
 *   meal       = carbs (g) / ICR (g per unit)                           - this meal only
 *   correction = max(0, (glucose - target) / ISF)                       - 0 at or below target
 *   iob        = insulin on board from the doses the person LOGGED      - subtracted (anti-stacking)
 *   combined   = clamp(meal + correction - iob, 0, ceiling)
 *
 * Inputs are the person's own saved ICR / ISF, their target glucose, their current glucose reading and
 * the IOB the server reports for their logged doses. NO forecast value and no model output enters
 * this arithmetic. Each term is rounded to 0.1 U FIRST and the combined dose is built from the
 * rounded terms, so the arithmetic shown on screen adds up exactly and a mistyped glucose is catchable.
 *
 * Not modelled (and said so on screen): exercise, illness, sleep, alcohol, fat/protein delay, the
 * glucose trend. A suggestion is never "what was taken" - taken is a separate, user-confirmed record.
 *
 * Pure, so plain-Node tests can run it.
 */
import { LOW_GLUCOSE_MGDL, MAX_ESTIMATE_UNITS, segmentAt, type RatioSegment } from './mealInsulinEstimate.ts';

export type IsfSegment = { startMinute: number; mgdlPerUnit: number };

export type SavedTherapy =
  | { status: 'set' | 'not_set'; icrSegments: RatioSegment[]; isfSegments: IsfSegment[] }
  | null;

export type GlucoseInput = {
  mgdl: number;
  /** Whole minutes since the reading was taken. */
  ageMinutes: number;
  /** mg/dL per minute as supplied by the server; null = not supplied. Informational only. */
  trendMgdlPerMin: number | null;
};

/** Older than this and the reading is not used for a correction (same as the app's staleness rule). */
export const GLUCOSE_FRESH_MINUTES = 20;
export const TARGET_MIN_MGDL = 70;
export const TARGET_MAX_MGDL = 200;

export type CorrectionTerm =
  | { kind: 'included'; units: number; explanation: string }
  | { kind: 'none_needed'; explanation: string }
  | { kind: 'excluded'; reason: 'no_target' | 'no_isf' | 'no_glucose' | 'stale_glucose'; explanation: string };

export type IobTerm =
  | { kind: 'subtracted'; units: number; explanation: string }
  | { kind: 'unknown'; explanation: string };

export type DoseEstimate =
  | {
      kind: 'ok';
      carbsG: number;
      meal: { units: number; text: string; gramsPerUnit: number; explanation: string };
      correction: CorrectionTerm;
      iob: IobTerm;
      combined: { units: number; text: string; explanation: string };
      /** Plain-language limits for this suggestion (not modelled, falling glucose, ...). */
      notes: string[];
    }
  | { kind: 'no_carbs' }
  | { kind: 'ratio_not_set' }
  | { kind: 'ratio_unavailable' }
  | { kind: 'ratio_invalid' }
  | { kind: 'low_glucose'; glucoseMgdl: number }
  | { kind: 'too_high'; units: number };

const r1 = (n: number) => Math.round(n * 10) / 10;

function trim(n: number, decimals = 1): string {
  const t = n.toFixed(decimals);
  return t.includes('.') ? t.replace(/\.?0+$/, '') : t;
}

export function unitsLabel(unitsText: string): string {
  return unitsText === '1' ? 'unit' : 'units';
}

export function estimateDose(args: {
  carbsG: number;
  therapy: SavedTherapy;
  /** The person's own target glucose in mg/dL; null = not set (no default is assumed). */
  targetMgdl: number | null;
  glucose: GlucoseInput | null;
  /** IOB from the server for the logged doses; null = unknown (nothing logged recently). */
  iobUnits: number | null;
  /** When the meal was eaten: its LOCAL clock time picks the ICR segment. */
  mealTime: Date;
  /** Now: its LOCAL clock time picks the ISF segment for the correction. */
  now: Date;
}): DoseEstimate {
  const { carbsG, therapy, targetMgdl, glucose, iobUnits, mealTime, now } = args;
  if (!Number.isFinite(carbsG) || carbsG <= 0) return { kind: 'no_carbs' };
  if (therapy === null) return { kind: 'ratio_unavailable' };
  if (therapy.status !== 'set' || therapy.icrSegments.length === 0) return { kind: 'ratio_not_set' };

  const freshGlucose = glucose !== null && Number.isFinite(glucose.mgdl) && glucose.ageMinutes <= GLUCOSE_FRESH_MINUTES ? glucose : null;
  if (freshGlucose && freshGlucose.mgdl < LOW_GLUCOSE_MGDL) return { kind: 'low_glucose', glucoseMgdl: freshGlucose.mgdl };

  const icr = segmentAt(therapy.icrSegments, mealTime.getHours() * 60 + mealTime.getMinutes());
  if (icr === null || !Number.isFinite(icr.gramsPerUnit) || icr.gramsPerUnit <= 0) return { kind: 'ratio_invalid' };

  const mealUnits = r1(carbsG / icr.gramsPerUnit);
  if (mealUnits > MAX_ESTIMATE_UNITS) return { kind: 'too_high', units: mealUnits };
  const carbsText = trim(carbsG);
  const gramsText = trim(icr.gramsPerUnit, 2);
  const mealExplanation = `${carbsText} g ÷ ${gramsText} g per unit`;

  // ---- correction
  let correction: CorrectionTerm;
  if (targetMgdl === null || !Number.isFinite(targetMgdl)) {
    correction = { kind: 'excluded', reason: 'no_target', explanation: 'Not included: set your target glucose.' };
  } else if (glucose === null) {
    correction = { kind: 'excluded', reason: 'no_glucose', explanation: 'Not included: no glucose reading.' };
  } else if (freshGlucose === null) {
    correction = { kind: 'excluded', reason: 'stale_glucose', explanation: 'Not included: the glucose reading is too old.' };
  } else {
    const isf = segmentAt(
      therapy.isfSegments.map((s) => ({ startMinute: s.startMinute, gramsPerUnit: s.mgdlPerUnit })),
      now.getHours() * 60 + now.getMinutes(),
    );
    if (isf === null || !Number.isFinite(isf.gramsPerUnit) || isf.gramsPerUnit <= 0) {
      correction = { kind: 'excluded', reason: 'no_isf', explanation: 'Not included: no correction factor is saved.' };
    } else if (freshGlucose.mgdl <= targetMgdl) {
      correction = { kind: 'none_needed', explanation: `Glucose ${Math.round(freshGlucose.mgdl)} is at or below your target ${Math.round(targetMgdl)}.` };
    } else {
      const units = r1((freshGlucose.mgdl - targetMgdl) / isf.gramsPerUnit);
      correction = {
        kind: 'included',
        units,
        explanation: `(${Math.round(freshGlucose.mgdl)} − ${Math.round(targetMgdl)}) ÷ ${trim(isf.gramsPerUnit, 2)} mg/dL per unit`,
      };
    }
  }

  // ---- insulin on board
  const iob: IobTerm =
    iobUnits === null || !Number.isFinite(iobUnits)
      ? { kind: 'unknown', explanation: 'Unknown (no recent logged insulin) - nothing subtracted.' }
      : { kind: 'subtracted', units: r1(Math.max(0, iobUnits)), explanation: 'Still acting from the doses you logged.' };

  const corrUnits = correction.kind === 'included' ? correction.units : 0;
  const iobUnitsShown = iob.kind === 'subtracted' ? iob.units : 0;
  const combinedUnits = Math.max(0, r1(mealUnits + corrUnits - iobUnitsShown));
  if (combinedUnits > MAX_ESTIMATE_UNITS) return { kind: 'too_high', units: combinedUnits };

  const mealText = trim(mealUnits);
  const combinedText = trim(combinedUnits);
  const parts = [mealText];
  if (corrUnits > 0) parts.push(`+ ${trim(corrUnits)}`);
  if (iobUnitsShown > 0) parts.push(`− ${trim(iobUnitsShown)}`);
  const combinedExplanation = `${parts.join(' ')} = ${combinedText} ${unitsLabel(combinedText)}`;

  const notes: string[] = [];
  if (freshGlucose && freshGlucose.trendMgdlPerMin !== null && freshGlucose.trendMgdlPerMin <= -2) {
    notes.push('Glucose is falling quickly; the trend is not part of this calculation.');
  }
  if (mealUnits + corrUnits - iobUnitsShown < 0) {
    notes.push('The insulin still on board is more than this meal and correction need, so the combined dose is 0.');
  }

  return {
    kind: 'ok',
    carbsG,
    meal: { units: mealUnits, text: mealText, gramsPerUnit: icr.gramsPerUnit, explanation: mealExplanation },
    correction,
    iob,
    combined: { units: combinedUnits, text: combinedText, explanation: combinedExplanation },
    notes,
  };
}
