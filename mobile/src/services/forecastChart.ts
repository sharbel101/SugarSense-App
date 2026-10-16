import type { GlucoseOk } from '../api/glucoseContract';
import type { EventRoleDisplay, ForecastOkDisplay } from '../api/forecastContract';
import {
  CHART_VIEWBOX_HEIGHT,
  CHART_VIEWBOX_WIDTH,
  type ChartPoint,
  type GlucoseChartModel,
} from './glucoseChart.ts';

/**
 * Chart geometry from the history in `GET /glucose` plus the 3-hour forecast in `GET /forecast`.
 * Pure. Nothing is invented: the line, extension, band and glucose-only comparison come straight
 * from the server's points; when there is no forecast the caller keeps using `buildGlucoseChart`.
 */

export type ForecastScrubPoint = {
  x: number;
  y: number;
  timeMs: number;
  /** The line the person sees (adjusted for what they logged). */
  value: number;
  minutesAhead: number;
  low: number;
  high: number;
  /** Glucose-only value at this point; null after the glucose-only model's horizon. */
  baseline: number | null;
  extension: boolean;
};

export type EventMarker = {
  id: string;
  type: 'meal' | 'insulin';
  role: EventRoleDisplay;
  timeMs: number;
  x: number;
};

export type ForecastChartModel = GlucoseChartModel & {
  /** Dotted continuation after the glucose-only horizon; empty when there is none. */
  extension: ChartPoint[];
  /** Thin glucose-only line; empty unless it differs from the adjusted line by >= 1 mg/dL somewhere. */
  baselineLine: ChartPoint[];
  hasBaselineLine: boolean;
  hasExtension: boolean;
  markers: EventMarker[];
  scrubPoints: ForecastScrubPoint[];
};

const MIN = 60_000;
const PAD_Y = 10;
const MIN_Y_SPAN_MGDL = 80;
const DEFAULT_HISTORY_MIN = 60;

