import type { GlucoseOk } from '../api/glucoseContract';
import type { ForecastOkDisplay } from '../api/forecastContract';
import { CHART_VIEWBOX_HEIGHT, CHART_VIEWBOX_WIDTH, type ChartPoint } from './glucoseChart.ts';

/**
 * Geometry for the "how insulin and carbs wear off" graph: the blood-sugar line (measured, then the
 * dotted prediction) with the server's insulin-on-board and carbs-on-board curves drawn along the same
 * time axis. Pure. Nothing is worked out here: the curves are the per-point values the server sent
 * (`insulinOnBoardUnits`, `carbsOnBoardGrams`); a value the server did not send is a gap, never 0, and
 * a curve with fewer than two known values is not drawn at all.
 *
 * The two curves are drawn on their own scales (each from 0 at the bottom to its own largest value at
 * the top) so the SHAPE of how they wear off can be read next to the glucose line; the screen says
 * so and the readout gives the real numbers.
 */

const MIN = 60_000;
const PAD_Y = 10;
const MIN_Y_SPAN_MGDL = 80;
const DEFAULT_HISTORY_MIN = 60;

export type OnBoardScrubPoint = {
  x: number;
  timeMs: number;
  /** 0 = the latest reading. */
  minutesAhead: number;
  glucose: number;
  insulin: number | null;
  carbs: number | null;
};

export type OnBoardChartModel = {
  viewBoxWidth: number;
  viewBoxHeight: number;
  glucoseActual: ChartPoint[];
  /** Latest reading, then every predicted point; drawn dotted. */
  glucosePredicted: ChartPoint[];
  insulin: ChartPoint[];
  carbs: ChartPoint[];
  hasInsulin: boolean;
  hasCarbs: boolean;
  /** Largest value of each curve (its scale), null when the curve is not drawn. */
  insulinMax: number | null;
  carbsMax: number | null;
  insulinNow: number | null;
  insulinEnd: number | null;
  carbsNow: number | null;
  carbsEnd: number | null;
  endMinutes: number;
  nowX: number;
  gridLinesY: number[];
  xTicks: { frac: number; label: string }[];
  yTicks: { frac: number; label: string }[];
  scrubPoints: OnBoardScrubPoint[];
};

/** A curve needs at least two known values and something above zero to be worth drawing. */
function curveOf(values: (number | null)[]): { max: number } | null {
  const known = values.filter((v): v is number => v !== null && Number.isFinite(v) && v >= 0);
  if (known.length < 2) return null;
  const max = Math.max(...known);
  return max > 0 ? { max } : null;
}

