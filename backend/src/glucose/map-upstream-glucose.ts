import type {
  GlucoseHighRisk,
  GlucoseLowRisk,
  GlucoseOkResponse,
  GlucoseRange,
} from './glucose-response.js';
import type { UpstreamGlucose } from './schema/upstream-glucose.schema.js';

/**
 * Pure mapping from an already-validated upstream body to the client contract - no I/O, no clock.
 * Staleness/plausibility are decided by the caller (`GlucoseService`) before this runs, so
 * `ageMinutes` is passed in. Nothing here invents a number: every `null` in the output is a `null`
 * (or an absent key) upstream.
 */

const RANGE_HORIZONS_MIN = [15, 30, 45] as const;

const NO_PREDICTIONS_REASON = 'The forecast service returned no predictions.';

export function mapUpstreamGlucose(upstream: UpstreamGlucose, ageMinutes: number): GlucoseOkResponse {
  const hypo = upstream.hypoglycemia;
  const hyper = upstream.hyperglycemia;
  const excursion = hyper?.excursion;

  // `forecastAvailable: true` must always mean "there is something to plot". Upstream says
  // `forecast_available: false` => `predictions == []`; the reverse (true but empty) is also reported
  // as unavailable rather than as an available forecast with nothing in it.
  const predictions = upstream.forecast_available ? upstream.predictions : [];
  const forecastAvailable = predictions.length > 0;
  const forecastUnavailableReason = forecastAvailable
    ? null
    : (upstream.meta?.forecast_unavailable_reason ??
      (upstream.forecast_available ? NO_PREDICTIONS_REASON : null));

  const low: GlucoseLowRisk = {
    alert: hypo?.alert ?? null,
    alreadyLow: hypo?.already_low ?? null,
    headline: hypo?.headline ?? null,
    alertSince: hypo?.alert_since ?? null,
    predicted15: hypo?.predicted_glucose_15m ?? null,
    predicted30: hypo?.predicted_glucose_30m ?? null,
    predicted45: hypo?.predicted_glucose_45m ?? null,
    probability15: hypo?.['15m_probability'] ?? null,
    probability30: hypo?.['30m_probability'] ?? null,
    probability45: hypo?.['45m_probability'] ?? null,
  };

  const high: GlucoseHighRisk = {
    alert: hyper?.alert ?? null,
    alreadyHigh: hyper?.already_high ?? null,
    headline: hyper?.headline ?? null,
    alertSince: hyper?.alert_since ?? null,
    predicted15: hyper?.predicted_glucose_15m ?? null,
    predicted30: hyper?.predicted_glucose_30m ?? null,
    predicted45: hyper?.predicted_glucose_45m ?? null,
    probability15: hyper?.['15m_probability'] ?? null,
    probability30: hyper?.['30m_probability'] ?? null,
    probability45: hyper?.['45m_probability'] ?? null,
  };

  return {
    status: 'ok',
    glucoseMgdl: upstream.glucose,
    measuredAt: upstream.timestamp,
    ageMinutes,
    history: upstream.history,
    predictions,
    forecastAvailable,
    forecastUnavailableReason,
    trendMgdlPerMin: excursion?.trend_mgdl_per_min ?? null,
    low,
    high,
    ranges: mapRanges(excursion?.horizon_ranges),
    rangesAreShadow: excursion?.mode === 'shadow',
    modelVersion: upstream.meta?.model ?? null,
    generatedAt: upstream.meta?.generated_at ?? null,
    servedAt: upstream.meta?.served_at ?? null,
  };
}

type UpstreamHorizonRanges = NonNullable<
  NonNullable<NonNullable<UpstreamGlucose['hyperglycemia']>['excursion']>['horizon_ranges']
>;

/**
 * Only horizons 15/30/45 are exposed. A horizon with any missing value, or with low > high, is
 * dropped rather than repaired; if none survive the whole field is `null`.
 */
function mapRanges(horizonRanges: UpstreamHorizonRanges | null | undefined): GlucoseRange[] | null {
  if (!horizonRanges) return null;

  const ranges: GlucoseRange[] = [];
  for (const minutes of RANGE_HORIZONS_MIN) {
    const entry = horizonRanges[String(minutes)];
    if (!entry) continue;
    const { low, high, forecast } = entry;
    if (typeof low !== 'number' || typeof high !== 'number' || typeof forecast !== 'number') continue;
    if (low > high) continue;
    ranges.push({ minutes, low, high, forecast });
  }
  return ranges.length > 0 ? ranges : null;
}
