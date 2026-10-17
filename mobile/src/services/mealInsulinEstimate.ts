/**
 * Estimated meal insulin from the person's SAVED insulin-to-carbohydrate ratio (grams of
 * carbohydrate covered by 1 unit, as stored by `GET /therapy/settings`).
 *
 *     units = confirmed carbohydrates (g) / grams per unit
 *
 * This is deliberately the ONLY term: no correction for glucose, no insulin on board, no exercise
 * or illness, and no forecast value ever enters it (root CLAUDE.md section 2). It is an estimate to
 * check against the person's own care plan, never an instruction, and never what was actually taken -
 * "taken" is a separate, user-entered record. Pure, no imports, so plain-Node tests can run it.
 */

export type RatioSegment = { startMinute: number; gramsPerUnit: number };

/** What the settings screen last saved; `null` = could not be read (offline, route missing). */
export type SavedRatio = { status: 'set' | 'not_set'; icrSegments: RatioSegment[] } | null;

/** A sanity ceiling only. The person's own maximum does not exist in the app yet. */
export const MAX_ESTIMATE_UNITS = 50;
/** Below this the estimate is withheld and the low is shown first (root CLAUDE.md section 10, rule 1). */
export const LOW_GLUCOSE_MGDL = 70;

export type InsulinEstimate =
  | {
      kind: 'ok';
      units: number;
      /** "4.5" - one decimal, a trailing ".0" dropped. */
      unitsText: string;
      gramsPerUnit: number;
      carbsG: number;
      /** "45 g carbs ÷ 10 g per unit = 4.5 units" */
      explanation: string;
      /** "00:00" - the time-of-day segment of the ratio that applied at the meal time. */
      segmentFrom: string;
    }
  | { kind: 'no_carbs' }
  | { kind: 'ratio_not_set' }
  | { kind: 'ratio_unavailable' }
  | { kind: 'ratio_invalid' }
  | { kind: 'low_glucose'; glucoseMgdl: number }
  | { kind: 'too_high'; units: number };

const hhmm = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

/** The segment in force at `minuteOfDay` (local): the one with the largest start <= that minute. */
export function segmentAt(segments: RatioSegment[], minuteOfDay: number): RatioSegment | null {
  let best: RatioSegment | null = null;
  for (const s of segments) {
    if (!Number.isFinite(s.startMinute) || s.startMinute > minuteOfDay) continue;
    if (best === null || s.startMinute > best.startMinute) best = s;
  }
  return best;
}

function trimNumber(n: number, decimals: number): string {
  const t = n.toFixed(decimals);
  return t.includes('.') ? t.replace(/\.?0+$/, '') : t;
}

export function estimateMealInsulin(args: {
  carbsG: number;
  ratio: SavedRatio;
  /** The moment the meal was eaten; its LOCAL clock time picks the ratio segment. */
  mealTime: Date;
  /** Latest glucose reading, or null when none is available. Only used to withhold the estimate at a low. */
  latestGlucoseMgdl: number | null;
}): InsulinEstimate {
  const { carbsG, ratio, mealTime, latestGlucoseMgdl } = args;
  if (!Number.isFinite(carbsG) || carbsG <= 0) return { kind: 'no_carbs' };
  if (ratio === null) return { kind: 'ratio_unavailable' };
  if (ratio.status !== 'set' || ratio.icrSegments.length === 0) return { kind: 'ratio_not_set' };

  if (latestGlucoseMgdl !== null && Number.isFinite(latestGlucoseMgdl) && latestGlucoseMgdl < LOW_GLUCOSE_MGDL) {
    return { kind: 'low_glucose', glucoseMgdl: latestGlucoseMgdl };
  }

  const minute = mealTime.getHours() * 60 + mealTime.getMinutes();
  const seg = segmentAt(ratio.icrSegments, minute);
  if (seg === null || !Number.isFinite(seg.gramsPerUnit) || seg.gramsPerUnit <= 0) return { kind: 'ratio_invalid' };

  const raw = carbsG / seg.gramsPerUnit;
  const units = Math.round(raw * 10) / 10;
  if (units > MAX_ESTIMATE_UNITS) return { kind: 'too_high', units };

  const unitsText = trimNumber(units, 1);
  const carbsText = trimNumber(carbsG, 1);
  const gramsText = trimNumber(seg.gramsPerUnit, 2);
  return {
    kind: 'ok',
    units,
    unitsText,
    gramsPerUnit: seg.gramsPerUnit,
    carbsG,
    explanation: `${carbsText} g carbs ÷ ${gramsText} g per unit = ${unitsText} ${unitsText === '1' ? 'unit' : 'units'}`,
    segmentFrom: hhmm(seg.startMinute),
  };
}
