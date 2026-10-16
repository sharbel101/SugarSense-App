/**
 * Insulin and carbohydrate kernels from the forecasting-engine specification
 * (docs/research/glucose-forecasting-engine-spec.md, sections 4 and 5). Pure functions, float64,
 * minutes in, dimensionless fractions out. No I/O, no clock, no Date.
 *
 * Insulin: two-parameter exponential curve (oref0 / Maksimovic), peak tp and end td, tier E
 * (engineering approximation, no peer-reviewed validation of the shape).
 * Meals: gamma(2) absorption, two equal first-order compartments (Hovorka), tier L/E.
 */

export interface InsulinConstants {
  tau: number;
  b: number;
  s: number;
}

/** Throws RangeError for inputs outside the validity range: invalid input is rejected, not clipped. */
export function insulinConstants(tpMin: number, tdMin: number): InsulinConstants {
  if (!(tpMin > 0) || !(tdMin > 0) || !(tpMin < tdMin / 2)) {
    throw new RangeError(`insulin kernel requires 0 < tp < td/2 (got tp=${tpMin}, td=${tdMin})`);
  }
  const tau = (tpMin * (1 - tpMin / tdMin)) / (1 - (2 * tpMin) / tdMin);
  const b = (2 * tau) / tdMin;
  const s = 1 / (1 - b + (1 + b) * Math.exp(-tdMin / tau));
  return { tau, b, s };
}

/** Cumulative insulin action A(s): fraction of a dose that has acted s minutes after delivery. */
export function insulinCumulativeAction(sMin: number, tpMin: number, tdMin: number): number {
  if (sMin <= 0) return 0;
  if (sMin >= tdMin) return 1;
  const { tau, b, s } = insulinConstants(tpMin, tdMin);
  return (
    s *
    (1 - b) *
    (((sMin * sMin) / (tau * tdMin * (1 - b)) - sMin / tau - 1) * Math.exp(-sMin / tau) + 1)
  );
}

/** Insulin activity a(s) in 1/min (derivative of A). */
export function insulinActivity(sMin: number, tpMin: number, tdMin: number): number {
  if (sMin <= 0 || sMin >= tdMin) return 0;
  const { tau, s } = insulinConstants(tpMin, tdMin);
  return (s / (tau * tau)) * sMin * (1 - sMin / tdMin) * Math.exp(-sMin / tau);
}

/** Fraction of a dose still to act: IOB(s) / U = 1 - A(s). */
export function insulinRemainingFraction(sMin: number, tpMin: number, tdMin: number): number {
  return 1 - insulinCumulativeAction(sMin, tpMin, tdMin);
}

/** Cumulative meal absorption F(s) for gamma(2) with time constant tauM (minutes). */
export function mealCumulativeAbsorption(sMin: number, tauMMin: number): number {
  if (sMin <= 0) return 0;
  return 1 - (1 + sMin / tauMMin) * Math.exp(-sMin / tauMMin);
}
