import type { GlucoseOk } from '../api/glucoseContract';

/**
 * Turns a real `GlucoseOk` payload into chart geometry. Pure; x is real time (ms since the first
 * point), y is mg/dL, both mapped linearly into the SVG viewBox. Nothing is faked: no point is
 * invented, the band exists only when the server supplied `ranges`, and the forecast line exists
 * only when `forecastAvailable`.
 */

export type ChartPoint = { x: number; y: number };

/** One server-supplied forecast point, with its chart position, for press-and-drag inspection. */
export type ForecastPoint = {
  x: number;
  y: number;
  timeMs: number;
  value: number;
  minutesAhead: number;
  /** Present when the server supplied an 80% range for this point (GET /forecast). */
  low?: number;
  high?: number;
  /** Glucose-only value; null after that model's horizon. */
  baseline?: number | null;
  extension?: boolean;
};

export type GlucoseChartModel = {
  viewBoxWidth: number;
  viewBoxHeight: number;
  actual: ChartPoint[];
  /** Starts at the latest reading so the dashed line visibly continues the solid one. */
  predicted: ChartPoint[];
  /** The forecast points as supplied (after the latest reading); empty when there is no forecast. */
  forecastPoints: ForecastPoint[];
  /** Polygon around the forecast built from `ranges` only; `undefined` when none were supplied. */
  band: ChartPoint[] | undefined;
  /** x of the latest reading. */
  nowX: number;
  gridLinesY: number[];
  /** Horizontal position as a 0..1 fraction of the chart width, for overlay labels. */
  xTicks: { frac: number; label: string }[];
  /** Vertical position as a 0..1 fraction of the chart height. */
  yTicks: { frac: number; label: string }[];
  yMinMgdl: number;
  yMaxMgdl: number;
  hasForecast: boolean;
  hasBand: boolean;
};

export const CHART_VIEWBOX_WIDTH = 350;
export const CHART_VIEWBOX_HEIGHT = 170;
const PAD_Y = 10;
const MIN_Y_SPAN_MGDL = 80;
const DEFAULT_HISTORY_MIN = 60;
const MIN = 60_000;

export function buildGlucoseChart(data: GlucoseOk): GlucoseChartModel {
  const W = CHART_VIEWBOX_WIDTH;
  const H = CHART_VIEWBOX_HEIGHT;
  const nowT = Date.parse(data.measuredAt);

  const history = data.history
    .map((p) => ({ t: Date.parse(p.time), v: p.value }))
    .filter((p) => p.t < nowT);
  const t0 = history.length > 0 ? history[0].t : nowT - DEFAULT_HISTORY_MIN * MIN;

  const forecast = data.forecastAvailable
    ? data.predictions.map((p) => ({ t: Date.parse(p.time), v: p.value })).filter((p) => p.t > nowT)
    : [];
  const hasForecast = forecast.length > 0;
  const tEnd = hasForecast ? forecast[forecast.length - 1].t : nowT;
  const span = Math.max(tEnd - t0, MIN);

  const bandRanges = hasForecast && data.ranges ? data.ranges : [];
  const hasBand = bandRanges.length > 0;

  // y domain: every value that will be drawn, padded, rounded to 10 mg/dL, at least 80 mg/dL tall.
  const values = [data.glucoseMgdl, ...history.map((p) => p.v), ...forecast.map((p) => p.v)];
  for (const r of bandRanges) values.push(r.low, r.high);
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
  const predicted: ChartPoint[] = hasForecast
    ? [nowPoint, ...forecast.map((p) => ({ x: xOf(p.t), y: yOf(p.v) }))]
    : [];

  const forecastPoints: ForecastPoint[] = forecast.map((p) => ({
    x: xOf(p.t),
    y: yOf(p.v),
    timeMs: p.t,
    value: p.v,
    minutesAhead: Math.round((p.t - nowT) / MIN),
  }));

  let band: ChartPoint[] | undefined;
  if (hasBand) {
    const upper = bandRanges.map((r) => ({ x: xOf(nowT + r.minutes * MIN), y: yOf(r.high) }));
    const lower = bandRanges.map((r) => ({ x: xOf(nowT + r.minutes * MIN), y: yOf(r.low) })).reverse();
    band = [nowPoint, ...upper, ...lower, nowPoint];
  }

  const gridValues: number[] = [];
  for (let v = Math.ceil(lo / 50) * 50; v <= hi; v += 50) {
    if (v > lo && v < hi) gridValues.push(v);
  }

  const xTicks: { frac: number; label: string }[] = [];
  const first = Math.round((nowT - t0) / MIN);
  if (first >= 5) xTicks.push({ frac: 0, label: `-${first}m` });
  xTicks.push({ frac: (nowT - t0) / span, label: 'Latest' });
  for (const m of [60, 120]) {
    const t = nowT + m * MIN;
    if (hasForecast && t <= tEnd + MIN) xTicks.push({ frac: (t - t0) / span, label: `+${m}m` });
  }

  return {
    viewBoxWidth: W,
    viewBoxHeight: H,
    actual,
    predicted,
    forecastPoints,
    band,
    nowX: nowPoint.x,
    gridLinesY: gridValues.map(yOf),
    xTicks,
    yTicks: gridValues.map((v) => ({ frac: yOf(v) / H, label: String(v) })),
    yMinMgdl: lo,
    yMaxMgdl: hi,
    hasForecast,
    hasBand,
  };
}

/**
 * The forecast point whose x is closest to `x` (viewBox units); `undefined` when there are no points.
 * Pure so the drag behaviour can be tested without a UI.
 */
export function nearestForecastPoint(points: ForecastPoint[], x: number): ForecastPoint | undefined {
  let best: ForecastPoint | undefined;
  for (const p of points) {
    if (best === undefined || Math.abs(p.x - x) < Math.abs(best.x - x)) best = p;
  }
  return best;
}
