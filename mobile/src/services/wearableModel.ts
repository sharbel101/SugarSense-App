/**
 * Pure logic for the Wearable dashboard: metric catalogue, personal baselines, status, freshness,
 * time windows and chart geometry. No imports and no I/O, so plain Node can test it.
 *
 * Rules (root CLAUDE.md section 2/3/13): values are shown only if they were measured; a missing value is
 * `null`/absent, never 0 and never interpolated; status is always relative to the person's OWN history and
 * only once enough history exists; the wearable never measures glucose and nothing here is a score.
 */
import { formatTime12 } from './clock12.ts';

export type MetricKey = 'heartRate' | 'restingHr' | 'hrv' | 'sleep' | 'steps' | 'spo2' | 'respiratory' | 'skinTemp' | 'battery' | 'stress' | 'bodyBattery';
export type RangeKey = 'day' | 'week' | 'month';
/** One measurement: `t` = epoch ms, `v` in the metric's unit. */
export type Sample = { t: number; v: number };

export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export interface MetricInfo {
  key: MetricKey;
  label: string;
  unit: string;
  decimals: number;
  /** `instant` = many readings through the day; `daily` = one value per day. */
  kind: 'instant' | 'daily';
  about: string;
}

export const METRICS: Record<MetricKey, MetricInfo> = {
  heartRate: {
    key: 'heartRate',
    label: 'Heart rate',
    unit: 'bpm',
    decimals: 0,
    kind: 'instant',
    about: 'Beats per minute from the optical sensor on the wearable. It rises with movement, heat, stress and illness and falls at rest.',
  },
  restingHr: {
    key: 'restingHr',
    label: 'Resting heart rate',
    unit: 'bpm',
    decimals: 0,
    kind: 'daily',
    about: 'The lowest steady heart rate of the day, usually overnight. It is compared with your own usual range, not with other people.',
  },
  hrv: {
    key: 'hrv',
    label: 'HRV',
    unit: 'ms',
    decimals: 0,
    kind: 'daily',
    about: 'Heart-rate variability (RMSSD): the variation in time between heartbeats, measured overnight. It differs a lot between people, so only your own baseline is meaningful.',
  },
  sleep: {
    key: 'sleep',
    label: 'Sleep',
    unit: 'min',
    decimals: 0,
    kind: 'daily',
    about: 'Time asleep as detected by the wearable. Sleep stages are estimates, not a sleep study.',
  },
  steps: {
    key: 'steps',
    label: 'Steps',
    unit: 'steps',
    decimals: 0,
    kind: 'daily',
    about: 'Steps counted since midnight. Today’s total only goes up during the day; earlier days show their final total.',
  },
  spo2: {
    key: 'spo2',
    label: 'SpO₂',
    unit: '%',
    decimals: 0,
    kind: 'daily',
    about: 'Estimated blood-oxygen saturation. Wrist readings can be noisy; this is not a medical measurement.',
  },
  respiratory: {
    key: 'respiratory',
    label: 'Respiratory rate',
    unit: 'br/min',
    decimals: 1,
    kind: 'daily',
    about: 'Breaths per minute, estimated overnight.',
  },
  skinTemp: {
    key: 'skinTemp',
    label: 'Skin temperature',
    unit: '°C',
    decimals: 1,
    kind: 'daily',
    about: 'Change in skin temperature from your own usual level. It is not a body temperature.',
  },
  stress: {
    key: 'stress',
    label: 'Stress',
    unit: '/ 100',
    decimals: 0,
    kind: 'instant',
    about: 'Garmin’s stress score (0 to 100), calculated by Garmin from heart-rate variability. It is not a glucose signal.',
  },
  bodyBattery: {
    key: 'bodyBattery',
    label: 'Body battery',
    unit: '/ 100',
    decimals: 0,
    kind: 'instant',
    about: 'Garmin’s energy estimate (0 to 100), calculated by Garmin from heart-rate variability, stress, sleep and activity.',
  },
  battery: {
    key: 'battery',
    label: 'Battery',
    unit: '%',
    decimals: 0,
    kind: 'instant',
    about: 'Battery level of the wearable.',
  },
};

/** What a data source must provide. Missing metrics are simply absent (never zero-filled). */
export type SyncNotice = { kind: 'waiting' | 'not_updating'; text: string; reason: string | null };
export type Exercise = { t: number; durationMin: number; type: string | null; distanceM: number | null; avgHr: number | null };