export function buildOnBoardChart(data: GlucoseOk, forecast: ForecastOkDisplay): OnBoardChartModel {
  const W = CHART_VIEWBOX_WIDTH;
  const H = CHART_VIEWBOX_HEIGHT;
  const nowT = Date.parse(data.measuredAt);
  const a = forecast.mealAware.availability;

  const history = data.history.map((p) => ({ t: Date.parse(p.time), v: p.value })).filter((p) => p.t < nowT);
  const t0 = history.length > 0 ? history[0].t : nowT - DEFAULT_HISTORY_MIN * MIN;
  const pts = forecast.points
    .map((p) => ({ ...p, t: Date.parse(p.time) }))
    .filter((p) => p.t > nowT)
    .sort((x, y) => x.t - y.t);
  const tEnd = pts.length > 0 ? pts[pts.length - 1].t : nowT;
  const span = Math.max(tEnd - t0, MIN);
  const xOf = (t: number) => ((t - t0) / span) * W;

  // ---- blood sugar: its own scale, from the measured and predicted values only
  const values = [data.glucoseMgdl, ...history.map((p) => p.v), ...pts.map((p) => p.adjusted)];
  let lo = Math.floor((Math.min(...values) - 10) / 10) * 10;
  let hi = Math.ceil((Math.max(...values) + 10) / 10) * 10;
  if (hi - lo < MIN_Y_SPAN_MGDL) {
    const mid = (hi + lo) / 2;
    lo = Math.floor((mid - MIN_Y_SPAN_MGDL / 2) / 10) * 10;
    hi = lo + MIN_Y_SPAN_MGDL;
  }
  lo = Math.max(0, lo);
  const plotH = H - 2 * PAD_Y;
  const yGlucose = (v: number) => PAD_Y + ((hi - v) / (hi - lo)) * plotH;
  const yShare = (v: number, max: number) => PAD_Y + (1 - Math.min(1, Math.max(0, v / max))) * plotH;

  const nowPoint = { x: xOf(nowT), y: yGlucose(data.glucoseMgdl) };
  const glucoseActual: ChartPoint[] = [...history.map((p) => ({ x: xOf(p.t), y: yGlucose(p.v) })), nowPoint];
  const glucosePredicted: ChartPoint[] = pts.length > 0 ? [nowPoint, ...pts.map((p) => ({ x: xOf(p.t), y: yGlucose(p.adjusted) }))] : [];

  // ---- the two curves: the value now (the chip's number) followed by each point's value
  const insulinSeries: { t: number; v: number | null }[] = [{ t: nowT, v: a.insulinOnBoardUnits }, ...pts.map((p) => ({ t: p.t, v: p.insulinOnBoardUnits }))];
  const carbsSeries: { t: number; v: number | null }[] = [{ t: nowT, v: a.carbsOnBoardGrams }, ...pts.map((p) => ({ t: p.t, v: p.carbsOnBoardGrams }))];
  const insulinCurve = curveOf(insulinSeries.map((s) => s.v));
  const carbsCurve = curveOf(carbsSeries.map((s) => s.v));
  const line = (series: { t: number; v: number | null }[], curve: { max: number } | null): ChartPoint[] =>
    curve ? series.filter((s) => s.v !== null).map((s) => ({ x: xOf(s.t), y: yShare(s.v as number, curve.max) })) : [];

  const lastKnown = (series: { v: number | null }[]) => {
    for (let i = series.length - 1; i >= 0; i--) if (series[i].v !== null) return series[i].v;
    return null;
  };

  const gridValues: number[] = [];
  for (let v = Math.ceil(lo / 50) * 50; v <= hi; v += 50) if (v > lo && v < hi) gridValues.push(v);

  const xTicks: { frac: number; label: string }[] = [];
  const first = Math.round((nowT - t0) / MIN);
  if (first >= 5) xTicks.push({ frac: 0, label: `-${first}m` });
  xTicks.push({ frac: (nowT - t0) / span, label: 'Latest' });
  for (const m of [60, 120, 180]) {
    const t = nowT + m * MIN;
    if (pts.length > 0 && t <= tEnd + MIN) xTicks.push({ frac: (t - t0) / span, label: `+${m / 60}h` });
  }

  const scrubPoints: OnBoardScrubPoint[] = [
    { x: nowPoint.x, timeMs: nowT, minutesAhead: 0, glucose: data.glucoseMgdl, insulin: a.insulinOnBoardUnits, carbs: a.carbsOnBoardGrams },
    ...pts.map((p) => ({
      x: xOf(p.t),
      timeMs: p.t,
      minutesAhead: Math.round((p.t - nowT) / MIN),
      glucose: p.adjusted,
      insulin: p.insulinOnBoardUnits,
      carbs: p.carbsOnBoardGrams,
    })),
  ];

  return {
    viewBoxWidth: W,
    viewBoxHeight: H,
    glucoseActual,
    glucosePredicted,
    insulin: line(insulinSeries, insulinCurve),
    carbs: line(carbsSeries, carbsCurve),
    hasInsulin: insulinCurve !== null,
    hasCarbs: carbsCurve !== null,
    insulinMax: insulinCurve?.max ?? null,
    carbsMax: carbsCurve?.max ?? null,
    insulinNow: a.insulinOnBoardUnits,
    insulinEnd: insulinCurve ? lastKnown(insulinSeries) : null,
    carbsNow: a.carbsOnBoardGrams,
    carbsEnd: carbsCurve ? lastKnown(carbsSeries) : null,
    endMinutes: pts.length > 0 ? Math.round((tEnd - nowT) / MIN) : 0,
    nowX: nowPoint.x,
    gridLinesY: gridValues.map(yGlucose),
    xTicks,
    yTicks: gridValues.map((v) => ({ frac: yGlucose(v) / H, label: String(v) })),
    scrubPoints,
  };
}

/** The point nearest to an x position (in viewBox units); null when there are none. */
export function nearestOnBoardPoint(points: OnBoardScrubPoint[], x: number): OnBoardScrubPoint | null {
  let best: OnBoardScrubPoint | null = null;
  for (const p of points) if (best === null || Math.abs(p.x - x) < Math.abs(best.x - x)) best = p;
  return best;
}

const fmtU = (n: number) => (Math.round(n * 10) / 10).toFixed(1);
const fmtG = (n: number) => String(Math.round(n));

/** Text alternative: what the three lines do, in words (no exact per-point values). */
export function describeOnBoardChart(m: OnBoardChartModel): string {
  const parts: string[] = [
    m.glucosePredicted.length > 0
      ? 'Blood sugar over the last hour, with a dotted predicted line for the next hours.'
      : 'Blood sugar over the last hour. No prediction is available.',
  ];
  const hours = m.endMinutes >= 60 ? `${Math.round(m.endMinutes / 60)} hours` : `${m.endMinutes} minutes`;
  parts.push(
    m.hasInsulin && m.insulinNow !== null && m.insulinEnd !== null
      ? `Insulin on board falls from ${fmtU(m.insulinNow)} to ${fmtU(m.insulinEnd)} units over the next ${hours}.`
      : 'No insulin-on-board curve: nothing logged recently, so the amount is unknown.',
  );
  parts.push(
    m.hasCarbs && m.carbsNow !== null && m.carbsEnd !== null
      ? `Carbs on board fall from ${fmtG(m.carbsNow)} to ${fmtG(m.carbsEnd)} grams over the next ${hours}.`
      : 'No carbs-on-board curve: no meal logged recently.',
  );
  return parts.join(' ');
}
