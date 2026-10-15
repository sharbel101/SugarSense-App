import { z } from 'zod';

/**
 * The subset of the forecast service's `GET /glucose` body that this proxy consumes (see
 * `../README.md` for the full upstream contract). Same pattern as meals Gate 1: the upstream JSON is
 * parsed against this one schema and anything that does not match is a hard failure - the caller
 * turns it into `status: "unavailable"`, never a partially-trusted result.
 *
 * Deliberately NOT declared here (Zod strips unknown keys, so they can never be forwarded):
 * `forecast[]` (duplicate of `predictions`), `hazard_low_risk` (experimental, "not yet validated"),
 * `meta.normalization` / `meta.inference_ms` / ..., and every excursion field the response contract
 * does not carry (`state`, `estimated_range`, `data_quality`, ...).
 *
 * Tolerance: the hypo/hyper/excursion sub-objects and every field inside them may be null or absent
 * upstream (current glucose is still valid without them). `history`/`predictions`/`forecast_available`
 * are required - a missing one means the contract drifted, and failing loudly beats guessing.
 */

// Z-suffixed in practice, but offsets are accepted so a harmless "+00:00" does not take the app down.
const isoTimestamp = z.iso.datetime({ offset: true });

const timePointSchema = z.object({ time: isoTimestamp, value: z.number() });

const nullableNumber = z.number().nullish();
const nullableString = z.string().nullish();
const nullableBoolean = z.boolean().nullish();
// A calibrated probability outside [0, 1] is an upstream bug, not a value to pass on.
const nullableProbability = z.number().min(0).max(1).nullish();

const horizonRangeSchema = z.object({
  forecast: nullableNumber,
  low: nullableNumber,
  high: nullableNumber,
});

const excursionSchema = z.object({
  mode: nullableString,
  trend_mgdl_per_min: nullableNumber,
  // keys are horizon minutes as strings: "15" | "30" | "45"
  horizon_ranges: z.record(z.string(), horizonRangeSchema).nullish(),
});

// Keys such as "15m_probability" start with a digit - quoted keys, bracket access downstream.
const hypoglycemiaSchema = z.object({
  '15m_probability': nullableProbability,
  '30m_probability': nullableProbability,
  '45m_probability': nullableProbability,
  already_low: nullableBoolean,
  alert: nullableBoolean,
  alert_since: nullableString,
  headline: nullableString,
  predicted_glucose_15m: nullableNumber,
  predicted_glucose_30m: nullableNumber,
  predicted_glucose_45m: nullableNumber,
});

const hyperglycemiaSchema = z.object({
  '15m_probability': nullableProbability,
  '30m_probability': nullableProbability,
  '45m_probability': nullableProbability,
  already_high: nullableBoolean,
  alert: nullableBoolean,
  alert_since: nullableString,
  headline: nullableString,
  predicted_glucose_15m: nullableNumber,
  predicted_glucose_30m: nullableNumber,
  predicted_glucose_45m: nullableNumber,
  excursion: excursionSchema.nullish(),
});

const metaSchema = z.object({
  model: nullableString,
  generated_at: nullableString,
  served_at: nullableString,
  forecast_unavailable_reason: nullableString,
});

export const upstreamGlucoseSchema = z.object({
  glucose: z.number(),
  // CLAUDE.md section 3, invariant 1: mg/dL only. A different unit is rejected, not converted.
  unit: z.literal('mg/dL'),
  timestamp: isoTimestamp,
  history: z.array(timePointSchema),
  predictions: z.array(timePointSchema),
  forecast_available: z.boolean(),
  hypoglycemia: hypoglycemiaSchema.nullish(),
  hyperglycemia: hyperglycemiaSchema.nullish(),
  meta: metaSchema.nullish(),
});

export type UpstreamGlucose = z.infer<typeof upstreamGlucoseSchema>;
