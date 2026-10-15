/**
 * Contract for `GET /glucose`, mirroring `backend/src/glucose/glucose-response.ts` (the source of
 * truth; see `backend/src/glucose/README.md`). A discriminated union on `status`: the `stale` and
 * `unavailable` variants structurally carry NO glucose number, so a failure can never be shown as
 * a reading.
 *
 * This file has no imports on purpose: it is pure (the base URL is injected), so the unit tests can run it
 * under plain Node.
 * `parseGlucoseResponse` is the client-side shape gate (the mobile app has no Zod): anything that
 * does not match is rejected as a whole and the caller shows "unavailable" - it never repairs or
 * guesses a value (root CLAUDE.md section 2).
 */

export interface GlucosePoint {
  /** ISO-8601 UTC. */
  time: string;
  /** mg/dL - the only unit in this contract. */
  value: number;
}

/**
 * `null` means "the forecast service did not supply this" - never "no" or "zero". `alert: null` is
 * NOT `alert: false` and must never be rendered as an all-clear.
 */
export interface GlucoseRisk {
  alert: boolean | null;
  /** `alreadyLow` for the low group, `alreadyHigh` for the high group. */
  already: boolean | null;
  headline: string | null;
  alertSince: string | null;
  predicted15: number | null;
  predicted30: number | null;
  predicted45: number | null;
  probability15: number | null;
  probability30: number | null;
  probability45: number | null;
}

export type RangeMinutes = 15 | 30 | 45;

export interface GlucoseRange {
  minutes: RangeMinutes;
  low: number;
  high: number;
  forecast: number;
}

export interface GlucoseOk {
  status: 'ok';
  glucoseMgdl: number;
  /** Newest reading, ISO UTC. */
  measuredAt: string;
  /** Whole minutes since `measuredAt` at the time the server answered (rounded up). */
  ageMinutes: number;
  history: GlucosePoint[];
  /** Up to +120 min; empty whenever `forecastAvailable` is false. */
  predictions: GlucosePoint[];
  forecastAvailable: boolean;
  forecastUnavailableReason: string | null;
  low: GlucoseRisk;
  high: GlucoseRisk;
  /** `null` when the service supplied none - never invent a band. */
  ranges: GlucoseRange[] | null;
  /** True when the ranges come from a service still in shadow mode (not validated). */
  rangesAreShadow: boolean;
  modelVersion: string | null;
  generatedAt: string | null;
}

export interface GlucoseStale {
  status: 'stale';
  reason: string;
  lastMeasuredAt: string | null;
}

export interface GlucoseUnavailable {
  status: 'unavailable';
  reason: string;
}

export type GlucoseResponse = GlucoseOk | GlucoseStale | GlucoseUnavailable;

/** CLAUDE.md section 12 L1: glucose outside 20-600 mg/dL is implausible and never shown. */
export const GLUCOSE_MIN_MGDL = 20;
export const GLUCOSE_MAX_MGDL = 600;

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

function isIso(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && Number.isFinite(Date.parse(v));
}

function points(v: unknown): GlucosePoint[] | null {
  if (!Array.isArray(v)) return null;
  const out: GlucosePoint[] = [];
  for (const p of v) {
    if (!isRec(p) || !isIso(p.time)) return null;
    const value = num(p.value);
    if (value === null || value < GLUCOSE_MIN_MGDL || value > GLUCOSE_MAX_MGDL) return null;
    out.push({ time: p.time, value });
  }
  out.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  return out;
}

function risk(v: unknown, alreadyKey: 'alreadyLow' | 'alreadyHigh'): GlucoseRisk {
  // A missing or malformed group degrades to all-null ("not supplied"), never to "no risk".
  const r = isRec(v) ? v : {};
  return {
    alert: bool(r.alert),
    already: bool(r[alreadyKey]),
    headline: str(r.headline),
    alertSince: str(r.alertSince),
    predicted15: num(r.predicted15),
    predicted30: num(r.predicted30),
    predicted45: num(r.predicted45),
    probability15: num(r.probability15),
    probability30: num(r.probability30),
    probability45: num(r.probability45),
  };
}

function ranges(v: unknown): GlucoseRange[] | null {
  if (!Array.isArray(v)) return null;
  const out: GlucoseRange[] = [];
  for (const r of v) {
    if (!isRec(r)) continue;
    const minutes = r.minutes;
    const low = num(r.low);
    const high = num(r.high);
    const forecast = num(r.forecast);
    if (minutes !== 15 && minutes !== 30 && minutes !== 45) continue;
    if (low === null || high === null || forecast === null || low > high) continue;
    out.push({ minutes, low, high, forecast });
  }
  out.sort((a, b) => a.minutes - b.minutes);
  return out.length > 0 ? out : null;
}