export interface WearableData {
  isDemo: boolean;
  source: 'demo' | 'garmin';
  /** Server time minus device time when the data was read; add to `Date.now()` so ages do not depend on the phone clock. */
  clockOffsetMs: number;
  /** Length of one steps bar: one hour in the demo, 15 minutes from Garmin. */
  stepsSlotMs: number;
  sleepScore: number | null;
  exercises: Exercise[];
  /** Metrics the source says were calculated by the vendor (shown as "Calculated by Garmin"). */
  derived: Partial<Record<MetricKey, boolean>>;
  /** Why data may look old: waiting for the watch to sync, or the pipeline itself is not updating. */
  sync: SyncNotice | null;
  /** `null` = no device connected. */
  device: string | null;
  fetchedAt: number;
  series: Partial<Record<MetricKey, Sample[]>>;
  /** Steps counted in each slot of today (`t` = slot start; slot length is `stepsSlotMs`). */
  stepBars: Sample[];
  activeMinutes: number | null;
  /** Last night's stage minutes, when the device reports stages. */
  lastNight: { totalMin: number; deepMin: number; remMin: number; lightMin: number; awakeMin: number } | null;
}

export function sorted(samples: Sample[] | undefined): Sample[] {
  return (samples ?? []).filter((s) => Number.isFinite(s.t) && Number.isFinite(s.v)).sort((a, b) => a.t - b.t);
}

export function latestOf(samples: Sample[] | undefined): Sample | null {
  const s = sorted(samples);
  return s.length > 0 ? s[s.length - 1] : null;
}

/* ---------------------------------------------------------------- freshness */

export type Freshness = { state: 'fresh' | 'delayed' | 'stale' | 'none'; text: string; ageMin: number | null };

export function ageText(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) {
    const h = Math.floor(m / 60);
    return `${h} h ago`;
  }
  return `${Math.floor(m / 1440)} d ago`;
}

export const FRESH_INSTANT_MIN = 15;
export const DELAYED_INSTANT_MIN = 120;
export const FRESH_DAILY_MIN = 36 * 60;

/** Fresh / delayed / stale from the MEASUREMENT time (not from when the request succeeded). */
export function freshnessOf(measuredAt: number | null, now: number, kind: 'instant' | 'daily'): Freshness {
  if (measuredAt === null || !Number.isFinite(measuredAt)) return { state: 'none', text: 'No measurement yet', ageMin: null };
  const ageMin = Math.max(0, (now - measuredAt) / 60_000);
  const at = ageText(ageMin);
  const when = `${formatTime12(new Date(measuredAt))} (${at})`;
  if (kind === 'daily') {
    return ageMin <= FRESH_DAILY_MIN ? { state: 'fresh', text: `Measured ${when}`, ageMin } : { state: 'stale', text: `Stale · measured ${when}`, ageMin };
  }
  if (ageMin <= FRESH_INSTANT_MIN) return { state: 'fresh', text: `Measured ${when}`, ageMin };
  if (ageMin <= DELAYED_INSTANT_MIN) return { state: 'delayed', text: `Data delayed · measured ${when}`, ageMin };
  return { state: 'stale', text: `Stale · measured ${when}`, ageMin };
}

/* ----------------------------------------------------------------- baseline */

export interface Baseline {
  low: number;
  high: number;
  median: number;
  /** Prior days used. */
  n: number;
}

export const BASELINE_MIN_DAYS = 7;
export const BASELINE_WINDOW_DAYS = 28;

