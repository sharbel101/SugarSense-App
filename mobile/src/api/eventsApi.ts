/**
 * Typed client for the event routes (`backend/src/forecasting`): POST /events/meals,
 * POST /events/insulin, PATCH /events/meals/:id, PATCH /events/insulin/:id, GET /events/recent.
 *
 * Pure (base URL, fetch and headers are injected) so plain-Node tests can run it. Never throws:
 * every failure is a typed result. Request bodies carry only the fields the person actually gave -
 * a blank field is OMITTED (unknown), never sent as 0 (root CLAUDE.md section 2).
 */
import { parseForecastResponse, type ForecastDisplay } from './forecastContract.ts';
import type { AbsorptionClass, InsulinEvent, InsulinKind, MealEvent } from '../services/events';

export type ApiContext = {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  /** Transport headers only (ngrok bypass, optional app token). Never health data. */
  headers?: Record<string, string>;
};

/**
 * `created | exists | updated | unchanged` = the server has it. `duplicate` / `conflict` / `invalid` /
 * `not_found` carry a `reason`. `server_unavailable` (404 route missing, 503, 429, 401, 5xx) and
 * `network_error` mean "not confirmed": the caller keeps the entry pending, never calls it saved.
 */
export type WriteResult =
  | 'created'
  | 'exists'
  | 'updated'
  | 'unchanged'
  | 'duplicate'
  | 'conflict'
  | 'not_found'
  | 'invalid'
  | 'server_unavailable'
  | 'network_error';

export const SERVER_HAS_IT: ReadonlySet<WriteResult> = new Set(['created', 'exists', 'updated', 'unchanged']);

export type WriteOutcome<V> = {
  result: WriteResult;
  item: V | null;
  reason?: string;
  duplicateOf?: string;
  /** The refreshed forecast the server returned with the write; null when absent or off-shape. */
  forecast: ForecastDisplay | null;
};

export type MealStatus = 'confirmed' | 'cancelled' | 'pending' | string;
export interface MealView {
  id: string;
  /** The meal's name when the server stored one; null otherwise. */
  label: string | null;
  eatenAt: string;
  status: MealStatus;
  carbs: {
    grams: number | null;
    kind: 'estimated' | 'user_corrected' | 'user_entered' | 'missing';
    estimateRangeG: { low: number; high: number } | null;
  };
  fatG: number | null;
  proteinG: number | null;
  fiberG: number | null;
  absorptionClass: AbsorptionClass | null;
  timeApproximateMin: number;
  edited: boolean;
  revision: number;
}

export interface InsulinView {
  id: string;
  administeredAt: string;
  kind: InsulinKind | 'other';
  insulinType: string | null;
  /** null while unknown or planned - never shown as 0. */
  unitsTaken: number | null;
  confirmation: 'confirmed' | 'uncertain' | 'planned';
  mealId: string | null;
  /** 'cancelled' = withdrawn as a mistake: kept in the history, ignored by the forecast. */
  status: 'active' | 'cancelled';
  revision: number;
}

// ------------------------------------------------------------------------------ payload builders

const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s);

export type MealPayload = {
  clientId: string;
  eatenAt: string;
  carbsG: number;
  fatG?: number;
  proteinG?: number;
  fiberG?: number;
  absorptionClass?: AbsorptionClass;
  timingUncertaintyMin?: number;
  note?: string;
  allowDuplicate?: boolean;
};

/** Blank fat/protein/fibre/speed/approximate-time are omitted. The label travels in `note` (no label field yet). */
export function buildMealPayload(e: MealEvent, allowDuplicate = false): MealPayload {
  const note = e.notes ? `${e.label}: ${e.notes}` : e.label;
  return {
    clientId: e.id,
    eatenAt: e.occurredAtUtc,
    carbsG: Math.round(e.carbsG * 10) / 10,
    ...(e.fatG !== null ? { fatG: e.fatG } : null),
    ...(e.proteinG !== null ? { proteinG: e.proteinG } : null),
    ...(e.fiberG !== null ? { fiberG: e.fiberG } : null),
    ...(e.absorptionClass !== null ? { absorptionClass: e.absorptionClass } : null),
    ...(e.timeApproximate ? { timingUncertaintyMin: 15 } : null),
    ...(note ? { note: clip(note, 500) } : null),
    ...(allowDuplicate ? { allowDuplicate: true } : null),
  };
}

