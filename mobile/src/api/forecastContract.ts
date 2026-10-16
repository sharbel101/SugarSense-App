/**
 * Contract for `GET /forecast`, mirroring `backend/src/forecasting/forecast-response.ts` (the source of
 * truth; see `backend/src/forecasting/README.md`). Display fields only: units are mg/dL and minutes,
 * times are UTC ISO strings, and `null` means "not available", never zero.
 *
 * No imports on purpose, so plain-Node tests can run it. `parseForecastResponse` is the shape gate:
 * anything that does not match is rejected whole and the caller falls back - it never repairs,
 * fills in or extrapolates a value (root CLAUDE.md section 2).
 */

export type EventRoleDisplay = 'used' | 'range_only' | 'not_used' | 'excluded';

export interface ForecastPointDisplay {
  minutes: number;
  time: string;
  /** Glucose-only model; null after its 120-minute horizon. */
  baseline: number | null;
  /** With the logged meals and insulin taken into account. */
  adjusted: number;
  /** Bounds of the 80% predicted range. */
  low: number;
  high: number;
  /** True after the glucose-only model's horizon: only logged events move the line. */
  extension: boolean;
}

export interface ForecastEventDisplay {
  id: string;
  type: 'meal' | 'insulin';
  time: string;
  role: EventRoleDisplay;
  reason: string;
}

export type InsulinAvailability = 'logged' | 'confirmed_none' | 'none_recorded';

export interface MealAwareDisplay {
  changedForecast: boolean;
  /** The "what if these meals had not been eaten" view. Not a prediction. */
  counterfactual: boolean;
  excludedMealIds: string[];
  availability: {
    mealsUsed: number;
    mealsRangeOnly: number;
    mealsNotUsed: number;
    insulin: InsulinAvailability;
    insulinDosesUsed: number;
    insulinDosesRangeOnly: number;
    /** null = unknown (nothing recorded), never 0 by default. */
    insulinOnBoardUnits: number | null;
    carbsOnBoardGrams: number | null;
    therapySettings: 'available' | 'unavailable';
  };
  events: ForecastEventDisplay[];
}

export interface ForecastOkDisplay {
  status: 'ok';
  anchor: { measuredAt: string; glucoseMgdl: number; ageMinutes: number };
  generatedAt: string;
  horizonMin: number;
  stepMin: 5;
  intervalLevel: 0.8;
  points: ForecastPointDisplay[];
  mealAware: MealAwareDisplay;
  models: { baseline: string | null; eventLayer: string };
  saved: boolean;
  notes: string[];
  disclaimer: string;
}

export interface ForecastBaselineUnavailableDisplay {
  status: 'baseline_unavailable';
  anchor: { measuredAt: string; glucoseMgdl: number; ageMinutes: number };
  reason: string;
  notes: string[];
  disclaimer: string;
}

export interface ForecastStaleDisplay {
  status: 'stale';
  reason: string;
  lastMeasuredAt: string | null;
}

export interface ForecastUnavailableDisplay {
  status: 'unavailable';
  reason: string;
}

export type ForecastDisplay =
  | ForecastOkDisplay
  | ForecastBaselineUnavailableDisplay
  | ForecastStaleDisplay
  | ForecastUnavailableDisplay;

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const isIso = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && Number.isFinite(Date.parse(v));

function parseAnchor(v: unknown): ForecastOkDisplay['anchor'] | null {
  if (!isRec(v) || !isIso(v.measuredAt)) return null;
  const glucose = num(v.glucoseMgdl);
  const age = num(v.ageMinutes);
  if (glucose === null || glucose < 20 || glucose > 600 || age === null || age < 0) return null;
  return { measuredAt: v.measuredAt, glucoseMgdl: glucose, ageMinutes: age };
}

function strings(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v.every((s) => typeof s === 'string') ? (v as string[]) : null;
}

function parsePoints(v: unknown): ForecastPointDisplay[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out: ForecastPointDisplay[] = [];
  for (let i = 0; i < v.length; i++) {
    const p = v[i];
    if (!isRec(p) || !isIso(p.time)) return null;
    const minutes = num(p.minutes);
    const adjusted = num(p.adjusted);
    const low = num(p.low);
    const high = num(p.high);
    // `baseline` may be null (after its horizon) but must not be present-and-garbage.
    const baseline = p.baseline === null ? null : num(p.baseline);
    if (p.baseline !== null && baseline === null) return null;
    if (minutes === null || adjusted === null || low === null || high === null) return null;
    if (typeof p.extension !== 'boolean') return null;
    if (low > high) return null;
    // Every 5 minutes, starting at +5: anything else is not this contract.
    if (minutes !== (i + 1) * 5) return null;
    out.push({ minutes, time: p.time, baseline, adjusted, low, high, extension: p.extension });
  }
  return out;
}

