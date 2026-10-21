import type { GarminEntry, GarminLatest, GarminObservation, GarminStatus } from '../api/garminContract.ts';
import { ageText, DAY, type Exercise, type MetricKey, type Sample, type SyncNotice, type WearableData } from './wearableModel.ts';

/**
 * Turns the Garmin API answers into the `WearableData` the Wearable screens read. Pure.
 *
 * Rules: a missing metric is absent (never 0); cumulative metrics (`steps_day_cumulative`) are only ever read as
 * "latest value" or "last row of each day" and are NEVER summed; interval counts (`steps_interval`) are bars, not
 * a total; vendor-calculated values are flagged so the screen can say "Calculated by Garmin". Garmin does not
 * measure glucose and nothing here is a glucose or risk figure.
 */

export interface GarminSnapshot {
  latest: GarminLatest;
  status: GarminStatus | null;
  /** `heart_rate`, last 24 h. */
  heartRate: GarminObservation[];
  /** `steps_interval`, since local midnight. */
  stepsToday: GarminObservation[];
  /** `stress_level` + `body_battery`, last 24 h. */
  stressBattery: GarminObservation[];
  /** Daily metrics, last 14 days. */
  daily: GarminObservation[];
  /** `exercise_session`, last 7 days. */
  exercises: GarminObservation[];
}

/** The fetch itself is "old" (the pipeline is not updating) after this long without a successful fetch. */
export const FETCH_OLD_MIN = 30;

const ms = (iso: string) => Date.parse(iso);

function dayKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** "seconds" in whatever spelling the API uses -> minutes. */
function secondsToMinutes(v: number): number {
  return v / 60;
}

function numericValue(v: number | Record<string, unknown>): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function toSamples(obs: GarminObservation[], metric: string, map: (v: number) => number = (v) => v): Sample[] {
  const out: Sample[] = [];
  for (const o of obs) {
    if (o.metric !== metric) continue;
    const v = numericValue(o.value);
    if (v === null) continue;
    out.push({ t: ms(o.measuredAt), v: map(v) });
  }
  return out;
}

function withLatest(samples: Sample[], entry: GarminEntry | undefined, map: (v: number) => number = (v) => v): Sample[] {
  if (!entry) return samples;
  const v = numericValue(entry.value);
  if (v === null) return samples;
  const t = ms(entry.measuredAt);
  if (samples.some((s) => s.t === t)) return samples;
  return [...samples, { t, v: map(v) }];
}

/** One value per local day: the LAST sample of each day (never a sum). */
function lastPerDay(samples: Sample[]): Sample[] {
  const byDay = new Map<string, Sample>();
  for (const s of [...samples].sort((a, b) => a.t - b.t)) byDay.set(dayKey(s.t), s);
  return [...byDay.values()];
}

/** "Waiting for your watch to sync" vs "Garmin data is not updating" (see the Garmin frontend contract). */
export function syncNotice(latest: GarminLatest, status: GarminStatus | null, now: number): SyncNotice | null {
  if (status && status.pollingState !== 'normal') {
    const why = status.pausedReason ? status.pausedReason.replace(/_/g, ' ') : status.pollingState.replace(/_/g, ' ');
    return { kind: 'not_updating', text: 'Garmin data is not updating', reason: why };
  }
  if (latest.dataFreshness === 'no_data') return null;
  const fetchedAt = status?.groups.fast?.lastSuccessfulFetchAt ?? latest.lastSuccessfulFetchAt;
  if (!fetchedAt) return { kind: 'not_updating', text: 'Garmin data is not updating', reason: 'no successful update yet' };
  const fetchAgeMin = (now - ms(fetchedAt)) / 60_000;
  if (fetchAgeMin > FETCH_OLD_MIN) {
    return { kind: 'not_updating', text: 'Garmin data is not updating', reason: `last successful update ${ageText(fetchAgeMin)}` };
  }
  const hr = latest.metrics.heart_rate;
  if ((hr && hr.quality === 'stale') || status?.groups.fast?.stale) {
    return { kind: 'waiting', text: 'Waiting for your watch to sync', reason: null };
  }
  return null;
}