/**
 * Validate an arbitrary JSON body. Returns `null` when it is not a recognisable `GlucoseResponse`
 * (the caller then shows "unavailable"). A `status: "ok"` body with an implausible glucose, a
 * non-ISO timestamp or missing history is rejected as a whole.
 */
export function parseGlucoseResponse(body: unknown): GlucoseResponse | null {
  if (!isRec(body)) return null;

  if (body.status === 'unavailable') {
    return { status: 'unavailable', reason: str(body.reason) ?? 'Glucose is not available right now.' };
  }

  if (body.status === 'stale') {
    const last = body.lastMeasuredAt;
    return {
      status: 'stale',
      reason: str(body.reason) ?? 'The latest glucose reading is too old to show.',
      lastMeasuredAt: isIso(last) ? last : null,
    };
  }

  if (body.status !== 'ok') return null;

  const glucose = num(body.glucoseMgdl);
  if (glucose === null || glucose < GLUCOSE_MIN_MGDL || glucose > GLUCOSE_MAX_MGDL) return null;
  if (!isIso(body.measuredAt)) return null;
  const age = num(body.ageMinutes);
  if (age === null || age < 0) return null;
  const history = points(body.history);
  const predictions = points(body.predictions);
  if (history === null || predictions === null) return null;

  const forecastAvailableRaw = bool(body.forecastAvailable);
  if (forecastAvailableRaw === null) return null;
  // "available" with no points is not available: never claim a forecast we cannot draw.
  const forecastAvailable = forecastAvailableRaw && predictions.length > 0;

  return {
    status: 'ok',
    glucoseMgdl: glucose,
    measuredAt: body.measuredAt,
    ageMinutes: age,
    history,
    predictions: forecastAvailable ? predictions : [],
    forecastAvailable,
    forecastUnavailableReason: str(body.forecastUnavailableReason),
    low: risk(body.low, 'alreadyLow'),
    high: risk(body.high, 'alreadyHigh'),
    ranges: forecastAvailable ? ranges(body.ranges) : null,
    // Unknown provenance is treated as shadow (not validated), the safe direction.
    rangesAreShadow: bool(body.rangesAreShadow) ?? true,
    modelVersion: str(body.modelVersion),
    generatedAt: isIso(body.generatedAt) ? body.generatedAt : null,
  };
}

/** Longer than the backend's own 8 s upstream timeout, so a slow upstream is reported by the server. */
export const GLUCOSE_REQUEST_TIMEOUT_MS = 12_000;

export type GlucoseFetchOutcome =
  | { kind: 'response'; response: GlucoseResponse }
  | { kind: 'error'; cause: 'network' | 'timeout' | 'bad_status' | 'invalid_body' | 'aborted' };

/**
 * `GET ${baseUrl}/glucose` - no params, no auth header yet (the backend has no auth). Never throws:
 * every failure becomes an `error` outcome, which the caller must show as "unavailable", never as
 * a number. Nothing from the body is logged (health data).
 *
 * `signal` lets the caller abort on unmount / backgrounding; that is reported as `aborted` and the
 * caller must ignore it.
 */
export async function fetchGlucoseFrom(
  baseUrl: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
  /** Transport-only headers (e.g. the ngrok interstitial bypass). Never credentials or health data. */
  extraHeaders: Record<string, string> = {},
): Promise<GlucoseFetchOutcome> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, GLUCOSE_REQUEST_TIMEOUT_MS);
  const onOuterAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onOuterAbort, { once: true });
  }

  try {
    const res = await fetchImpl(`${baseUrl}/glucose`, {
      method: 'GET',
      headers: { Accept: 'application/json', ...extraHeaders },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!res.ok) return { kind: 'error', cause: 'bad_status' };
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { kind: 'error', cause: 'invalid_body' };
    }
    const response = parseGlucoseResponse(body);
    if (response === null) return { kind: 'error', cause: 'invalid_body' };
    return { kind: 'response', response };
  } catch {
    if (timedOut) return { kind: 'error', cause: 'timeout' };
    if (controller.signal.aborted) return { kind: 'error', cause: 'aborted' };
    return { kind: 'error', cause: 'network' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
  }
}
