/**
 * The HTTP response contract for GET /glucose. A discriminated union on `status`, same philosophy as
 * `MealAnalysisResponse`: the two non-"ok" variants structurally CANNOT carry a glucose number, so a
 * failure can never be mistaken for a (possibly in-range) reading. The route answers HTTP 200 for all
 * three - they are handled states, not transport errors.
 *
 * Strings that originate upstream (`time`, `measuredAt`, `alertSince`, `headline`, ...) are passed
 * through unmodified.
 */

export interface GlucosePoint {
  /** ISO-8601, exactly as the forecast service emitted it. */
  time: string;
  /** mg/dL - the only unit anywhere in this contract. */
  value: number;
}

/**
 * `null` always means "the forecast service did not supply this" - never "no" or "zero". In
 * particular `alert: null` is NOT `alert: false`; clients must not treat it as an all-clear.
 */
export interface GlucoseLowRisk {
  alert: boolean | null;
  alreadyLow: boolean | null;
  headline: string | null;
  alertSince: string | null;
  predicted15: number | null;
  predicted30: number | null;
  predicted45: number | null;
  probability15: number | null;
  probability30: number | null;
  probability45: number | null;
}

export interface GlucoseHighRisk {
  alert: boolean | null;
  alreadyHigh: boolean | null;
  headline: string | null;
  alertSince: string | null;
  predicted15: number | null;
  predicted30: number | null;
  predicted45: number | null;
  probability15: number | null;
  probability30: number | null;
  probability45: number | null;
}

export interface GlucoseRange {
  minutes: 15 | 30 | 45;
  low: number;
  high: number;
  forecast: number;
}

export interface GlucoseOkResponse {
  status: 'ok';
  glucoseMgdl: number;
  /** Time of the newest reading (upstream `timestamp`). */
  measuredAt: string;
  /** Whole minutes since `measuredAt`, rounded UP so a reading is never shown fresher than it is. */
  ageMinutes: number;
  history: GlucosePoint[];
  /** Up to +120 minutes. Empty whenever `forecastAvailable` is false. */
  predictions: GlucosePoint[];
  forecastAvailable: boolean;
  forecastUnavailableReason: string | null;
  trendMgdlPerMin: number | null;
  low: GlucoseLowRisk;
  high: GlucoseHighRisk;
  /** Excursion ranges per horizon; `null` when the upstream supplied none. */
  ranges: GlucoseRange[] | null;
  /** True when the ranges come from an upstream still in "shadow" mode (not validated). Label them. */
  rangesAreShadow: boolean;
  /** `null` only if the forecast service omitted its provenance block. */
  modelVersion: string | null;
  generatedAt: string | null;
  servedAt: string | null;
}

export interface GlucoseStaleResponse {
  status: 'stale';
  reason: string;
  /** Upstream timestamp of the too-old reading when we know it; `null` when upstream only said "stale". */
  lastMeasuredAt: string | null;
}

export interface GlucoseUnavailableResponse {
  status: 'unavailable';
  reason: string;
}

export type GlucoseResponse = GlucoseOkResponse | GlucoseStaleResponse | GlucoseUnavailableResponse;
