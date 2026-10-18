import type { ForecastOkDisplay } from '../api/forecastContract';
import { formatTime12 } from './clock12.ts';

/**
 * Predicted low / high blood sugar, read from the server's forecast line, and the rules for telling the
 * person about it. Pure: no clock, storage or notifications in here, so plain-Node tests can run it.
 *
 * What counts: the line the person sees (`adjusted`) at any point in the next 3 hours going BELOW 80 mg/dL
 * (low) or ABOVE 240 mg/dL (high). It is an estimate with a wide range, never a measurement: every text
 * says "predicted", and nothing here changes a dose or a setting (root CLAUDE.md section 2). A forecast
 * that is missing, stale or older than the last one seen never raises or clears anything: "unknown" is
 * not "all clear".
 *
 * Alarm budget (CLAUDE.md section 2): one notification when a risk first appears, none while the same
 * risk goes on, one when a NEW reading takes it out of the forecast, and at most one "predicted"
 * notification per kind per 30 minutes so a line hovering at the threshold cannot flood the phone.
 */

export const LOW_THRESHOLD_MGDL = 80;
export const HIGH_THRESHOLD_MGDL = 240;
/** Minimum time between two "predicted" notifications of the same kind. */
export const MIN_GAP_MS = 30 * 60_000;

export type RiskKind = 'low' | 'high';

export type PredictedRisk = {
  kind: RiskKind;
  threshold: number;
  /** First predicted point past the threshold. */
  firstAtMs: number;
  firstMinutesAhead: number;
  firstValue: number;
  /** The most extreme predicted point: the lowest for a low, the highest for a high. */
  extremeAtMs: number;
  extremeMinutesAhead: number;
  extremeValue: number;
  /** The 80% range at that most extreme point. */
  extremeRange: { low: number; high: number };
  /** The latest reading itself is already past the threshold. */
  alreadyPast: boolean;
  latestMgdl: number;
  measuredAt: string;
  insulinOnBoardUnits: number | null;
  carbsOnBoardGrams: number | null;
};

export type PredictedRisks = { low: PredictedRisk | null; high: PredictedRisk | null };

export function detectPredictedRisks(f: ForecastOkDisplay): PredictedRisks {
  const a = f.mealAware.availability;
  const make = (kind: RiskKind): PredictedRisk | null => {
    const past = (v: number) => (kind === 'low' ? v < LOW_THRESHOLD_MGDL : v > HIGH_THRESHOLD_MGDL);
    const beyond = (v: number, than: number) => (kind === 'low' ? v < than : v > than);
    const crossing = f.points.filter((p) => past(p.adjusted));
    if (crossing.length === 0) return null;
    const first = crossing[0];
    let extreme = crossing[0];
    for (const p of crossing) if (beyond(p.adjusted, extreme.adjusted)) extreme = p;
    return {
      kind,
      threshold: kind === 'low' ? LOW_THRESHOLD_MGDL : HIGH_THRESHOLD_MGDL,
      firstAtMs: Date.parse(first.time),
      firstMinutesAhead: first.minutes,
      firstValue: first.adjusted,
      extremeAtMs: Date.parse(extreme.time),
      extremeMinutesAhead: extreme.minutes,
      extremeValue: extreme.adjusted,
      extremeRange: { low: extreme.low, high: extreme.high },
      alreadyPast: past(f.anchor.glucoseMgdl),
      latestMgdl: f.anchor.glucoseMgdl,
      measuredAt: f.anchor.measuredAt,
      insulinOnBoardUnits: a.insulinOnBoardUnits,
      carbsOnBoardGrams: a.carbsOnBoardGrams,
    };
  };
  return { low: make('low'), high: make('high') };
}

// ------------------------------------------------------------------------------------------ text