function median(values: number[]): number {
  const a = [...values].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 === 1 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/**
 * The person's own usual range for a daily metric: median +/- 1.5 robust SDs of the PRIOR days (the latest
 * value is excluded so it cannot move its own baseline). `null` until `BASELINE_MIN_DAYS` days exist.
 */
export function baselineOf(daily: Sample[] | undefined, now: number): Baseline | null {
  const all = sorted(daily);
  if (all.length < 2) return null;
  const prior = all.slice(0, -1).filter((s) => s.t >= now - BASELINE_WINDOW_DAYS * DAY);
  if (prior.length < BASELINE_MIN_DAYS) return null;
  const values = prior.map((s) => s.v);
  const med = median(values);
  const mad = median(values.map((v) => Math.abs(v - med)));
  const half = Math.max(1.5 * 1.4826 * mad, Math.abs(med) * 0.03, 0.01);
  return { low: med - half, high: med + half, median: med, n: prior.length };
}

export type Status = 'within' | 'above' | 'below' | 'building' | 'none';

export function statusOf(value: number | null, baseline: Baseline | null): Status {
  if (value === null || !Number.isFinite(value)) return 'none';
  if (baseline === null) return 'building';
  if (value > baseline.high) return 'above';
  if (value < baseline.low) return 'below';
  return 'within';
}

export const STATUS_TEXT: Record<Status, string> = {
  within: 'Within your usual range',
  above: 'Above your usual range',
  below: 'Below your usual range',
  building: 'Building your baseline',
  none: 'No data',
};

export function formatNumber(v: number | null, decimals = 0): string {
  if (v === null || !Number.isFinite(v)) return '-';
  const s = decimals === 0 ? String(Math.round(v)) : v.toFixed(decimals);
  return Math.abs(v) >= 1000 ? Number(s).toLocaleString('en-US', { maximumFractionDigits: decimals }) : s;
}

/** "About 8% above your usual (48 ms)" - from the data, or `null` when there is no baseline. */
export function trendText(latest: number | null, baseline: Baseline | null, info: MetricInfo): string | null {
  if (latest === null || baseline === null || baseline.median === 0) return null;
  const pct = ((latest - baseline.median) / Math.abs(baseline.median)) * 100;
  const usual = `${formatNumber(baseline.median, info.decimals)} ${info.unit}`;
  if (Math.abs(pct) < 1) return `About the same as your usual (${usual}).`;
  return `About ${Math.round(Math.abs(pct))}% ${pct > 0 ? 'above' : 'below'} your usual (${usual}).`;
}

/** "7 h 20 min" for minutes asleep. */
export function formatSleep(min: number | null): string {
  if (min === null || !Number.isFinite(min) || min < 0) return '-';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/* ------------------------------------------------------------------- ranges */

export const RANGE_MS: Record<RangeKey, number> = { day: DAY, week: 7 * DAY, month: 30 * DAY };
export const RANGE_LABEL: Record<RangeKey, string> = { day: 'Day', week: 'Week', month: 'Month' };

export function windowOf(samples: Sample[] | undefined, range: RangeKey, now: number): Sample[] {
  const from = now - RANGE_MS[range];
  return sorted(samples).filter((s) => s.t >= from && s.t <= now);
}

/** Ranges that have enough real data to draw. Instant metrics: day only. Daily metrics: week / month. */
export function availableRanges(info: MetricInfo, samples: Sample[] | undefined, now: number): RangeKey[] {
  const s = sorted(samples);
  if (info.kind === 'instant') {
    const w = windowOf(s, 'day', now);
    return w.length >= 6 && w[w.length - 1].t - w[0].t >= 3 * HOUR ? ['day'] : [];
  }
  const out: RangeKey[] = [];
  if (windowOf(s, 'week', now).length >= 3) out.push('week');
  if (windowOf(s, 'month', now).length >= 8) out.push('month');
  return out;
}

/** Largest gap (ms) that still draws a connected line. */
export function gapLimit(info: MetricInfo): number {
  return info.kind === 'instant' ? 30 * 60_000 : 36 * HOUR;
}

/* ------------------------------------------------------------- chart geometry */

export type Pt = { x: number; y: number; t: number; v: number };
export interface LineGeom {
  segments: string[];
  singles: Pt[];
  points: Pt[];
  band: { y1: number; y2: number } | null;
  yMin: number;
  yMax: number;
}
export interface Box {
  t0: number;
  t1: number;
  w: number;
  h: number;
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Line geometry with BREAKS at gaps larger than `gapMs` (missing time is never drawn as a line). */
export function buildLine(samples: Sample[], box: Box, gapMs: number, baseline?: Baseline | null): LineGeom {
  const top = box.top ?? 6;
  const bottom = box.bottom ?? 6;
  const left = box.left ?? 4;
  const right = box.right ?? 4;
  const data = sorted(samples).filter((s) => s.t >= box.t0 && s.t <= box.t1);
  const vals = data.map((s) => s.v);
  if (baseline) vals.push(baseline.low, baseline.high);
  let lo = vals.length ? Math.min(...vals) : 0;
  let hi = vals.length ? Math.max(...vals) : 1;
  if (hi - lo < 1e-6) {
    lo -= 1;
    hi += 1;
  }
  const pad = (hi - lo) * 0.1;
  lo -= pad;
  hi += pad;
  const x = (t: number) => left + ((t - box.t0) / Math.max(1, box.t1 - box.t0)) * (box.w - left - right);
  const y = (v: number) => top + (1 - (v - lo) / (hi - lo)) * (box.h - top - bottom);
  const points: Pt[] = data.map((s) => ({ x: r1(x(s.t)), y: r1(y(s.v)), t: s.t, v: s.v }));
  const segments: string[] = [];
  const singles: Pt[] = [];
  let run: Pt[] = [];
  const flush = () => {
    if (run.length === 1) singles.push(run[0]);
    else if (run.length > 1) segments.push(run.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' '));
    run = [];
  };
  for (const p of points) {
    if (run.length > 0 && p.t - run[run.length - 1].t > gapMs) flush();
    run.push(p);
  }
  flush();
  return {
    segments,
    singles,
    points,
    band: baseline ? { y1: r1(y(baseline.high)), y2: r1(y(baseline.low)) } : null,
    yMin: lo,
    yMax: hi,
  };
}

export type Bar = { x: number; y: number; w: number; h: number; t: number; v: number };

/** Bars from slot 0 at `t0`; a slot with no sample has NO bar (unknown is not zero). Domain is 0..max. */
export function buildBars(samples: Sample[], box: Box, slotMs: number): { bars: Bar[]; max: number; slots: number } {
  const top = box.top ?? 6;
  const bottom = box.bottom ?? 2;
  const slots = Math.max(1, Math.ceil((box.t1 - box.t0) / slotMs));
  const slotW = box.w / slots;
  const data = sorted(samples).filter((s) => s.t >= box.t0 && s.t < box.t1 + 1);
  const max = Math.max(1, ...data.map((s) => s.v));
  const bars: Bar[] = data.map((s) => {
    const i = Math.min(slots - 1, Math.floor((s.t - box.t0) / slotMs));
    const h = Math.max(1.5, (s.v / max) * (box.h - top - bottom));
    return { x: r1(i * slotW + slotW * 0.15), y: r1(box.h - bottom - h), w: r1(Math.max(1, slotW * 0.7)), h: r1(h), t: s.t, v: s.v };
  });
  return { bars, max, slots };
}

/** Index of the item whose x is nearest to `x`; -1 for an empty list. */
export function nearestByX(items: { x: number }[], x: number): number {
  let best = -1;
  let bestD = Infinity;
  items.forEach((p, i) => {
    const d = Math.abs(p.x - x);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/* ------------------------------------------------------------------ summary */

export interface MetricSummary {
  info: MetricInfo;
  latest: Sample | null;
  freshness: Freshness;
  /** Only daily metrics have a personal baseline. */
  baseline: Baseline | null;
  status: Status;
}

/** Everything a tile needs for one metric, computed from the data source and nothing else. */
export function summaryOf(data: WearableData, key: MetricKey, now: number): MetricSummary {
  const info = METRICS[key];
  const samples = data.series[key];
  const latest = latestOf(samples);
  const baseline = info.kind === 'daily' && key !== 'steps' ? baselineOf(samples, now) : null;
  return {
    info,
    latest,
    freshness: freshnessOf(latest ? latest.t : null, now, info.kind),
    baseline,
    // Heart rate, steps and battery move all day: no "usual range" status for them.
    status: info.kind === 'daily' && key !== 'steps' ? statusOf(latest ? latest.v : null, baseline) : 'none',
  };
}

export function minMax(samples: Sample[]): { min: number; max: number; mean: number } | null {
  if (samples.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const s of samples) {
    min = Math.min(min, s.v);
    max = Math.max(max, s.v);
    sum += s.v;
  }
  return { min, max, mean: sum / samples.length };
}

/** True when any two consecutive samples are further apart than `gapMs` (the chart will show a break). */
export function hasGap(samples: Sample[], gapMs: number): boolean {
  const s = sorted(samples);
  for (let i = 1; i < s.length; i++) if (s[i].t - s[i - 1].t > gapMs) return true;
  return false;
}

/* -------------------------------------------------------------------- gauges */

export interface UsualGauge {
  /** Needle position, 0 (far below usual) to 1 (far above usual). */
  fraction: number;
  /** The person's usual range as a slice of the same 0..1 scale. */
  usualFrom: number;
  usualTo: number;
  zone: 'below' | 'within' | 'above';
}

/**
 * Where a value sits against the person's OWN usual range. The scale spans three usual half-widths either side of
 * the median, so the usual range is the middle third. It says "below / within / above your usual", never
 * "good" or "bad": what a deviation means is for the person and their clinician.
 */
export function usualGauge(value: number, b: Baseline): UsualGauge {
  const half = Math.max((b.high - b.low) / 2, 1e-6);
  const lo = b.median - 3 * half;
  const hi = b.median + 3 * half;
  const f = (v: number) => Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
  return { fraction: f(value), usualFrom: f(b.low), usualTo: f(b.high), zone: value < b.low ? 'below' : value > b.high ? 'above' : 'within' };
}

/** Garmin's own stress ranges (calculated by Garmin; shown with that label). */
export const STRESS_BANDS = [
  { key: 'rest', label: 'Rest', from: 0, to: 25 },
  { key: 'low', label: 'Low', from: 25, to: 50 },
  { key: 'medium', label: 'Medium', from: 50, to: 75 },
  { key: 'high', label: 'High', from: 75, to: 100 },
] as const;

export function stressBand(v: number): (typeof STRESS_BANDS)[number] {
  return STRESS_BANDS.find((b) => v <= b.to) ?? STRESS_BANDS[3];
}