export type InsulinPayload = {
  clientId: string;
  administeredAt: string;
  kind: InsulinKind;
  confirmation: 'confirmed' | 'uncertain';
  unitsAdministered: number;
  insulinType: string;
  mealId?: string;
  timingUncertain?: boolean;
  allowDuplicate?: boolean;
};

/**
 * "None taken" is `unitsAdministered: 0` with `confirmation: 'confirmed'`. Insulin notes and the
 * optional glucose reading are not sent (the server has no field for them). Time-uncertainty is
 * omitted unless the person said they are not sure.
 */
export function buildInsulinPayload(e: InsulinEvent, allowDuplicate = false): InsulinPayload {
  return {
    clientId: e.id,
    administeredAt: e.occurredAtUtc,
    kind: e.insulinKind,
    confirmation: e.confirmation,
    unitsAdministered: Math.round(e.unitsAdministered * 100) / 100,
    insulinType: e.insulinType,
    ...(e.mealId ? { mealId: e.mealId } : null),
    ...(e.timingUncertain ? { timingUncertain: true } : null),
    ...(allowDuplicate ? { allowDuplicate: true } : null),
  };
}

// ------------------------------------------------------------------------------------- transport

type Raw = { kind: 'http'; status: number; body: unknown } | { kind: 'network' };

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const isIso = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));

export const EVENT_REQUEST_TIMEOUT_MS = 15_000;

