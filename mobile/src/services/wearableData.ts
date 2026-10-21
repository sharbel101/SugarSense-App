import { DAY, HOUR, type MetricKey, type Sample, type WearableData } from './wearableModel.ts';

/**
 * The Wearable screen's data source.
 *
 * TODAY THERE IS NO WEARABLE CONNECTION AND NO WEARABLE ENDPOINT, so `getWearableData` returns DEMO data
 * (`isDemo: true`, `device: null`): deterministic sample series that exercise every state of the screen
 * (gaps, a baseline, a stale-able reading). They are NOT measurements and every screen says so. When a real
 * source exists, return it from here with `isDemo: false`; the screens read only `WearableData` and do not
 * change. Missing metrics are absent, never zero-filled.
 */

/** Deterministic pseudo-random in [0, 1) so the demo is stable between renders and tests. */
function rand(i: number): number {
  const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function buildDemoData(now: number): WearableData {
  const today = startOfDay(now);
  const series: Partial<Record<MetricKey, Sample[]>> = {};

  // Heart rate: every 5 min for 24 h, ending 4 min ago, with one 45-minute hole (wearable off / out of range).
  const hr: Sample[] = [];
  const end = now - 4 * 60_000;
  for (let t = end - DAY; t <= end; t += 5 * 60_000) {
    const hour = new Date(t).getHours() + new Date(t).getMinutes() / 60;
    const day = Math.max(0, Math.sin(((hour - 6) / 16) * Math.PI));
    const jitter = (rand(Math.round(t / 60_000)) - 0.5) * 8;
    const walk = rand(Math.round(t / 3_600_000) + 7) > 0.8 ? 25 : 0;
    const v = Math.round(56 + 16 * day + walk + jitter);
    if (t > now - 6 * HOUR - 20 * 60_000 && t < now - 6 * HOUR + 25 * 60_000) continue;
    hr.push({ t, v });
  }
  series.heartRate = hr;

  // Daily series, one value per morning for 30 days (a couple of days missing on purpose).
  const missing = new Set([9, 10, 21]);
  const daily = (base: number, spread: number, seed: number, decimals = 0): Sample[] => {
    const out: Sample[] = [];
    for (let d = 29; d >= 0; d--) {
      if (missing.has(d)) continue;
      const t = today - d * DAY + 7 * HOUR;
      if (t > now) continue;
      const raw = base + (rand(d * 3 + seed) - 0.5) * 2 * spread;
      const f = 10 ** decimals;
      out.push({ t, v: Math.round(raw * f) / f });
    }
    return out;
  };
  series.restingHr = daily(56, 3, 1);
  series.hrv = daily(48, 8, 2);
  series.sleep = daily(430, 50, 3);
  series.spo2 = daily(96.5, 1, 4);
  series.respiratory = daily(14.5, 0.8, 5, 1);
  series.skinTemp = daily(0, 0.4, 6, 1);

  // Steps: yesterday and earlier are final totals; today is a running total (hourly counts below).
  const stepBars: Sample[] = [];
  const hourNow = new Date(now).getHours();
  let sum = 0;
  for (let h = 6; h <= hourNow; h++) {
    const peak = h === 8 || h === 13 || h === 18 ? 900 : 250;
    const v = Math.round(peak * (0.4 + rand(h + 40) * 0.8));
    sum += v;
    stepBars.push({ t: today + h * HOUR, v });
  }
  const steps: Sample[] = [];
  for (let d = 29; d >= 1; d--) {
    if (missing.has(d)) continue;
    steps.push({ t: today - d * DAY + 23 * HOUR, v: Math.round(4000 + rand(d + 90) * 7000) });
  }
  if (stepBars.length > 0) steps.push({ t: now - 3 * 60_000, v: sum });
  series.steps = steps;

  series.battery = [{ t: now - 4 * 60_000, v: 78 }];

  // Last night's stages must add up to the sleep value the rest of the screen shows.
  const slept = series.sleep && series.sleep.length > 0 ? series.sleep[series.sleep.length - 1].v : null;
  const lastNight =
    slept === null
      ? null
      : { totalMin: slept, deepMin: Math.round(slept * 0.18), remMin: Math.round(slept * 0.22), awakeMin: 25, lightMin: slept - Math.round(slept * 0.18) - Math.round(slept * 0.22) - 25 };

  return {
    isDemo: true,
    source: 'demo',
    clockOffsetMs: 0,
    stepsSlotMs: HOUR,
    sleepScore: null,
    exercises: [],
    derived: {},
    sync: null,
    device: null,
    fetchedAt: now,
    series,
    stepBars,
    activeMinutes: 38,
    lastNight,
  };
}

export function getWearableData(now: number = Date.now()): WearableData {
  return buildDemoData(now);
}
