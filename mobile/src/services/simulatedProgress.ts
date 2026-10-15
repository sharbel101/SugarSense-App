import { useEffect, useRef, useState } from 'react';

/**
 * How long the final sprint from "wherever we were" up to 100% takes once the real result is
 * in. Exported so a caller that wants to delay revealing that result (so a progress UI can
 * actually finish its animation first, rather than being yanked away mid-tween) can match it -
 * see MealReviewScreen's `revealed` state.
 */
export const DEFAULT_FINISH_MS = 450;

/**
 * A 0-100 progress value for a wait with no real backend progress signal to report (see
 * mealService.ts's `MealReviewState` - the meal-analyze call is one request/one response, not a
 * stream, so there is no genuine percentage to display). Rather than a constant-speed bar that
 * would either lie by reaching 100% before the result exists or crawl at an arbitrary fixed rate,
 * this creeps toward `cap` on a decelerating curve while `active` - fast at first, visibly
 * slowing as it nears the cap (the requested "slows down near 90-95%, only reaches 100% when the
 * result is actually ready" behaviour) - and only overshoots that cap up to a genuine 100% in the
 * instant `active` goes false, i.e. once the real state has actually resolved.
 *
 * Pure state, no rendering, so any progress UI (not just the insulin-pen bar) can reuse it, and a
 * future real progress source could replace it without changing that UI at all.
 */
export function useSimulatedProgress(
  active: boolean,
  options?: { cap?: number; tau?: number; finishMs?: number },
): number {
  const cap = options?.cap ?? 94;
  const tau = options?.tau ?? 4000;
  const finishMs = options?.finishMs ?? DEFAULT_FINISH_MS;

  const [percent, setPercent] = useState(0);
  const percentRef = useRef(0);

  // Reset to 0 the instant a fresh run starts (e.g. Retry) - done here, during render, rather
  // than as a synchronous setState call inside the effect below (which react-hooks/set-state-in-
  // effect correctly flags: an effect's *callback*, like the interval tick further down, is the
  // right place for that, not its immediate body). This is React's documented pattern for
  // "adjusting state when a value changes" and takes effect before the browser paints.
  const [wasActive, setWasActive] = useState(active);
  if (active !== wasActive) {
    setWasActive(active);
    // Only the displayed value needs resetting here - the growth curve below starts from ~0 at
    // elapsed=0 on its own regardless of `percentRef`, which the effect's own ticks keep current.
    if (active) setPercent(0);
  }

  useEffect(() => {
    const startedActive = active;
    const start = Date.now();
    const from = percentRef.current;

    const id = setInterval(() => {
      const elapsed = Date.now() - start;
      const value = startedActive ? cap * (1 - Math.exp(-elapsed / tau)) : from + (100 - from) * Math.min(1, elapsed / finishMs);
      percentRef.current = value;
      setPercent(value);
    }, startedActive ? 80 : 40);

    return () => clearInterval(id);
  }, [active, cap, tau, finishMs]);

  return percent;
}