async function send(ctx: ApiContext, method: string, path: string, body?: unknown): Promise<Raw> {
  const f = ctx.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EVENT_REQUEST_TIMEOUT_MS);
  try {
    const res = await f(`${ctx.baseUrl}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : null),
        ...(ctx.headers ?? {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : null),
      cache: 'no-store',
      signal: controller.signal,
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { kind: 'http', status: res.status, body: json };
  } catch {
    return { kind: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

const KNOWN: ReadonlySet<string> = new Set(['created', 'exists', 'updated', 'unchanged', 'duplicate', 'conflict', 'not_found', 'invalid']);

function validationReason(body: unknown): string {
  if (isRec(body)) {
    const m = body.message;
    if (typeof m === 'string' && m) return m;
    if (Array.isArray(m) && typeof m[0] === 'string') return m[0];
    if (typeof body.reason === 'string' && body.reason) return body.reason;
  }
  return 'The server rejected this entry.';
}

function mapWrite<V>(raw: Raw, itemKey: string, parseItem: (v: unknown) => V | null): WriteOutcome<V> {
  if (raw.kind === 'network') return { result: 'network_error', item: null, forecast: null };
  const { status, body } = raw;
  const known = isRec(body) && typeof body.result === 'string' && KNOWN.has(body.result);

  if (status === 400) return { result: 'invalid', item: null, reason: validationReason(body), forecast: null };
  // 404 with a body result = the entry is missing; a bare 404 = the route is not deployed.
  if (status === 404 && !(known && isRec(body) && body.result === 'not_found')) {
    return { result: 'server_unavailable', item: null, forecast: null };
  }
  if (!known || !isRec(body)) return { result: 'server_unavailable', item: null, forecast: null };

  const forecast = body.forecast === null || body.forecast === undefined ? null : parseForecastResponse(body.forecast);
  const reason = str(body.reason) ?? undefined;
  const duplicateOf = str(body.duplicateOf) ?? undefined;
  return {
    result: body.result as WriteResult,
    item: parseItem(body[itemKey]),
    ...(reason ? { reason } : null),
    ...(duplicateOf ? { duplicateOf } : null),
    forecast,
  };
}

// ------------------------------------------------------------------------------------ view parsing

function parseMealView(v: unknown): MealView | null {
  if (!isRec(v) || typeof v.id !== 'string' || !isIso(v.eatenAt) || typeof v.status !== 'string') return null;
  const revision = num(v.revision);
  if (revision === null || !isRec(v.carbs)) return null;
  const c = v.carbs;
  const kind = c.kind === 'estimated' || c.kind === 'user_corrected' || c.kind === 'user_entered' ? c.kind : 'missing';
  const r = isRec(c.estimateRangeG) ? { low: num(c.estimateRangeG.low), high: num(c.estimateRangeG.high) } : null;
  const absorption = v.absorptionClass === 'fast' || v.absorptionClass === 'medium' || v.absorptionClass === 'slow' ? v.absorptionClass : null;
  return {
    id: v.id,
    label: typeof v.label === 'string' && v.label.trim() !== '' ? v.label.trim() : null,
    eatenAt: v.eatenAt,
    status: v.status,
    carbs: {
      grams: num(c.grams),
      kind,
      estimateRangeG: r && r.low !== null && r.high !== null ? { low: r.low, high: r.high } : null,
    },
    fatG: num(v.fatG),
    proteinG: num(v.proteinG),
    fiberG: num(v.fiberG),
    absorptionClass: absorption,
    timeApproximateMin: num(v.timeApproximateMin) ?? 0,
    edited: v.edited === true,
    revision,
  };
}

function parseInsulinView(v: unknown): InsulinView | null {
  if (!isRec(v) || typeof v.id !== 'string' || !isIso(v.administeredAt)) return null;
  const revision = num(v.revision);
  if (revision === null) return null;
  const confirmation = v.confirmation;
  if (confirmation !== 'confirmed' && confirmation !== 'uncertain' && confirmation !== 'planned') return null;
  const kind = v.kind === 'bolus' || v.kind === 'correction' || v.kind === 'basal' ? v.kind : 'other';
  return {
    id: v.id,
    administeredAt: v.administeredAt,
    kind,
    insulinType: str(v.insulinType),
    unitsTaken: num(v.unitsTaken),
    confirmation,
    mealId: str(v.mealId),
    status: v.status === 'cancelled' ? 'cancelled' : 'active',
    revision,
  };
}

// ------------------------------------------------------------------------------------- operations

export async function postMeal(ctx: ApiContext, e: MealEvent, allowDuplicate = false): Promise<WriteOutcome<MealView>> {
  return mapWrite(await send(ctx, 'POST', '/events/meals', buildMealPayload(e, allowDuplicate)), 'meal', parseMealView);
}

export async function postInsulin(ctx: ApiContext, e: InsulinEvent, allowDuplicate = false): Promise<WriteOutcome<InsulinView>> {
  return mapWrite(await send(ctx, 'POST', '/events/insulin', buildInsulinPayload(e, allowDuplicate)), 'insulin', parseInsulinView);
}

export type MealPatch = {
  carbsG?: number;
  eatenAt?: string;
  timingUncertaintyMin?: number;
  absorptionClass?: AbsorptionClass;
  status?: 'confirmed' | 'cancelled';
  expectedRevision?: number;
};

export async function patchMeal(ctx: ApiContext, serverId: string, patch: MealPatch): Promise<WriteOutcome<MealView>> {
  return mapWrite(await send(ctx, 'PATCH', `/events/meals/${encodeURIComponent(serverId)}`, patch), 'meal', parseMealView);
}

export type InsulinPatch = {
  unitsAdministered?: number;
  administeredAt?: string;
  confirmation?: 'confirmed' | 'uncertain';
  mealId?: string | null;
  timingUncertain?: boolean;
  /** Withdraw a mistaken entry; it stops acting in the forecast but stays in the history. */
  status?: 'cancelled';
  expectedRevision?: number;
};

export async function patchInsulin(ctx: ApiContext, serverId: string, patch: InsulinPatch): Promise<WriteOutcome<InsulinView>> {
  return mapWrite(await send(ctx, 'PATCH', `/events/insulin/${encodeURIComponent(serverId)}`, patch), 'insulin', parseInsulinView);
}

export type RecentOutcome =
  | { kind: 'ok'; meals: MealView[]; insulin: InsulinView[] }
  | { kind: 'unavailable' };

/** `GET /events/recent?hours=` (1-48). Anything but a well-formed 200 is "unavailable". */
export async function getRecent(ctx: ApiContext, hours: number): Promise<RecentOutcome> {
  const raw = await send(ctx, 'GET', `/events/recent?hours=${Math.min(48, Math.max(1, Math.round(hours)))}`);
  if (raw.kind !== 'http' || raw.status !== 200 || !isRec(raw.body)) return { kind: 'unavailable' };
  if (!Array.isArray(raw.body.meals) || !Array.isArray(raw.body.insulin)) return { kind: 'unavailable' };
  const meals: MealView[] = [];
  for (const m of raw.body.meals) {
    const p = parseMealView(m);
    if (p === null) return { kind: 'unavailable' };
    meals.push(p);
  }
  const insulin: InsulinView[] = [];
  for (const i of raw.body.insulin) {
    const p = parseInsulinView(i);
    if (p === null) return { kind: 'unavailable' };
    insulin.push(p);
  }
  return { kind: 'ok', meals, insulin };
}
