/**
 * Detects a fast glucose rise that no logged meal explains, so the app can ask "did you forget to log a meal?".
 * Pure: no React, no I/O.
 *
 * It looks only at measured readings and logged meal times. It does not say a meal happened (a rise can have other
 * causes), it never estimates carbs or a dose, and it is an observation with a question, not an instruction
 * (root CLAUDE.md section 2). The thresholds are starting values to tune on real data.
 */
export interface SpikeReading {
  /** ISO UTC. */
  time: string;
  /** mg/dL */
  value: number;
}

export interface MealSpike {
  fromMgdl: number;
  toMgdl: number;
  riseMgdl: number;
  startedAtMs: number;
  peakAtMs: number;
  /** Minutes between the low and the high point. */
  minutes: number;
  /** The latest reading is still at (or within a few mg/dL of) the peak. */
  stillRising: boolean;
}

/** A rise of at least this much, in at most `SPIKE_WINDOW_MIN` minutes, at an average of at least `SPIKE_MIN_RATE`. */
export const SPIKE_RISE_MGDL = 40;
export const SPIKE_WINDOW_MIN = 75;
export const SPIKE_MIN_RATE = 0.5; // mg/dL per minute
/** The high point must be recent, and the latest reading must still be this far above the low point. */
export const SPIKE_RECENT_MIN = 60;
export const SPIKE_STILL_ELEVATED_MGDL = 25;
/** A meal logged up to this long BEFORE the rise began (or any time after) explains it. */
export const MEAL_LOOKBACK_MIN = 120;
/** The reading must be fresh: an old reading says nothing about now. */
export const SPIKE_FRESH_MIN = 20;

const MIN = 60_000;

export function detectMealSpike(readings: SpikeReading[], mealTimesMs: number[], nowMs: number): MealSpike | null {
  const pts = readings
    .map((r) => ({ t: Date.parse(r.time), v: r.value }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v) && p.t <= nowMs + MIN)
    .sort((a, b) => a.t - b.t);
  if (pts.length < 3) return null;
  const latest = pts[pts.length - 1];
  if (nowMs - latest.t > SPIKE_FRESH_MIN * MIN) return null;

  // The largest rise from an earlier low to a later high inside the window.
  let best: { i: number; j: number; rise: number } | null = null;
  for (let j = 1; j < pts.length; j++) {
    if (nowMs - pts[j].t > SPIKE_RECENT_MIN * MIN) continue;
    for (let i = 0; i < j; i++) {
      const dtMin = (pts[j].t - pts[i].t) / MIN;
      if (dtMin <= 0 || dtMin > SPIKE_WINDOW_MIN) continue;
      const rise = pts[j].v - pts[i].v;
      if (rise < SPIKE_RISE_MGDL || rise / dtMin < SPIKE_MIN_RATE) continue;
      if (!best || rise > best.rise) best = { i, j, rise };
    }
  }
  if (!best) return null;
  const lo = pts[best.i];
  const hi = pts[best.j];
  if (latest.v < lo.v + SPIKE_STILL_ELEVATED_MGDL) return null; // already back down: nothing to ask about

  const explained = mealTimesMs.some((m) => Number.isFinite(m) && m >= lo.t - MEAL_LOOKBACK_MIN * MIN && m <= nowMs + 5 * MIN);
  if (explained) return null;

  return {
    fromMgdl: lo.v,
    toMgdl: hi.v,
    riseMgdl: hi.v - lo.v,
    startedAtMs: lo.t,
    peakAtMs: hi.t,
    minutes: Math.round((hi.t - lo.t) / MIN),
    stillRising: latest.v >= hi.v - 3,
  };
}

/** One short sentence stating only what the readings show. */
export function spikeSummary(s: MealSpike): string {
  return `Glucose rose ${Math.round(s.riseMgdl)} mg/dL in about ${Math.max(1, s.minutes)} min (${Math.round(s.fromMgdl)} to ${Math.round(s.toMgdl)}) and no meal is logged around then.`;
}

/* --------------------------------------------------------------- notification state */

export interface MissedMealState {
  /** When the last notification was sent. */
  lastNotifiedAtMs: number | null;
  /** The person said "not a meal": stay quiet until then. */
  dismissedUntilMs: number | null;
}

export const INITIAL_MISSED_MEAL_STATE: MissedMealState = { lastNotifiedAtMs: null, dismissedUntilMs: null };

/** At most one notification in this long (an alarm budget: more than that gets the feature switched off). */
export const MISSED_MEAL_GAP_MS = 3 * 60 * MIN;
export const MISSED_MEAL_DISMISS_MS = 3 * 60 * MIN;

export function isDismissed(state: MissedMealState, nowMs: number): boolean {
  return state.dismissedUntilMs !== null && nowMs < state.dismissedUntilMs;
}

/** Should a notification go out now? Returns the next state either way. */
export function evaluateMissedMeal(state: MissedMealState, spike: MealSpike | null, nowMs: number): { state: MissedMealState; notify: boolean } {
  if (!spike || isDismissed(state, nowMs)) return { state, notify: false };
  if (state.lastNotifiedAtMs !== null && nowMs - state.lastNotifiedAtMs < MISSED_MEAL_GAP_MS) return { state, notify: false };
  return { state: { ...state, lastNotifiedAtMs: nowMs }, notify: true };
}

export function dismissMissedMeal(state: MissedMealState, nowMs: number): MissedMealState {
  return { ...state, dismissedUntilMs: nowMs + MISSED_MEAL_DISMISS_MS };
}

export function serializeMissedMeal(s: MissedMealState): string {
  return JSON.stringify(s);
}

/** Anything unreadable gives the empty state. */
export function deserializeMissedMeal(raw: string | null): MissedMealState {
  if (!raw) return INITIAL_MISSED_MEAL_STATE;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
    return { lastNotifiedAtMs: n(v.lastNotifiedAtMs), dismissedUntilMs: n(v.dismissedUntilMs) };
  } catch {
    return INITIAL_MISSED_MEAL_STATE;
  }
}
