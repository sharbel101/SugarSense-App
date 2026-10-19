import { STEP_MIN, trendResponseAt } from './params.js';
import type { BaselinePoint, BaselineSigmaFn } from './compose.js';

/**
 * Glucose-only fallback for when the frozen model (direct_120) cannot run because the recent history is too short or has a hole in
 * it (it needs 12 readings over 50+ minutes with no gap over 20). Persistence plus the recent slope:
 *
 *   forecast(h) = g0 + slope * k_h        slope = least-squares mg/dL per minute over the last few readings
 *
 * k_h is the same measured trend response the deployed model shows (BASELINE_TREND_RESPONSE_MIN), so the event layer's trend-overlap
 * correction stays valid. It is deliberately simple: on this user's own record (8,648 readings over 40 days, read-only backtest
 * 2026-10-19) it matched persistence within 0.3 mg/dL MAE and the model within about 2 mg/dL, so it adds no skill over "stay where you
 * are" and is labelled as such. It is only offered out to 60 minutes.
 */
export const SHORT_HISTORY_MODEL = 'trend_fallback_v1';
export const SHORT_HISTORY_MIN_READINGS = 4;
export const SHORT_HISTORY_MAX_READINGS = 5;
/** All readings used must fall inside this window before the newest one, and be at most this far apart. */
export const SHORT_HISTORY_WINDOW_MIN = 25;
export const SHORT_HISTORY_MAX_GAP_MIN = 10;
export const SHORT_HISTORY_HORIZON_MIN = 60;

/** Measured RMSE (mg/dL) of this fallback by horizon, 4 readings, same backtest. Linear in between. */
const SHORT_HISTORY_SIGMA: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [5, 9],
  [15, 19.3],
  [30, 29],
  [45, 36.4],
  [60, 42.3],
];

export const shortHistorySigma: BaselineSigmaFn = (minutes) => {
  const pts = SHORT_HISTORY_SIGMA;
  const last = pts[pts.length - 1] as readonly [number, number];
  if (minutes >= last[0]) return last[1];
  for (let i = 1; i < pts.length; i += 1) {
    const [x1, y1] = pts[i] as readonly [number, number];
    const [x0, y0] = pts[i - 1] as readonly [number, number];
    if (minutes <= x1) return y0 + ((y1 - y0) * (minutes - x0)) / (x1 - x0);
  }
  return last[1];
};

export interface Reading {
  /** Unix seconds. */
  sec: number;
  mgdl: number;
}

export type ShortHistoryResult =
  | { ok: true; baseline: BaselinePoint[]; readingsUsed: number; slopeMgdlPerMin: number }
  | { ok: false; reason: string };

/** `readings` must already be real readings (never interpolated); the newest one is the anchor. */
export function shortHistoryBaseline(readings: readonly Reading[]): ShortHistoryResult {
  const sorted = [...readings].sort((a, b) => a.sec - b.sec);
  if (sorted.length === 0) return { ok: false, reason: 'no readings' };
  const newest = sorted[sorted.length - 1] as Reading;
  const recent = sorted.filter((r) => newest.sec - r.sec <= SHORT_HISTORY_WINDOW_MIN * 60).slice(-SHORT_HISTORY_MAX_READINGS);
  if (recent.length < SHORT_HISTORY_MIN_READINGS) {
    return { ok: false, reason: `fewer than ${SHORT_HISTORY_MIN_READINGS} readings in the last ${SHORT_HISTORY_WINDOW_MIN} minutes` };
  }
  for (let i = 1; i < recent.length; i += 1) {
    if (((recent[i] as Reading).sec - (recent[i - 1] as Reading).sec) / 60 > SHORT_HISTORY_MAX_GAP_MIN) {
      return { ok: false, reason: `a gap of more than ${SHORT_HISTORY_MAX_GAP_MIN} minutes between the latest readings` };
    }
  }
  const pts = recent.map((r) => ({ t: (r.sec - newest.sec) / 60, v: r.mgdl }));
  const mt = pts.reduce((s, p) => s + p.t, 0) / pts.length;
  const mv = pts.reduce((s, p) => s + p.v, 0) / pts.length;
  const den = pts.reduce((s, p) => s + (p.t - mt) ** 2, 0);
  const slope = den === 0 ? 0 : pts.reduce((s, p) => s + (p.t - mt) * (p.v - mv), 0) / den;
  const baseline: BaselinePoint[] = [];
  for (let m = STEP_MIN; m <= SHORT_HISTORY_HORIZON_MIN; m += STEP_MIN) {
    baseline.push({ minutes: m, value: Math.round((newest.mgdl + slope * trendResponseAt(m)) * 10) / 10 });
  }
  return { ok: true, baseline, readingsUsed: recent.length, slopeMgdlPerMin: Math.round(slope * 1000) / 1000 };
}
