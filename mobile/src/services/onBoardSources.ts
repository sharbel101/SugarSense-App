import type { ForecastEventDisplay } from '../api/forecastContract';
import { INSULIN_KINDS, INSULIN_TYPES } from './events.ts';

/**
 * "Where does it come from": the doses the person took and the carbs they entered, listed next to the
 * insulin-on-board and carbs-on-board numbers. Pure. It only LISTS what was logged (from the server's
 * `GET /events/recent`) and says how the forecast used each entry (from `mealAware.events`). It does
 * not work out how much of an entry is still acting: that number is the server's, shown on the chip.
 */

/** Same window as the "Logged today" list. */
export const SOURCE_WINDOW_HOURS = 12;
const HOUR = 3_600_000;

export type SourceRow = {
  id: string;
  timeIso: string;
  /** "3 h 20 min ago" */
  ago: string;
  title: string;
  detail: string;
  /** How the forecast used this entry; '' when the forecast did not list it. */
  status: string;
  counted: boolean;
};

type InsulinLike = {
  id: string;
  administeredAt: string;
  kind: string;
  insulinType: string | null;
  unitsTaken: number | null;
  confirmation: 'confirmed' | 'uncertain' | 'planned';
  status: 'active' | 'cancelled';
};

type MealLike = {
  id: string;
  label: string | null;
  eatenAt: string;
  status: string;
  carbs: { grams: number | null; kind: 'estimated' | 'user_corrected' | 'user_entered' | 'missing' };
};

export function formatAgo(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h} h ago` : `${h} h ${m} min ago`;
}

function trim(n: number): string {
  return String(Math.round(n * 100) / 100);
}

function statusFor(events: ForecastEventDisplay[], id: string): { text: string; counted: boolean } {
  const e = events.find((x) => x.id === id);
  if (!e) return { text: '', counted: false };
  if (e.role === 'used') return { text: 'Counted in your forecast', counted: true };
  if (e.role === 'range_only') return { text: 'Only widens the range', counted: false };
  return { text: 'Not used in the forecast', counted: false };
}

function inWindow(iso: string, nowMs: number, windowHours: number): number | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  // A few minutes into the future is clock skew, not "later"; anything further is not a past entry.
  if (t > nowMs + 5 * 60_000 || t < nowMs - windowHours * HOUR) return null;
  return t;
}

/** Doses the person recorded in the last `windowHours`, newest first. Removed entries are left out. */
export function insulinSourceRows(insulin: InsulinLike[], events: ForecastEventDisplay[], nowMs: number, windowHours = SOURCE_WINDOW_HOURS): SourceRow[] {
  const rows: { t: number; row: SourceRow }[] = [];
  for (const d of insulin) {
    if (d.status === 'cancelled') continue;
    const t = inWindow(d.administeredAt, nowMs, windowHours);
    if (t === null) continue;
    const kind = INSULIN_KINDS.find((k) => k.value === d.kind)?.label ?? 'Insulin';
    const type = INSULIN_TYPES.find((x) => x.value === d.insulinType)?.label;
    const detail = [kind, type, d.confirmation === 'uncertain' ? 'amount or time approximate' : null].filter(Boolean).join(' · ');
    const title = d.unitsTaken === null ? 'Amount unknown' : d.unitsTaken === 0 ? 'No insulin taken (you confirmed)' : `${trim(d.unitsTaken)} U`;
    const s = statusFor(events, d.id);
    rows.push({ t, row: { id: d.id, timeIso: d.administeredAt, ago: formatAgo(nowMs - t), title, detail, status: s.text, counted: s.counted } });
  }
  return rows.sort((a, b) => b.t - a.t).map((r) => r.row);
}

const MEAL_SOURCE: Record<MealLike['carbs']['kind'], string> = {
  estimated: 'AI estimate',
  user_corrected: 'estimate corrected by you',
  user_entered: 'entered by you',
  missing: 'carbs unknown',
};

/** Meals the person entered in the last `windowHours`, newest first. Removed meals are left out. */
export function mealSourceRows(meals: MealLike[], events: ForecastEventDisplay[], nowMs: number, windowHours = SOURCE_WINDOW_HOURS): SourceRow[] {
  const rows: { t: number; row: SourceRow }[] = [];
  for (const m of meals) {
    if (m.status === 'cancelled') continue;
    const t = inWindow(m.eatenAt, nowMs, windowHours);
    if (t === null) continue;
    const title = m.carbs.grams === null ? 'Carbs unknown' : `${Math.round(m.carbs.grams)} g carbs`;
    const detail = [m.label ?? 'Meal', MEAL_SOURCE[m.carbs.kind]].join(' · ');
    const s = statusFor(events, m.id);
    rows.push({ t, row: { id: m.id, timeIso: m.eatenAt, ago: formatAgo(nowMs - t), title, detail, status: s.text, counted: s.counted } });
  }
  return rows.sort((a, b) => b.t - a.t).map((r) => r.row);
}