export function buildWearableFromGarmin(s: GarminSnapshot, localNow: number): WearableData {
  const { latest } = s;
  const clockOffsetMs = ms(latest.generatedAt) - localNow;
  const now = localNow + clockOffsetMs;
  const m = latest.metrics;
  const series: Partial<Record<MetricKey, Sample[]>> = {};

  const put = (key: MetricKey, samples: Sample[]) => {
    const clean = samples.filter((x) => Number.isFinite(x.t) && Number.isFinite(x.v)).sort((a, b) => a.t - b.t);
    if (clean.length > 0) series[key] = clean;
  };

  put('heartRate', withLatest(toSamples(s.heartRate, 'heart_rate'), m.heart_rate));
  put('stress', withLatest(toSamples(s.stressBattery, 'stress_level'), m.stress_level));
  put('bodyBattery', withLatest(toSamples(s.stressBattery, 'body_battery'), m.body_battery));

  const daily = (metric: string, map?: (v: number) => number) => lastPerDay(withLatest(toSamples(s.daily, metric, map), m[metric], map));
  put('restingHr', daily('resting_heart_rate'));
  put('hrv', daily('hrv_overnight_avg'));
  put('sleep', daily('sleep_duration', secondsToMinutes));
  put('steps', daily('steps_day_cumulative'));
  const spo2 = daily('spo2_day_avg');
  put('spo2', spo2.length > 0 ? spo2 : daily('spo2_sleep_avg'));
  const resp = daily('respiration_waking_avg');
  put('respiratory', resp.length > 0 ? resp : daily('respiration_sleep_avg'));

  // 15-minute step bars for today (counts, not a running total).
  const stepBars = toSamples(s.stepsToday, 'steps_interval').sort((a, b) => a.t - b.t);

  const stages = m.sleep_stages && typeof m.sleep_stages.value === 'object' ? (m.sleep_stages.value as Record<string, unknown>) : null;
  const stageMin = (k: string): number | null => (stages && typeof stages[k] === 'number' && Number.isFinite(stages[k] as number) ? (stages[k] as number) / 60 : null);
  const sleepEntry = m.sleep_duration ? numericValue(m.sleep_duration.value) : null;
  const deep = stageMin('deep_sleep_seconds');
  const light = stageMin('light_sleep_seconds');
  const rem = stageMin('rem_sleep_seconds');
  const awake = stageMin('awake_seconds');
  const lastNight =
    sleepEntry !== null && deep !== null && light !== null && rem !== null && awake !== null
      ? { totalMin: sleepEntry / 60, deepMin: deep, remMin: rem, lightMin: light, awakeMin: awake }
      : null;

  const exercises: Exercise[] = [];
  for (const o of s.exercises) {
    if (o.metric !== 'exercise_session') continue;
    const dur = numericValue(o.value);
    if (dur === null || dur <= 0) continue;
    const d = o.details ?? (typeof o.value === 'object' ? (o.value as Record<string, unknown>) : {});
    const n = (k: string) => (typeof d[k] === 'number' && Number.isFinite(d[k] as number) ? (d[k] as number) : null);
    exercises.push({ t: ms(o.measuredAt), durationMin: dur / 60, type: typeof d.type === 'string' ? d.type : null, distanceM: n('distance_m'), avgHr: n('avg_hr') });
  }
  exercises.sort((a, b) => b.t - a.t);

  const derived: Partial<Record<MetricKey, boolean>> = {};
  const flag = (key: MetricKey, name: string) => {
    if (series[key] && m[name]) derived[key] = m[name].origin === 'garmin_derived';
  };
  flag('heartRate', 'heart_rate');
  flag('stress', 'stress_level');
  flag('bodyBattery', 'body_battery');
  flag('restingHr', 'resting_heart_rate');
  flag('hrv', 'hrv_overnight_avg');
  flag('sleep', 'sleep_duration');
  flag('steps', 'steps_day_cumulative');
  flag('spo2', 'spo2_day_avg');
  flag('respiratory', 'respiration_waking_avg');

  const activeSeconds = m.active_seconds_day ? numericValue(m.active_seconds_day.value) : null;
  const score = m.sleep_score ? numericValue(m.sleep_score.value) : null;

  return {
    isDemo: false,
    source: 'garmin',
    clockOffsetMs,
    stepsSlotMs: 15 * 60_000,
    sleepScore: score,
    exercises: exercises.slice(0, 10),
    derived,
    sync: syncNotice(latest, s.status, now),
    device: 'Garmin watch',
    fetchedAt: localNow,
    series,
    stepBars,
    activeMinutes: activeSeconds === null ? null : Math.round(activeSeconds / 60),
    lastNight,
  };
}

/** History windows the loader asks for, relative to server-adjusted `now` (all UTC ISO). */
export function historyWindows(now: number): { hr: [string, string]; today: [string, string]; fast: [string, string]; daily: [string, string]; exercises: [string, string] } {
  const iso = (t: number) => new Date(t).toISOString();
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return {
    hr: [iso(now - DAY), iso(now)],
    today: [iso(d.getTime()), iso(now)],
    fast: [iso(now - DAY), iso(now)],
    // The API allows at most 14 days per request.
    daily: [iso(now - 13.5 * DAY), iso(now)],
    exercises: [iso(now - 7 * DAY), iso(now)],
  };
}
