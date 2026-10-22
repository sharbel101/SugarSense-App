import type { ForecastDisplay, ForecastFetchOutcome, ForecastOkDisplay, ForecastBaselineUnavailableDisplay } from '../api/forecastContract';

/**
 * Pure state for the 3-hour forecast (mirrors glucoseState.ts, no React / I/O).
 *
 * Rules (the build brief, section 2.A and 3):
 * - A good forecast is kept across a failed refresh for at most `KEEP_MINUTES`, labelled "as of",
 *   then dropped. An old forecast is never shown as current.
 * - HTTP 404/503 ("not deployed") or any failure with nothing recent to show -> `fallback`: the
 *   caller draws the glucose-only line from GET /glucose and says entries are not included.
 * - A server `stale` / `unavailable` answer drops the held forecast immediately.
 */
export const KEEP_MINUTES = 10;

export type ForecastState = {
  loaded: boolean;
  good: { data: ForecastOkDisplay; receivedAtMs: number } | null;
  /** Latest answer that was not a usable `ok` forecast. */
  problem:
    | { kind: 'not_deployed' }
    | { kind: 'failed' }
    | { kind: 'baseline_unavailable'; data: ForecastBaselineUnavailableDisplay }
    | { kind: 'stale'; reason: string }
    | { kind: 'unavailable'; reason: string }
    | null;
};

export const INITIAL_FORECAST_STATE: ForecastState = { loaded: false, good: null, problem: null };

export function reduceForecast(state: ForecastState, outcome: ForecastFetchOutcome, nowMs: number): ForecastState {
  if (outcome.kind === 'error') {
    if (outcome.cause === 'aborted') return state;
    const problem = outcome.cause === 'not_deployed' ? ({ kind: 'not_deployed' } as const) : ({ kind: 'failed' } as const);
    // Keep the last good forecast (it will be labelled and eventually dropped); remember the failure.
    return { loaded: true, good: outcome.cause === 'not_deployed' ? null : state.good, problem };
  }
  return applyForecastResponse(state, outcome.response, nowMs);
}

/** Used both for polls and for a forecast returned by an event save (`applyForecast`). */
export function applyForecastResponse(state: ForecastState, r: ForecastDisplay, nowMs: number): ForecastState {
  switch (r.status) {
    case 'ok':
      // An answer that was built EARLIER than the one we hold (a poll that started before a save and landed after
      // it) must not replace it, or the screen would go back to amounts from before the person logged anything.
      if (state.good && Date.parse(r.generatedAt) < Date.parse(state.good.data.generatedAt)) return state;
      return { loaded: true, good: { data: r, receivedAtMs: nowMs }, problem: null };
    case 'baseline_unavailable':
      return { loaded: true, good: null, problem: { kind: 'baseline_unavailable', data: r } };
    case 'stale':
      return { loaded: true, good: null, problem: { kind: 'stale', reason: r.reason } };
    case 'unavailable':
      return { loaded: state.loaded, good: state.good, problem: { kind: 'unavailable', reason: r.reason } };
  }
}

export type ForecastView =
  | { kind: 'loading' }
  | {
      kind: 'ok';
      data: ForecastOkDisplay;
      /** Set when the latest refresh failed and this is an earlier forecast: show "as of HH:MM". */
      asOf: string | null;
    }
  | { kind: 'baseline_unavailable'; data: ForecastBaselineUnavailableDisplay }
  | { kind: 'stale'; reason: string }
  | { kind: 'unavailable'; reason: string }
  /** Use the glucose-only line from GET /glucose and say meal and insulin entries are not included. */
  | { kind: 'fallback' };

export function deriveForecastView(state: ForecastState, nowMs: number): ForecastView {
  if (!state.loaded) return { kind: 'loading' };
  const p = state.problem;

  if (state.good) {
    const ageMin = (nowMs - state.good.receivedAtMs) / 60_000;
    if (p === null) return { kind: 'ok', data: state.good.data, asOf: null };
    if (ageMin <= KEEP_MINUTES) return { kind: 'ok', data: state.good.data, asOf: new Date(state.good.receivedAtMs).toISOString() };
    return { kind: 'fallback' };
  }
  if (p === null) return { kind: 'fallback' };
  switch (p.kind) {
    case 'baseline_unavailable':
      return { kind: 'baseline_unavailable', data: p.data };
    case 'stale':
      return { kind: 'stale', reason: p.reason };
    case 'unavailable':
      return { kind: 'unavailable', reason: p.reason };
    default:
      return { kind: 'fallback' };
  }
}