export function buildForecastChart(data: GlucoseOk, forecast: ForecastOkDisplay): ForecastChartModel {
  const W = CHART_VIEWBOX_WIDTH;
  const H = CHART_VIEWBOX_HEIGHT;
  const nowT = Date.parse(data.measuredAt);

  const history = data.history.map((p) => ({ t: Date.parse(p.time), v: p.value })).filter((p) => p.t < nowT);
  const t0 = history.length > 0 ? history[0].t : nowT - DEFAULT_HISTORY_MIN * MIN;

  const pts = forecast.points
    .map((p) => ({ ...p, t: Date.parse(p.time) }))
    .filter((p) => p.t > nowT)
    .sort((a, b) => a.t - b.t);
  const hasForecast = pts.length > 0;
  const tEnd = hasForecast ? pts[pts.length - 1].t : nowT;
  const span = Math.max(tEnd - t0, MIN);

  const values = [data.glucoseMgdl, ...history.map((p) => p.v)];
  for (const p of pts) {
    values.push(p.adjusted, p.low, p.high);
    if (p.baseline !== null) values.push(p.baseline);
  }
  let lo = Math.floor((Math.min(...values) - 10) / 10) * 10;
  let hi = Math.ceil((Math.max(...values) + 10) / 10) * 10;
  if (hi - lo < MIN_Y_SPAN_MGDL) {
    const mid = (hi + lo) / 2;
    lo = Math.floor((mid - MIN_Y_SPAN_MGDL / 2) / 10) * 10;
    hi = lo + MIN_Y_SPAN_MGDL;
  }
  lo = Math.max(0, lo);

  const xOf = (t: number) => ((t - t0) / span) * W;
  const yOf = (v: number) => PAD_Y + ((hi - v) / (hi - lo)) * (H - 2 * PAD_Y);

  const nowPoint = { x: xOf(nowT), y: yOf(data.glucoseMgdl) };
  const actual: ChartPoint[] = [...history.map((p) => ({ x: xOf(p.t), y: yOf(p.v) })), nowPoint];

  const main = pts.filter((p) => !p.extension);
  const ext = pts.filter((p) => p.extension);
  const predicted: ChartPoint[] = main.length > 0 ? [nowPoint, ...main.map((p) => ({ x: xOf(p.t), y: yOf(p.adjusted) }))] : [];
  // The dotted extension starts where the main line ends, so the two read as one continuous path.
  const joinPoint = main.length > 0 ? { x: xOf(main[main.length - 1].t), y: yOf(main[main.length - 1].adjusted) } : nowPoint;
  const extension: ChartPoint[] = ext.length > 0 ? [joinPoint, ...ext.map((p) => ({ x: xOf(p.t), y: yOf(p.adjusted) }))] : [];

  const differs = pts.some((p) => p.baseline !== null && Math.abs(p.baseline - p.adjusted) >= 1);
  const baselineLine: ChartPoint[] = differs
    ? [nowPoint, ...pts.filter((p) => p.baseline !== null).map((p) => ({ x: xOf(p.t), y: yOf(p.baseline as number) }))]
    : [];

  const upper = pts.map((p) => ({ x: xOf(p.t), y: yOf(p.high) }));
  const lower = pts.map((p) => ({ x: xOf(p.t), y: yOf(p.low) })).reverse();
  const band: ChartPoint[] | undefined = hasForecast ? [nowPoint, ...upper, ...lower, nowPoint] : undefined;

  const gridValues: number[] = [];
  for (let v = Math.ceil(lo / 50) * 50; v <= hi; v += 50) {
    if (v > lo && v < hi) gridValues.push(v);
  }

  const xTicks: { frac: number; label: string }[] = [];
  const first = Math.round((nowT - t0) / MIN);
  if (first >= 5) xTicks.push({ frac: 0, label: `-${first}m` });
  xTicks.push({ frac: (nowT - t0) / span, label: 'Latest' });
  for (const m of [60, 120, 180]) {
    const t = nowT + m * MIN;
    if (hasForecast && t <= tEnd + MIN) xTicks.push({ frac: (t - t0) / span, label: `+${m / 60}h` });
  }

  const markers: EventMarker[] = [];
  for (const e of forecast.mealAware.events) {
    if (e.role === 'excluded') continue;
    const t = Date.parse(e.time);
    if (!Number.isFinite(t) || t < t0 || t > tEnd) continue;
    markers.push({ id: e.id, type: e.type, role: e.role, timeMs: t, x: xOf(t) });
  }

  const scrubPoints: ForecastScrubPoint[] = pts.map((p) => ({
    x: xOf(p.t),
    y: yOf(p.adjusted),
    timeMs: p.t,
    value: p.adjusted,
    minutesAhead: Math.round((p.t - nowT) / MIN),
    low: p.low,
    high: p.high,
    baseline: p.baseline,
    extension: p.extension,
  }));

  return {
    viewBoxWidth: W,
    viewBoxHeight: H,
    actual,
    predicted,
    forecastPoints: scrubPoints,
    band,
    nowX: nowPoint.x,
    gridLinesY: gridValues.map(yOf),
    xTicks,
    yTicks: gridValues.map((v) => ({ frac: yOf(v) / H, label: String(v) })),
    yMinMgdl: lo,
    yMaxMgdl: hi,
    hasForecast,
    hasBand: hasForecast,
    extension,
    baselineLine,
    hasBaselineLine: baselineLine.length > 0,
    hasExtension: extension.length > 0,
    markers,
    scrubPoints,
  };
}

/** Text alternative for the chart: trend, range, and whether logged events are included. */
export function describeForecastForScreenReader(forecast: ForecastOkDisplay): string {
  const a = forecast.mealAware.availability;
  const meals = a.mealsUsed + a.mealsRangeOnly;
  const doses = a.insulinDosesUsed + a.insulinDosesRangeOnly;
  const included =
    meals + doses === 0
      ? 'No logged meals or insulin are included.'
      : `Including ${meals} logged meal${meals === 1 ? '' : 's'} and ${doses} insulin dose${doses === 1 ? '' : 's'}.`;
  const at = (min: number) => forecast.points.find((p) => p.minutes === min) ?? forecast.points[forecast.points.length - 1];
  const p = at(120);
  const horizon = `${Math.round(forecast.horizonMin / 60)} hours`;
  return `Forecast for the next ${horizon}. ${included} Around ${Math.round(p.adjusted)} milligrams per decilitre at ${p.minutes} minutes; predicted range ${Math.round(p.low)} to ${Math.round(p.high)}.`;
}
