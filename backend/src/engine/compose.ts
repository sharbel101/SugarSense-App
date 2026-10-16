import {
  BASELINE_HORIZON_MIN,
  BASELINE_SIGMA_MEASURED_UP_TO_MIN,
  BASELINE_SIGMA_PRIOR,
  DISPLAY_MAX_MGDL,
  DISPLAY_MIN_MGDL,
  PARAM_BOUNDS,
  Z80,
} from './params.js';
import type { CarbProvenance, EventLayerResult } from './types.js';

/** A function from forecast horizon (minutes) to the 1-sigma of the glucose-only baseline error. */
export type BaselineSigmaFn = (minutes: number) => number;

/**
 * Prior baseline sigma: measured RMSE curve of the deployed model (5-60 min), linearly interpolated,
 * extended past 60 min with the last measured slope. The extension is an extrapolation, not a
 * measurement; callers flag points beyond BASELINE_SIGMA_MEASURED_UP_TO_MIN accordingly.
 */
export function priorBaselineSigma(minutes: number): number {
  const pts = BASELINE_SIGMA_PRIOR;
  const last = pts[pts.length - 1] as readonly [number, number];
  if (minutes >= last[0]) {
    const prev = pts[pts.length - 2] as readonly [number, number];
    const slope = (last[1] - prev[1]) / (last[0] - prev[0]);
    return last[1] + slope * (minutes - last[0]);
  }
  for (let i = 1; i < pts.length; i += 1) {
    const [x1, y1] = pts[i] as readonly [number, number];
    const [x0, y0] = pts[i - 1] as readonly [number, number];
    if (minutes <= x1) return y0 + ((y1 - y0) * (minutes - x0)) / (x1 - x0);
  }
  return last[1];
}

export interface BaselinePoint {
  minutes: number;
  value: number;
}

export interface ForecastPoint {
  minutes: number;
  /** Glucose-only model value; null beyond its 120-minute horizon. */
  baseline: number | null;
  /** Meal/insulin-aware value (equals baseline where the layer changed nothing). */
  adjusted: number;
  low: number;
  high: number;
  /** True beyond the glucose-only model's horizon: baseline is held at its last value, only events move it. */
  extension: boolean;
  /** True when sigma_baseline came from extrapolation rather than measurement. */
  sigmaExtrapolated: boolean;
  clipped: boolean;
  /** Logged insulin / carbs still to act at this time (estimates); null = unknown. */
  insulinOnBoardUnits: number | null;
  carbsOnBoardGrams: number | null;
}

export interface ComposeInput {
  baseline: readonly BaselinePoint[];
  layer: EventLayerResult;
  sigmaBaseline: BaselineSigmaFn;
  horizonMin: number;
}

/**
 * adjusted(h) = baseline(h) + m_csf * mealEffect(h) - m_isf * insulinEffect(h)
 * 1-sigma(h)^2 = sigma_baseline(h)^2 + carb^2 + insulin^2 + timing^2 + fat/protein^2   (independent sources)
 * interval = adjusted -/+ 1.2816 sigma (80%), then stretched by the one-sided scenarios (unknown insulin /
 * unlinked dose) and always to include the glucose-only value, so the two models can never silently
 * disagree outside the band ("when they disagree, say we don't know").
 */
export function composeForecast(input: ComposeInput): ForecastPoint[] {
  const { baseline, layer, sigmaBaseline } = input;
  const s = layer.series;
  const byMin = new Map(baseline.map((p) => [p.minutes, p.value]));
  const lastBaseline = baseline.length > 0 ? (baseline[baseline.length - 1] as BaselinePoint) : null;
  if (lastBaseline === null) return [];

  const out: ForecastPoint[] = [];
  for (let j = 0; j < s.minutes.length; j += 1) {
    const minutes = s.minutes[j] as number;
    if (minutes > input.horizonMin) break;
    const extension = minutes > BASELINE_HORIZON_MIN;
    const base = extension ? lastBaseline.value : (byMin.get(minutes) ?? null);
    if (base === null) continue; // a missing baseline step is skipped, never interpolated
    const adjustedRaw = base + (s.mealApplied[j] as number) - (s.insulinApplied[j] as number);
    const sb = sigmaBaseline(minutes);
    const sigma = Math.sqrt(
      sb ** 2 +
        (s.sigmaCarb[j] as number) ** 2 +
        (s.sigmaInsulin[j] as number) ** 2 +
        (s.sigmaTiming[j] as number) ** 2 +
        (s.sigmaFatProtein[j] as number) ** 2,
    );
    let low = adjustedRaw - Z80 * sigma - (s.scenarioDown[j] as number);
    let high = adjustedRaw + Z80 * sigma + (s.scenarioUp[j] as number);
    low = Math.min(low, base);
    high = Math.max(high, base);

    const clamp = (v: number): number => Math.min(DISPLAY_MAX_MGDL, Math.max(DISPLAY_MIN_MGDL, v));
    const adjusted = clamp(adjustedRaw);
    const clipped = adjusted !== adjustedRaw || clamp(low) !== low || clamp(high) !== high;
    out.push({
      minutes,
      baseline: extension ? null : round1(base),
      adjusted: round1(adjusted),
      low: round1(Math.min(clamp(low), adjusted)),
      high: round1(Math.max(clamp(high), adjusted)),
      extension,
      sigmaExtrapolated: minutes > BASELINE_SIGMA_MEASURED_UP_TO_MIN,
      clipped,
      insulinOnBoardUnits: roundOrNull(s.iobUnits[j] ?? null, 100),
      carbsOnBoardGrams: roundOrNull(s.cobGrams[j] ?? null, 10),
    });
  }
  return out;
}

/**
 * 1-sigma of a carbohydrate estimate in grams.
 *  - Photo estimate with a range: the range is read as an approximate 80% interval (assumption stated
 *    in the docs), floored and capped at the spec's relative-error bounds (10% to 50% of the estimate).
 *  - Anything else (typed in, corrected): the spec's engineering default relative error c_C.
 */
export function carbSigmaG(
  carbsG: number,
  provenance: CarbProvenance,
  rangeLowG: number | null,
  rangeHighG: number | null,
  cC: number,
): number {
  const floor = PARAM_BOUNDS.cC.min * carbsG;
  const cap = PARAM_BOUNDS.cC.max * carbsG;
  if (provenance === 'estimated' && rangeLowG !== null && rangeHighG !== null && rangeHighG >= rangeLowG) {
    return Math.min(cap, Math.max(floor, (rangeHighG - rangeLowG) / (2 * Z80)));
  }
  return Math.min(cap, Math.max(floor, cC * carbsG));
}

const round1 = (v: number): number => Math.round(v * 10) / 10;
const roundOrNull = (v: number | null, scale: number): number | null => (v === null ? null : Math.round(v * scale) / scale);
