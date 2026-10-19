import type { InsulinView, MealView } from '../api/eventsApi';

/**
 * The "what you logged recently" list (`GET /events/recent`) and how a refresh changes it. Pure.
 *
 * A refresh keeps showing the list it already has while the new one is on its way (so Home never
 * flashes "Loading..." and goes blank), replaces it when the answer arrives, and when the answer fails
 * keeps the last good list rather than blanking it. "Not available" is only for when there never was a
 * list. A list that is a little old is better than an empty one, and the next refresh fixes it.
 */
export type RecentState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; meals: MealView[]; insulin: InsulinView[] }
  | { kind: 'unavailable' };

export type RecentOutcome = { kind: 'ok'; meals: MealView[]; insulin: InsulinView[] } | { kind: 'unavailable' };

/** The state to show while a refresh is running. */
export function recentWhileRefreshing(current: RecentState): RecentState {
  return current.kind === 'ok' ? current : { kind: 'loading' };
}

/** The state once the refresh answered. */
export function recentAfterRefresh(current: RecentState, outcome: RecentOutcome): RecentState {
  if (outcome.kind === 'ok') return outcome;
  return current.kind === 'ok' ? current : { kind: 'unavailable' };
}
