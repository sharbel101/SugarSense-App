import type { GlucoseFetchOutcome, GlucoseOk } from '../api/glucoseContract';

/**
 * Pure state mapping for the live glucose reading. No React, no I/O, so it can be unit-tested
 * under plain Node (see `tests/glucoseState.test.mjs`).
 *
 * The rules (root CLAUDE.md section 2 + backend/src/glucose/README.md):
 * - Loading is shown only until the FIRST fetch completes.
 * - After that the last good reading is kept across failed refreshes, but never shown as current
 *   once it is older than `STALE_MINUTES` - then the view is `stale`, with no number.
 * - A server `stale` answer drops the numbers immediately.
 * - A number from the past is never promoted: its age is `ageMinutes` (server, rounded up) plus the
 *   time elapsed on this device since it arrived, so it only ever looks older, never fresher.
 * - There is no fallback to mock or "last known" glucose in any state.
 */

/** Same threshold as the backend's GLUCOSE_STALE_MINUTES / upstream FORECAST_STALE_MIN. */
export const STALE_MINUTES = 20;

export const CLIENT_STALE_REASON = 'The latest glucose reading is too old to show. Check your sensor.';
export const CLIENT_UNAVAILABLE_REASON = 'Glucose is not available right now.';

export type GlucoseProblem =
  | { kind: 'stale'; reason: string; lastMeasuredAt: string | null }
  | { kind: 'unavailable'; reason: string };

export type GlucoseState = {
  /** True once the first fetch has completed (successfully or not). */
  loaded: boolean;
  /** Last successful `ok` payload, with the device time it arrived. `null` after a server `stale`. */
  good: { data: GlucoseOk; receivedAtMs: number } | null;
  /** The most recent non-ok outcome, if the latest refresh did not produce a reading. */
  problem: GlucoseProblem | null;
};

export const INITIAL_GLUCOSE_STATE: GlucoseState = { loaded: false, good: null, problem: null };

export function reduceGlucose(state: GlucoseState, outcome: GlucoseFetchOutcome, nowMs: number): GlucoseState {
  if (outcome.kind === 'error') {
    if (outcome.cause === 'aborted') return state;
    // Transport/shape failure: keep the last good reading (it ages honestly) and remember we failed.
    return {
      loaded: true,
      good: state.good,
      problem: { kind: 'unavailable', reason: CLIENT_UNAVAILABLE_REASON },
    };
  }

  const r = outcome.response;
  switch (r.status) {
    case 'ok':
      return { loaded: true, good: { data: r, receivedAtMs: nowMs }, problem: null };
    case 'stale':
      // The server says there is no recent reading: drop every number we hold.
      return {
        loaded: true,
        good: null,
        problem: { kind: 'stale', reason: r.reason, lastMeasuredAt: r.lastMeasuredAt },
      };
    case 'unavailable':
      return { loaded: true, good: state.good, problem: { kind: 'unavailable', reason: r.reason } };
  }
}

export type GlucoseView =
  | { kind: 'loading' }
  | {
      kind: 'ok';
      data: GlucoseOk;
      /** Minutes since the reading was taken, as of `nowMs`. Never less than the server's figure. */
      ageMinutes: number;
      /** The latest refresh failed; `data` is the previous (still fresh enough) reading. */
      refreshFailed: boolean;
    }
  | { kind: 'stale'; reason: string; lastMeasuredAt: string | null }
  | { kind: 'unavailable'; reason: string };

export function effectiveAgeMinutes(data: GlucoseOk, receivedAtMs: number, nowMs: number): number {
  const elapsedMin = Math.max(0, nowMs - receivedAtMs) / 60000;
  return data.ageMinutes + Math.ceil(elapsedMin);
}

export function deriveGlucoseView(state: GlucoseState, nowMs: number): GlucoseView {
  if (!state.loaded) return { kind: 'loading' };

  if (state.good) {
    const age = effectiveAgeMinutes(state.good.data, state.good.receivedAtMs, nowMs);
    if (age > STALE_MINUTES) {
      return { kind: 'stale', reason: CLIENT_STALE_REASON, lastMeasuredAt: state.good.data.measuredAt };
    }
    return { kind: 'ok', data: state.good.data, ageMinutes: age, refreshFailed: state.problem !== null };
  }

  if (state.problem) return state.problem;
  return { kind: 'unavailable', reason: CLIENT_UNAVAILABLE_REASON };
}

/** "just now", "5 min ago", "1 h 5 min ago". Input is whole minutes, already rounded up. */
export function formatAge(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m <= 0) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h} h ago` : `${h} h ${rem} min ago`;
}

/** Local wall-clock HH:MM for an ISO UTC string. Times arrive UTC; formatting is local. */
export function formatClock(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
