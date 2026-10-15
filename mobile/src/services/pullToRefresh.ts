/**
 * Pure pull-to-refresh gesture logic for the web build. No React, no DOM, so it runs under plain
 * Node (see `tests/pullToRefresh.test.mjs`).
 *
 * react-native-web's `RefreshControl` is an empty stub (it ignores `refreshing` / `onRefresh`), so on
 * web the pull has to be recognised from raw touch positions. Native builds use the real
 * `RefreshControl` and never touch this file.
 */

/** Damped pull distance (dp) at which letting go triggers a refresh. */
export const PULL_TRIGGER = 64;
/** The indicator never travels further than this, however far the finger keeps going. */
export const PULL_MAX = 96;
/** Finger travel is halved so the badge trails the finger instead of racing it. */
const DAMPING = 0.5;

export type PullState = { phase: 'idle' } | { phase: 'pulling'; startY: number; distance: number };

export const PULL_IDLE: PullState = { phase: 'idle' };

/** Finger down. The gesture only arms when the list is already at the very top. */
export function pullStart(scrollTop: number, y: number): PullState {
  return scrollTop <= 0 ? { phase: 'pulling', startY: y, distance: 0 } : PULL_IDLE;
}

/**
 * Finger moved. Disarms once the list has scrolled away from the top, so an ordinary scroll that
 * happens to begin at the top can never fire a refresh. A finger moving back up past its starting
 * point just reads as zero pull (it stays armed in case the finger comes back down).
 */
export function pullMove(state: PullState, scrollTop: number, y: number): PullState {
  if (state.phase !== 'pulling') return state;
  if (scrollTop > 0) return PULL_IDLE;
  const raw = y - state.startY;
  const distance = raw <= 0 ? 0 : Math.min(PULL_MAX, raw * DAMPING);
  return { phase: 'pulling', startY: state.startY, distance };
}

/** Finger up (or cancelled). `trigger` is true only if the pull went past the threshold. */
export function pullEnd(state: PullState, cancelled = false): { next: PullState; trigger: boolean } {
  const trigger = !cancelled && state.phase === 'pulling' && state.distance >= PULL_TRIGGER;
  return { next: PULL_IDLE, trigger };
}

/** 0 at rest, 1 once the pull is far enough to trigger. */
export function pullProgress(state: PullState): number {
  if (state.phase !== 'pulling') return 0;
  return Math.min(1, state.distance / PULL_TRIGGER);
}