/** "about 25 min", "about 2 h 50 min", "about 3 h" - rounded to 5 minutes. */
export function inAbout(minutes: number): string {
  if (minutes < 3) return 'less than 5 min';
  const m = Math.max(0, Math.round(minutes / 5) * 5);
  if (m < 60) return `about ${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? `about ${h} h` : `about ${h} h ${rest} min`;
}

const wordFor = (kind: RiskKind) => (kind === 'low' ? 'low' : 'high');
const dirFor = (kind: RiskKind) => (kind === 'low' ? 'below' : 'above');

/** Minutes from `nowMs` (default: the reading's own time) to the first predicted crossing; never negative. */
export function minutesUntil(risk: PredictedRisk, nowMs?: number): number {
  const from = nowMs ?? Date.parse(risk.measuredAt);
  return Math.max(0, Math.round((risk.firstAtMs - from) / 60_000));
}

/**
 * The short lines on a Safety card: what is predicted and when, the predicted value at that time and
 * how soon, and (when it goes further) the lowest / highest predicted value. `nowMs` makes "in about
 * ..." count from now, not from the reading.
 */
export function riskSummary(risk: PredictedRisk, nowMs?: number): { title: string; detail: string; extreme: string } {
  const label = risk.kind === 'low' ? 'Low' : 'High';
  const extreme = risk.kind === 'low' ? 'Lowest' : 'Highest';
  const goesFurther = risk.extremeMinutesAhead !== risk.firstMinutesAhead && Math.abs(risk.extremeValue - risk.firstValue) >= 3;
  const extremeLine = goesFurther ? `${extreme} about ${Math.round(risk.extremeValue)} mg/dL at ${formatTime12(new Date(risk.extremeAtMs))}` : '';
  if (risk.alreadyPast) {
    return { title: `Reading ${Math.round(risk.latestMgdl)} is ${dirFor(risk.kind)} ${risk.threshold}`, detail: extremeLine, extreme: '' };
  }
  return {
    title: `${label} predicted at ${formatTime12(new Date(risk.firstAtMs))}`,
    detail: `About ${Math.round(risk.firstValue)} mg/dL · in ${inAbout(minutesUntil(risk, nowMs))}`,
    extreme: extremeLine,
  };
}

// -------------------------------------------------------------------------------- state machine

export type KindState = {
  active: boolean;
  /** ISO time the current episode was first seen. */
  since: string | null;
  /** ISO time of the last "predicted" notification sent for this kind (any episode). */
  lastPredictedAt: string | null;
  /** A "predicted" notification went out for the current episode (so a "cleared" one makes sense). */
  notifiedThisEpisode: boolean;
};

export type AlertState = {
  low: KindState;
  high: KindState;
  /** `anchor.measuredAt` of the last forecast that was evaluated: the same reading is never evaluated twice. */
  lastMeasuredAt: string | null;
};

export type AlertNotification = {
  kind: RiskKind;
  type: 'predicted' | 'cleared';
  title: string;
  body: string;
  /** One tag per kind, so a "cleared" replaces the "predicted" it ends. */
  tag: string;
};

const emptyKind = (): KindState => ({ active: false, since: null, lastPredictedAt: null, notifiedThisEpisode: false });
export const INITIAL_ALERT_STATE: AlertState = { low: emptyKind(), high: emptyKind(), lastMeasuredAt: null };

export function predictedNotification(risk: PredictedRisk, nowMs?: number): AlertNotification {
  const word = wordFor(risk.kind);
  const when = formatTime12(new Date(risk.firstAtMs));
  const body = risk.alreadyPast
    ? `Your latest reading, ${Math.round(risk.latestMgdl)} mg/dL, is already ${dirFor(risk.kind)} ${risk.threshold}. Estimate only; check your glucose.`
    : `Predicted to go ${dirFor(risk.kind)} ${risk.threshold} mg/dL at about ${when}, in ${inAbout(minutesUntil(risk, nowMs))}. Estimate only; check your glucose.`;
  return { kind: risk.kind, type: 'predicted', title: `${word === 'low' ? 'Low' : 'High'} blood sugar predicted`, body, tag: `sugarsense-risk-${risk.kind}` };
}

export function clearedNotification(kind: RiskKind, f: ForecastOkDisplay): AlertNotification {
  const at = formatTime12(new Date(f.anchor.measuredAt));
  const threshold = kind === 'low' ? LOW_THRESHOLD_MGDL : HIGH_THRESHOLD_MGDL;
  return {
    kind,
    type: 'cleared',
    title: `${kind === 'low' ? 'Low' : 'High'} risk cleared`,
    body: `As of the new reading at ${at} (${Math.round(f.anchor.glucoseMgdl)} mg/dL), your forecast no longer goes ${dirFor(kind)} ${threshold} mg/dL in the next 3 hours. Estimate only.`,
    tag: `sugarsense-risk-${kind}`,
  };
}

/**
 * Applies one FRESH forecast to the alert state. Callers pass only a forecast that just arrived (not a
 * kept-over one, not a failure): this is what keeps "unknown" from ever counting as "cleared".
 */
export function evaluateRisks(state: AlertState, f: ForecastOkDisplay, nowMs: number): { state: AlertState; notifications: AlertNotification[] } {
  if (state.lastMeasuredAt === f.anchor.measuredAt) return { state, notifications: [] };
  const risks = detectPredictedRisks(f);
  const notifications: AlertNotification[] = [];
  const next: AlertState = { low: { ...state.low }, high: { ...state.high }, lastMeasuredAt: f.anchor.measuredAt };

  for (const kind of ['low', 'high'] as const) {
    const risk = risks[kind];
    const cur = next[kind];
    if (risk && !cur.active) {
      cur.active = true;
      cur.since = new Date(nowMs).toISOString();
      const gapOk = cur.lastPredictedAt === null || nowMs - Date.parse(cur.lastPredictedAt) >= MIN_GAP_MS;
      if (gapOk) {
        notifications.push(predictedNotification(risk, nowMs));
        cur.lastPredictedAt = new Date(nowMs).toISOString();
        cur.notifiedThisEpisode = true;
      } else {
        cur.notifiedThisEpisode = false;
      }
    } else if (!risk && cur.active) {
      if (cur.notifiedThisEpisode) notifications.push(clearedNotification(kind, f));
      cur.active = false;
      cur.since = null;
      cur.notifiedThisEpisode = false;
    }
  }
  return { state: next, notifications };
}

// ------------------------------------------------------------------------------------ persistence

export function serializeAlertState(state: AlertState): string {
  return JSON.stringify(state);
}

function kindOf(v: unknown): KindState | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const iso = (x: unknown) => x === null || (typeof x === 'string' && Number.isFinite(Date.parse(x)));
  if (typeof o.active !== 'boolean' || typeof o.notifiedThisEpisode !== 'boolean' || !iso(o.since) || !iso(o.lastPredictedAt)) return null;
  return { active: o.active, since: o.since as string | null, lastPredictedAt: o.lastPredictedAt as string | null, notifiedThisEpisode: o.notifiedThisEpisode };
}

/** Anything unreadable gives the empty state (a missed "cleared" is better than a wrong one). */
export function deserializeAlertState(raw: string | null): AlertState {
  if (!raw) return INITIAL_ALERT_STATE;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const low = kindOf(v.low);
    const high = kindOf(v.high);
    const last = v.lastMeasuredAt;
    if (!low || !high || !(last === null || (typeof last === 'string' && Number.isFinite(Date.parse(last))))) return INITIAL_ALERT_STATE;
    return { low, high, lastMeasuredAt: last as string | null };
  } catch {
    return INITIAL_ALERT_STATE;
  }
}
