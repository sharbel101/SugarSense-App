import { fetchHistory, fetchLatest, fetchStatus, type GarminConfig, type GarminError, type GarminLatest, type GarminObservation, type GarminResult, type GarminStatus } from '../api/garminContract.ts';
import { historyWindows, type GarminSnapshot } from './garminAdapter.ts';

/** Everything except `latest` and `status` changes slowly; reload it at most this often. */
export const HISTORY_REFRESH_MS = 5 * 60_000;
/** The history calls are the big ones and run over a tunnel: give them longer than the default 10 s. */
export const HISTORY_TIMEOUT_MS = 30_000;
/** A phone chart does not need every 2-minute sample of a day: at most this many points per series are requested (the server thins evenly, never averages). */
export const CHART_POINTS = 240;

export type HistoryBundle = Pick<GarminSnapshot, 'heartRate' | 'stepsToday' | 'stressBattery' | 'daily' | 'exercises'>;

const DAILY_METRICS = [
  'resting_heart_rate',
  'hrv_overnight_avg',
  'sleep_duration',
  'steps_day_cumulative',
  'spo2_day_avg',
  'spo2_sleep_avg',
  'respiration_waking_avg',
  'respiration_sleep_avg',
];

/** Load the history pieces in parallel. Any failure fails the whole bundle (a half-loaded chart is worse than none). */
export async function loadHistoryBundle(base: GarminConfig, now: number, signal?: AbortSignal): Promise<GarminResult<HistoryBundle>> {
  const cfg: GarminConfig = { ...base, timeoutMs: base.timeoutMs ?? HISTORY_TIMEOUT_MS };
  const w = historyWindows(now);
  const [hr, fast, daily, ex] = await Promise.all([
    fetchHistory(cfg, { metrics: ['heart_rate'], from: w.hr[0], to: w.hr[1], limit: 2000, maxPages: 4, maxPoints: CHART_POINTS }, signal),
    fetchHistory(cfg, { metrics: ['body_battery'], from: w.fast[0], to: w.fast[1], limit: 2000, maxPages: 3, maxPoints: CHART_POINTS }, signal),
    fetchHistory(cfg, { metrics: DAILY_METRICS, from: w.daily[0], to: w.daily[1], limit: 2000, maxPages: 4 }, signal),
    fetchHistory(cfg, { metrics: ['exercise_session'], from: w.exercises[0], to: w.exercises[1], limit: 200 }, signal),
  ]);
  for (const r of [hr, fast, daily, ex]) if (!r.ok) return r;
  const obs = (r: GarminResult<{ observations: GarminObservation[] }>) => (r.ok ? r.data.observations : []);
  return {
    ok: true,
    data: { heartRate: obs(hr), stepsToday: [], stressBattery: obs(fast), daily: obs(daily), exercises: obs(ex) },
  };
}

export const EMPTY_HISTORY: HistoryBundle = { heartRate: [], stepsToday: [], stressBattery: [], daily: [], exercises: [] };

/** The two small calls (they only read our database). The screen can show these on their own while the history is still loading. */
export async function loadGarminFast(
  cfg: GarminConfig,
  signal?: AbortSignal,
): Promise<{ ok: true; latest: GarminLatest; status: GarminStatus | null } | { ok: false; error: GarminError }> {
  const [latest, status] = await Promise.all([fetchLatest(cfg, signal), fetchStatus(cfg, signal)]);
  if (!latest.ok) return { ok: false, error: latest.error };
  return { ok: true, latest: latest.data, status: status.ok ? status.data : null };
}

export type LoadOutcome = { ok: true; snapshot: GarminSnapshot; historyAt: number | null } | { ok: false; error: GarminError };

/**
 * One refresh: `/metrics/latest` and `/status` every time (they only read our database), the history bundle only
 * when `prev` is missing or older than `HISTORY_REFRESH_MS`. `now` is device time; Garmin is never contacted.
 */
export async function loadGarmin(
  cfg: GarminConfig,
  now: number,
  prev: { history: HistoryBundle; at: number } | null,
  signal?: AbortSignal,
): Promise<LoadOutcome> {
  const needHistory = !prev || now - prev.at >= HISTORY_REFRESH_MS;
  const [latest, status, hist] = await Promise.all([
    fetchLatest(cfg, signal),
    fetchStatus(cfg, signal),
    needHistory ? loadHistoryBundle(cfg, now, signal) : Promise.resolve(null),
  ]);
  if (!latest.ok) return { ok: false, error: latest.error };
  if (hist && !hist.ok) return { ok: false, error: hist.error };
  const bundle = hist && hist.ok ? hist.data : prev!.history;
  // `/status` is optional: without it the sync message falls back to `latest.last_successful_fetch_at`.
  return {
    ok: true,
    snapshot: { latest: latest.data, status: status.ok ? status.data : null, ...bundle },
    historyAt: hist && hist.ok ? now : prev ? prev.at : null,
  };
}

/** Calls to the Garmin API are limited: after a good refresh the next one is allowed after this long. */
export const REFRESH_MIN_MS = 6 * 60_000;
/** After a FAILED refresh a retry is allowed sooner, so an error never locks the screen. */
export const RETRY_AFTER_ERROR_MS = 60_000;

/** May a refresh start now? `last` = the previous attempt. Pure. */
export function refreshGate(last: { at: number; ok: boolean } | null, now: number): { allowed: boolean; waitMs: number } {
  if (!last) return { allowed: true, waitMs: 0 };
  const min = last.ok ? REFRESH_MIN_MS : RETRY_AFTER_ERROR_MS;
  const waitMs = Math.max(0, last.at + min - now);
  return { allowed: waitMs === 0, waitMs };
}
