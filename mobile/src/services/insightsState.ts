import { visibleInsights, type Insight, type InsightsEmpty, type InsightsFetchOutcome, type InsightsOk } from '../api/insightsContract.ts';

/** What the last good fetch said, plus whether the newest attempt failed. Pure, so Node can test it. */
export interface InsightsState {
  last: InsightsOk | InsightsEmpty | null;
  /** Device time of the last good fetch. */
  fetchedAtMs: number | null;
  /** The newest attempt failed; `last` (if any) is older than it looks. */
  failure: 'unavailable' | 'offline' | null;
  /** At least one fetch has finished. */
  settled: boolean;
}

export const INITIAL_INSIGHTS_STATE: InsightsState = { last: null, fetchedAtMs: null, failure: null, settled: false };

export function reduceInsights(state: InsightsState, outcome: InsightsFetchOutcome, nowMs: number): InsightsState {
  switch (outcome.kind) {
    case 'ok':
    case 'empty':
      return { last: outcome.response, fetchedAtMs: nowMs, failure: null, settled: true };
    case 'unavailable':
      return { ...state, failure: 'unavailable', settled: true };
    case 'error':
      if (outcome.cause === 'aborted') return state;
      return { ...state, failure: 'offline', settled: true };
  }
}

export type InsightsView =
  | { kind: 'loading' }
  | { kind: 'ok'; insights: Insight[]; generatedAt: string | null; notice: string | null; refreshFailed: boolean; fetchedAtMs: number | null }
  | { kind: 'empty'; reason: 'not_generated_yet' | 'none_active'; notice: string | null; refreshFailed: boolean }
  | { kind: 'unavailable' }
  | { kind: 'offline' };

export function deriveInsightsView(state: InsightsState, nowMs: number): InsightsView {
  const { last } = state;
  if (last === null) {
    if (!state.settled) return { kind: 'loading' };
    return state.failure === 'offline' ? { kind: 'offline' } : { kind: 'unavailable' };
  }
  const refreshFailed = state.failure !== null;
  if (last.status === 'empty') {
    return { kind: 'empty', reason: last.reason, notice: last.notice, refreshFailed };
  }
  // Expired insights are hidden on the device, never shown as current.
  const insights = visibleInsights(last.insights, nowMs);
  if (insights.length === 0) return { kind: 'empty', reason: 'none_active', notice: last.notice, refreshFailed };
  return { kind: 'ok', insights, generatedAt: last.generatedAt, notice: last.notice, refreshFailed, fetchedAtMs: state.fetchedAtMs };
}
