/**
 * Wearable statistics for the Wearable screen.
 *
 * TODAY THERE IS NO WEARABLE CONNECTION: `getWearableView()` returns clearly flagged DEMO values so the
 * screen can be built and reviewed. Nothing here talks to a device, and nothing here is a measurement.
 * The screen only reads a `WearableView`; when a real device is connected, `getWearableView` (or a hook
 * that replaces it) returns `isDemo: false` with a real `WearableSnapshot` and the screen does not
 * change. Missing values are `null` (shown as "-"), never 0 (CLAUDE.md section 3: missingness is data).
 */
export type ActivityLevel = 'low' | 'moderate' | 'high';

export type WearableSnapshot = {
  heartRateBpm: number | null;
  /** Heart-rate variability, RMSSD in milliseconds. */
  hrvMs: number | null;
  steps: number | null;
  activeMinutes: number | null;
  activityLevel: ActivityLevel | null;
  sleepMinutes: number | null;
  spo2Percent: number | null;
  batteryPercent: number | null;
  /** When these values were measured, ISO UTC; null for demo values. */
  measuredAt: string | null;
};

export type WearableConnection =
  | { state: 'not_connected' }
  | { state: 'connected'; deviceName: string; lastSyncIso: string | null };

export type WearableView = {
  /** True while the numbers are samples, not measurements. */
  isDemo: boolean;
  connection: WearableConnection;
  /** Null = nothing to show (the screen then shows only the empty state). */
  snapshot: WearableSnapshot | null;
};

/** Sample values for the screen design. Realistic-looking, deliberately round, never real data. */
export const DEMO_SNAPSHOT: WearableSnapshot = {
  heartRateBpm: 72,
  hrvMs: 48,
  steps: 6420,
  activeMinutes: 38,
  activityLevel: 'moderate',
  sleepMinutes: 440,
  spo2Percent: 97,
  batteryPercent: 78,
  measuredAt: null,
};

export function getWearableView(): WearableView {
  return { isDemo: true, connection: { state: 'not_connected' }, snapshot: DEMO_SNAPSHOT };
}

export function formatSleep(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes) || minutes < 0) return '-';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export function formatSteps(steps: number | null): string {
  if (steps === null || !Number.isFinite(steps) || steps < 0) return '-';
  return Math.round(steps).toLocaleString('en-US');
}

export function formatActivity(level: ActivityLevel | null): string {
  return level === 'low' ? 'Low' : level === 'moderate' ? 'Moderate' : level === 'high' ? 'High' : '-';
}

/** A whole number with its unit, or "-" when unknown. */
export function formatValue(value: number | null, digits = 0): string {
  if (value === null || !Number.isFinite(value)) return '-';
  return digits === 0 ? String(Math.round(value)) : value.toFixed(digits);
}
