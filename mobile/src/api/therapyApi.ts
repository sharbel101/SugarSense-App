/**
 * Client for `GET/PUT /therapy/settings` and `GET /therapy/settings/history`
 * (`backend/src/forecasting/therapy.schema.ts` is the source of truth for limits).
 *
 * ICR = grams of carbohydrate covered by ONE unit of rapid-acting insulin. ISF (correction factor) =
 * mg/dL lowered by ONE unit. These are values the person or their care team entered: this module
 * never pre-fills, suggests or adjusts one. Pure (injected context) so plain-Node tests can run it.
 */
import type { ApiContext } from './eventsApi';

export type TherapySource = 'clinician_prescribed' | 'user_entered';

export interface TherapySettingsView {
  status: 'set' | 'not_set';
  version: number | null;
  effectiveFrom: string | null;
  source: TherapySource | null;
  icrSegments: { startMinute: number; startTime: string; gramsPerUnit: number }[];
  isfSegments: { startMinute: number; startTime: string; mgdlPerUnit: number }[];
  insulinType: 'rapid' | 'ultra_rapid' | null;
  insulinPeakMin: number | null;
  insulinDurationMin: number | null;
  note: string | null;
  whenMissing: string;
  disclaimer: string;
}

export const THERAPY_LIMITS = {
  icrMin: 1,
  icrMax: 150,
  isfMin: 5,
  isfMax: 500,
  maxSegments: 8,
} as const;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function segs<K extends string>(v: unknown, key: K): ({ startMinute: number; startTime: string } & Record<K, number>)[] | null {
  if (!Array.isArray(v)) return null;
  const out: ({ startMinute: number; startTime: string } & Record<K, number>)[] = [];
  for (const s of v) {
    if (!isRec(s)) return null;
    const startMinute = num(s.startMinute);
    const value = num(s[key]);
    if (startMinute === null || value === null) return null;
    out.push({ startMinute, startTime: str(s.startTime) ?? '', [key]: value } as { startMinute: number; startTime: string } & Record<K, number>);
  }
  return out;
}

export function parseTherapyView(body: unknown): TherapySettingsView | null {
  if (!isRec(body) || (body.status !== 'set' && body.status !== 'not_set')) return null;
  const icr = segs(body.icrSegments, 'gramsPerUnit');
  const isf = segs(body.isfSegments, 'mgdlPerUnit');
  if (!icr || !isf) return null;
  const source = body.source === 'clinician_prescribed' || body.source === 'user_entered' ? body.source : null;
  const insulinType = body.insulinType === 'rapid' || body.insulinType === 'ultra_rapid' ? body.insulinType : null;
  return {
    status: body.status,
    version: num(body.version),
    effectiveFrom: str(body.effectiveFrom),
    source,
    icrSegments: icr,
    isfSegments: isf,
    insulinType,
    insulinPeakMin: num(body.insulinPeakMin),
    insulinDurationMin: num(body.insulinDurationMin),
    note: str(body.note),
    whenMissing: str(body.whenMissing) ?? '',
    disclaimer: str(body.disclaimer) ?? '',
  };
}

export type TherapyOutcome<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'invalid'; reason: string }
  | { kind: 'unavailable' };