function parseMealAware(v: unknown): MealAwareDisplay | null {
  if (!isRec(v) || typeof v.changedForecast !== 'boolean' || typeof v.counterfactual !== 'boolean') return null;
  const excluded = strings(v.excludedMealIds);
  if (excluded === null || !isRec(v.availability) || !Array.isArray(v.events)) return null;
  const a = v.availability;
  const mealsUsed = num(a.mealsUsed);
  const mealsRangeOnly = num(a.mealsRangeOnly);
  const mealsNotUsed = num(a.mealsNotUsed);
  const dosesUsed = num(a.insulinDosesUsed);
  const dosesRange = num(a.insulinDosesRangeOnly);
  if (mealsUsed === null || mealsRangeOnly === null || mealsNotUsed === null || dosesUsed === null || dosesRange === null) return null;
  if (a.insulin !== 'logged' && a.insulin !== 'confirmed_none' && a.insulin !== 'none_recorded') return null;
  if (a.therapySettings !== 'available' && a.therapySettings !== 'unavailable') return null;
  // null stays null (unknown); a non-number non-null value is off-shape.
  const iob = a.insulinOnBoardUnits === null ? null : num(a.insulinOnBoardUnits);
  const cob = a.carbsOnBoardGrams === null ? null : num(a.carbsOnBoardGrams);
  if ((a.insulinOnBoardUnits !== null && iob === null) || (a.carbsOnBoardGrams !== null && cob === null)) return null;

  const events: ForecastEventDisplay[] = [];
  for (const e of v.events) {
    if (!isRec(e) || typeof e.id !== 'string' || !isIso(e.time) || typeof e.reason !== 'string') return null;
    if (e.type !== 'meal' && e.type !== 'insulin') return null;
    if (e.role !== 'used' && e.role !== 'range_only' && e.role !== 'not_used' && e.role !== 'excluded') return null;
    events.push({ id: e.id, type: e.type, time: e.time, role: e.role, reason: e.reason });
  }
  return {
    changedForecast: v.changedForecast,
    counterfactual: v.counterfactual,
    excludedMealIds: excluded,
    availability: {
      mealsUsed,
      mealsRangeOnly,
      mealsNotUsed,
      insulin: a.insulin,
      insulinDosesUsed: dosesUsed,
      insulinDosesRangeOnly: dosesRange,
      insulinOnBoardUnits: iob,
      carbsOnBoardGrams: cob,
      therapySettings: a.therapySettings,
    },
    events,
  };
}

/** Returns `null` when the body is not a recognisable `ForecastDisplay`. */
export function parseForecastResponse(body: unknown): ForecastDisplay | null {
  if (!isRec(body)) return null;

  if (body.status === 'unavailable') {
    return { status: 'unavailable', reason: str(body.reason) ?? 'The forecast is not available right now.' };
  }
  if (body.status === 'stale') {
    return {
      status: 'stale',
      reason: str(body.reason) ?? 'The latest glucose reading is too old to forecast from.',
      lastMeasuredAt: isIso(body.lastMeasuredAt) ? body.lastMeasuredAt : null,
    };
  }

  if (body.status === 'baseline_unavailable') {
    const anchor = parseAnchor(body.anchor);
    const notes = strings(body.notes);
    const reason = str(body.reason);
    if (!anchor || !notes || reason === null) return null;
    return { status: 'baseline_unavailable', anchor, reason, notes, disclaimer: str(body.disclaimer) ?? '' };
  }

  if (body.status !== 'ok') return null;
  const anchor = parseAnchor(body.anchor);
  const points = parsePoints(body.points);
  const mealAware = parseMealAware(body.mealAware);
  const notes = strings(body.notes);
  const horizon = num(body.horizonMin);
  if (!anchor || !points || !mealAware || !notes || horizon === null) return null;
  if (!isIso(body.generatedAt) || typeof body.saved !== 'boolean') return null;
  if (body.stepMin !== 5 || body.intervalLevel !== 0.8) return null;
  if (!isRec(body.models) || typeof body.models.eventLayer !== 'string') return null;
  if (typeof body.disclaimer !== 'string') return null;
  return {
    status: 'ok',
    anchor,
    generatedAt: body.generatedAt,
    horizonMin: horizon,
    stepMin: 5,
    intervalLevel: 0.8,
    points,
    mealAware,
    models: { baseline: str(body.models.baseline), eventLayer: body.models.eventLayer },
    saved: body.saved,
    notes,
    disclaimer: body.disclaimer,
  };
}

export const FORECAST_REQUEST_TIMEOUT_MS = 15_000;

/**
 * `not_deployed` = HTTP 404 or 503: the server cannot do this (yet). The caller keeps the old
 * glucose-only behaviour and says so; it never treats this as a forecast.
 */
export type ForecastFetchOutcome =
  | { kind: 'response'; response: ForecastDisplay }
  | { kind: 'error'; cause: 'not_deployed' | 'network' | 'timeout' | 'bad_status' | 'invalid_body' | 'aborted' };

/** `GET ${baseUrl}/forecast`. Never throws. */
export async function fetchForecastFrom(
  baseUrl: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
  extraHeaders: Record<string, string> = {},
): Promise<ForecastFetchOutcome> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, FORECAST_REQUEST_TIMEOUT_MS);
  const onOuterAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  try {
    const res = await fetchImpl(`${baseUrl}/forecast`, {
      method: 'GET',
      headers: { Accept: 'application/json', ...extraHeaders },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (res.status === 404 || res.status === 503) return { kind: 'error', cause: 'not_deployed' };
    if (!res.ok) return { kind: 'error', cause: 'bad_status' };
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { kind: 'error', cause: 'invalid_body' };
    }
    const response = parseForecastResponse(body);
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