async function call(ctx: ApiContext, method: string, path: string, body?: unknown) {
  const f = ctx.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
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
    return { status: res.status, json };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function getTherapySettings(ctx: ApiContext): Promise<TherapyOutcome<TherapySettingsView>> {
  const r = await call(ctx, 'GET', '/therapy/settings');
  if (!r || r.status !== 200) return { kind: 'unavailable' };
  const v = parseTherapyView(r.json);
  return v ? { kind: 'ok', value: v } : { kind: 'unavailable' };
}

export async function getTherapyHistory(ctx: ApiContext): Promise<TherapyOutcome<TherapySettingsView[]>> {
  const r = await call(ctx, 'GET', '/therapy/settings/history');
  if (!r || r.status !== 200 || !isRec(r.json) || !Array.isArray(r.json.versions)) return { kind: 'unavailable' };
  const out: TherapySettingsView[] = [];
  for (const v of r.json.versions) {
    const p = parseTherapyView(v);
    if (!p) return { kind: 'unavailable' };
    out.push(p);
  }
  return { kind: 'ok', value: out };
}

export interface TherapyPutBody {
  icrSegments: { startMinute: number; gramsPerUnit: number }[];
  isfSegments?: { startMinute: number; mgdlPerUnit: number }[];
  insulinType?: 'rapid' | 'ultra_rapid';
  source: TherapySource;
  effectiveFrom?: string;
  note?: string;
}

export async function putTherapySettings(ctx: ApiContext, body: TherapyPutBody): Promise<TherapyOutcome<TherapySettingsView>> {
  const r = await call(ctx, 'PUT', '/therapy/settings', body);
  if (!r) return { kind: 'unavailable' };
  if (r.status === 400 || r.status === 422) {
    const m = isRec(r.json) ? r.json.message : null;
    const reason = typeof m === 'string' ? m : Array.isArray(m) && typeof m[0] === 'string' ? m[0] : 'The server rejected these settings.';
    return { kind: 'invalid', reason };
  }
  if (r.status !== 200 && r.status !== 201) return { kind: 'unavailable' };
  const v = parseTherapyView(r.json);
  return v ? { kind: 'ok', value: v } : { kind: 'unavailable' };
}

// ---------------------------------------------------------------------------- form validation

export type TherapyRowInput = { startTime: string; icr: string; isf: string };
export type TherapyFormInput = {
  rows: TherapyRowInput[];
  source: TherapySource | null;
  insulinType: 'rapid' | 'ultra_rapid' | null;
  note: string;
};
export type TherapyFormErrors = {
  rows: { startTime?: string; icr?: string; isf?: string }[];
  source?: string;
  note?: string;
  general?: string;
};

function parseHhmm(text: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h > 23 || min > 59 ? null : h * 60 + min;
}

function decimal(text: string): number | null {
  const t = text.trim().replace(',', '.');
  if (!/^\d*\.?\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const twoDecimals = (v: number) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;

/**
 * Validates with the server's limits. ICR is required on every row; ISF may be left blank on ALL
 * rows (the server then keeps the previous correction factor) but not on some.
 */
export function validateTherapyForm(
  input: TherapyFormInput,
): { ok: true; body: TherapyPutBody } | { ok: false; errors: TherapyFormErrors } {
  const errors: TherapyFormErrors = { rows: input.rows.map(() => ({})) };
  let bad = false;
  const mark = () => {
    bad = true;
  };

  if (input.rows.length === 0) {
    errors.general = 'Add at least one time of day.';
    return { ok: false, errors };
  }
  if (input.rows.length > THERAPY_LIMITS.maxSegments) {
    errors.general = `Use at most ${THERAPY_LIMITS.maxSegments} times of day.`;
    return { ok: false, errors };
  }

  const starts: (number | null)[] = input.rows.map((r) => parseHhmm(r.startTime));
  const icrs: (number | null)[] = input.rows.map((r) => decimal(r.icr));
  const isfFilled = input.rows.map((r) => r.isf.trim() !== '');
  const isfs: (number | null)[] = input.rows.map((r) => (r.isf.trim() === '' ? null : decimal(r.isf)));

  input.rows.forEach((_, i) => {
    const row = errors.rows[i];
    const s = starts[i];
    if (s === null) {
      row.startTime = 'Enter the time as HH:MM, for example 07:30.';
      mark();
    } else if (i === 0 && s !== 0) {
      row.startTime = 'The first time of day must start at 00:00.';
      mark();
    } else if (i > 0 && starts[i - 1] !== null && s <= (starts[i - 1] as number)) {
      row.startTime = 'Each time must be later than the one above.';
      mark();
    }
    const icr = icrs[i];
    if (icr === null || icr < THERAPY_LIMITS.icrMin || icr > THERAPY_LIMITS.icrMax || !twoDecimals(icr)) {
      row.icr = `Grams per unit: ${THERAPY_LIMITS.icrMin}-${THERAPY_LIMITS.icrMax}, up to 2 decimals.`;
      mark();
    }
    if (isfFilled[i]) {
      const isf = isfs[i];
      if (isf === null || isf < THERAPY_LIMITS.isfMin || isf > THERAPY_LIMITS.isfMax || !twoDecimals(isf)) {
        row.isf = `mg/dL per unit: ${THERAPY_LIMITS.isfMin}-${THERAPY_LIMITS.isfMax}, up to 2 decimals.`;
        mark();
      }
    }
  });

  const someIsf = isfFilled.some(Boolean);
  const allIsf = isfFilled.every(Boolean);
  if (someIsf && !allIsf) {
    errors.general = 'Enter the correction factor for every time of day, or leave it blank everywhere.';
    mark();
  }
  if (input.source === null) {
    errors.source = 'Choose where these values come from.';
    mark();
  }
  if (input.note.length > 500) {
    errors.note = 'Keep the note under 500 characters.';
    mark();
  }
  if (bad || input.source === null) return { ok: false, errors };

  const body: TherapyPutBody = {
    icrSegments: input.rows.map((_, i) => ({ startMinute: starts[i] as number, gramsPerUnit: icrs[i] as number })),
    ...(allIsf && someIsf
      ? { isfSegments: input.rows.map((_, i) => ({ startMinute: starts[i] as number, mgdlPerUnit: isfs[i] as number })) }
      : null),
    ...(input.insulinType ? { insulinType: input.insulinType } : null),
    source: input.source,
    ...(input.note.trim() ? { note: input.note.trim() } : null),
  };
  return { ok: true, body };
}
