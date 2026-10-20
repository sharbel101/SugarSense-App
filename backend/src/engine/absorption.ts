import { mealCumulativeAbsorption } from './kernels.js';
import { TIME_CLASS_RATIO } from './params.js';
import type { AbsorptionClass, AbsorptionFeatures, AbsorptionProfile } from './types.js';

/**
 * Meal-aware carbohydrate absorption profile ("absorption-v3").
 *
 * Design source: SugarSense-Technical-Reference.pdf section 6.3.1 (rate of appearance Ra(t; D, t_max) and the two-component mixture
 * for high-fat / high-protein meals) and section 5.6 (fat and protein delay gastric emptying and add a late, prolonged rise).
 * Conventions, checked against the running code (see docs/ABSORPTION-MODEL.md):
 *  - Time is minutes after eating; the kernel is the engine's gamma(2) cumulative F(s; tau) = 1 - (1 + s/tau) exp(-s/tau), whose
 *    rate peaks at tau: this IS the reference's Ra with t_max = tau, normalised to integrate to 1.
 *  - The reference's bioavailability A_G (0.8) is not a separate factor in this engine: the carbohydrate effect is CSF * C * F with
 *    CSF = ISF / ICR, and ICR enters nowhere else (project forecasting spec, double-counting rule 1). Total carbohydrate mass is
 *    therefore conserved by construction: F_total(inf) = 1 for every profile.
 *  - The mixture MOVES mass in time, it never adds any: F_total(s) = (1 - phi) F(s; tau_fast) + phi F(s - delta; tau_slow), with the
 *    delayed component exactly zero for s <= delta (the reference's "Ra(t - delta)" boundary).
 *
 * Why this is the smallest defensible extension: the reference already specifies the shape; only the inputs that choose
 * (tau_fast, phi, delta) are new, and each is a fixed, bounded population default (tier E, engineering assumption), NOT a fitted
 * per-user parameter. GI is never a multiplier of carbohydrate grams or of predicted glucose (project forecasting spec section 4:
 * the effect would be counted once as an amount, once as timing and once through fat); it only helps choose the class when no
 * class is available.
 */

export const ABSORPTION_VERSION = 'absorption-v3';

export const ABSORPTION_PARAMS = {
  /** tau_fast as a multiple of the base gut time constant tauM (40 min): fast 25 min (reference: 20-30), moderate-fast 32.5, mixed 40 (reference: 40-50, engine default). */
  tauRatio: { fast: 0.625, moderate_fast: 0.8125, moderate_mixed: 1, slow_delayed: 1 } satisfies Record<AbsorptionClass, number>,
  /** Delayed component time constant (min). Reference: t_slow 60-90 for high-fat/protein meals; the project spec's delayed kernel also uses 90. */
  tauSlowMin: 90,
  /** phi = clamp(A_F * max(0, fat - F0) + A_P * max(0, protein - P0), 0, PHI_MAX). Hinge (continuous), not a switch. Tier E. */
  fatOnsetG: 15,
  proteinOnsetG: 20,
  phiPerFatG: 0.01,
  phiPerProteinG: 0.008,
  /** Reference cap on the delayed fraction. */
  phiMax: 0.6,
  /** delta = clamp(BETA * fat, DELTA_MIN, DELTA_MAX) minutes (reference: delta = beta * fat, capped at 90). beta in min per g of fat. */
  deltaPerFatMin: 1,
  deltaMinWhenDelayedMin: 30,
  deltaMaxMin: 90,
  /** A class of "slow_delayed" implies at least this delayed fraction / delay even when fat and protein are not reported. Scaled by confidence. */
  slowClassPhiFloor: 0.3,
  slowClassDeltaFloorMin: 45,
  /**
   * Fibre slows carbohydrate appearance: tau_fast * (1 + 0.05 per g, at most 15 g, so at most +75%). v2 used 0.01 per g.
   * Evidence (docs/absorption-checks, CGMacros PhysioNet, 872 isolated meals, 37 people, not type 1 diabetes): letting fibre slow the
   * appearance cut the held-out-people error of the post-meal curve monotonically (47.3 mg/dL with none, 46.5 at 0.01/g, 44.1 at 0.05/g,
   * 41.9 at 0.10/g, 39.6 fully free); within-person, 10 g more fibre meant a peak about 5 min later and about 12 mg/dL lower. Fibre also stands in
   * for the kind of food (legumes, whole grains), so 0.05 is a deliberately conservative middle, not the best-fitting value. Tier E.
   */
  fiberSlowingPerG: 0.05,
  fiberCapG: 15,
  /** Fat/protein stretch the early component too (published time to peak moves later, not only a tail appears): tau_fast * (1 + min(max, S_F*max(0,fat-F0) + S_P*max(0,protein-P0))). 0 = off. */
  stretchPerFatG: 0,
  stretchPerProteinG: 0,
  stretchMax: 1,
  /** Extra late glucose appearance, grams of carbohydrate equivalent: min(max, E_F*max(0,fat-F0) + E_P*max(0,protein-P0)). 0 = off. */
  equivalentPerFatG: 0,
  equivalentPerProteinG: 0,
  equivalentMaxG: 40,
  /** GI (medium confidence; the feature schema only allows medium or low) at or above this nudges an otherwise unclassified meal to "moderate_fast". Never used otherwise. */
  giFastThreshold: 70,
  tauFastBoundsMin: { min: 12, max: 120 },
  /** Share of the shift away from the default profile that is treated as uncertain, by evidence quality. */
  uncertaintyWeight: { classHigh: 0.15, classMedium: 0.3, classLow: 0.5, gi: 0.5, macros: 0.3 },
} as const;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const known = (v: number | null | undefined): number | null => (v !== null && v !== undefined && Number.isFinite(v) && v >= 0 ? v : null);

export function defaultProfile(tauMMin: number): AbsorptionProfile {
  return { version: ABSORPTION_VERSION, tauFastMin: tauMMin, phi: 0, delayMin: 0, tauSlowMin: ABSORPTION_PARAMS.tauSlowMin, source: 'default', uncertaintyWeight: 0 };
}

/**
 * Chooses the absorption profile for one meal from what is known. Pure and deterministic. Missing or invalid values fall back to the
 * existing behaviour (the default profile = single gamma(2) component with tau = tauM), never to a guess.
 *  1. A speed class the PERSON chose is authoritative and keeps the previous single-component behaviour (no extra delayed part:
 *     that would count the same slowness twice).
 *  2. Otherwise the class comes from the vision model (with its confidence), else from a GI estimate that is at least "medium"
 *     confidence and high, else "moderate_mixed" (no evidence).
 *  3. Fat and protein then add a delayed fraction continuously (hinge), fibre slows the early component slightly.
 */
export function resolveAbsorptionProfile(f: AbsorptionFeatures, tauMMin: number): AbsorptionProfile {
  const W = ABSORPTION_PARAMS.uncertaintyWeight;
  if (f.legacyClassIsUserSet) {
    const tau = clamp(tauMMin * TIME_CLASS_RATIO[f.legacyClass], ABSORPTION_PARAMS.tauFastBoundsMin.min, ABSORPTION_PARAMS.tauFastBoundsMin.max);
    return { version: ABSORPTION_VERSION, tauFastMin: tau, phi: 0, delayMin: 0, tauSlowMin: ABSORPTION_PARAMS.tauSlowMin, source: 'user_class', uncertaintyWeight: 0 };
  }

  let cls: AbsorptionClass = 'moderate_mixed';
  let classWeight = 0;
  let confFactor = 1;
  const sources: string[] = [];
  if (f.aiClass) {
    cls = f.aiClass;
    sources.push('class');
    const c = f.aiConfidence ?? 'low';
    classWeight = c === 'high' ? W.classHigh : c === 'medium' ? W.classMedium : W.classLow;
    confFactor = c === 'low' ? 0.5 : 1;
  } else if (known(f.giEstimate) !== null && f.giConfidence === 'medium' && (f.giEstimate as number) >= ABSORPTION_PARAMS.giFastThreshold) {
    cls = 'moderate_fast';
    sources.push('gi');
    classWeight = W.gi;
  }

  const fat = known(f.fatG);
  const protein = known(f.proteinG);
  const fiber = known(f.fiberG);
  const P = ABSORPTION_PARAMS;

  const fiberFactor = 1 + P.fiberSlowingPerG * Math.min(fiber ?? 0, P.fiberCapG);
  const stretch = clamp(P.stretchPerFatG * Math.max(0, (fat ?? 0) - P.fatOnsetG) + P.stretchPerProteinG * Math.max(0, (protein ?? 0) - P.proteinOnsetG), 0, P.stretchMax);
  const tauFast = clamp(tauMMin * P.tauRatio[cls] * fiberFactor * (1 + stretch), P.tauFastBoundsMin.min, P.tauFastBoundsMin.max);
  const extra = clamp(P.equivalentPerFatG * Math.max(0, (fat ?? 0) - P.fatOnsetG) + P.equivalentPerProteinG * Math.max(0, (protein ?? 0) - P.proteinOnsetG), 0, P.equivalentMaxG);

  const phiMacro = clamp(P.phiPerFatG * Math.max(0, (fat ?? 0) - P.fatOnsetG) + P.phiPerProteinG * Math.max(0, (protein ?? 0) - P.proteinOnsetG), 0, P.phiMax);
  const phiClass = cls === 'slow_delayed' ? P.slowClassPhiFloor * confFactor : 0;
  const phi = clamp(Math.max(phiMacro, phiClass), 0, P.phiMax);
  const delay =
    phi > 0
      ? clamp(Math.max(P.deltaPerFatMin * (fat ?? 0), cls === 'slow_delayed' ? P.slowClassDeltaFloorMin * confFactor : 0, P.deltaMinWhenDelayedMin), P.deltaMinWhenDelayedMin, P.deltaMaxMin)
      : 0;
  if (phiMacro > 0 || stretch > 0 || extra > 0) sources.push('macros');
  if (fiber !== null && fiber > 0 && sources.length > 0) sources.push('fibre');

  const shifted = Math.abs(tauFast - tauMMin) > 0.5 || phi > 0 || extra > 0;
  const weight = shifted ? Math.max(classWeight, phiMacro > 0 || stretch > 0 || extra > 0 ? W.macros : 0, fiber ? 0.15 : 0) : 0;
  // Extra appearance needs a delay to follow; with no delayed fraction the delayed kernel still starts after the minimum delay.
  const delayOut = extra > 0 && delay === 0 ? clamp(P.deltaPerFatMin * (fat ?? 0), P.deltaMinWhenDelayedMin, P.deltaMaxMin) : delay;
  return {
    version: ABSORPTION_VERSION,
    tauFastMin: tauFast,
    phi,
    delayMin: delayOut,
    tauSlowMin: P.tauSlowMin,
    source: sources.length === 0 ? 'default' : sources.join('+'),
    uncertaintyWeight: weight,
    ...(extra > 0 ? { extraEquivalentG: extra } : {}),
  };
}

/** Cumulative absorbed fraction F_total(s): 0 at s <= 0, rises to 1, never decreases, the delayed part is exactly 0 for s <= delay. */
export function profileCumulative(sMin: number, p: AbsorptionProfile): number {
  if (!(sMin > 0)) return 0;
  const early = mealCumulativeAbsorption(sMin, p.tauFastMin);
  if (p.phi <= 0) return early;
  const late = sMin <= p.delayMin ? 0 : mealCumulativeAbsorption(sMin - p.delayMin, p.tauSlowMin);
  return (1 - p.phi) * early + p.phi * late;
}

/** Rate of appearance per gram of absorbed carbohydrate, 1/min (the reference's Ra / (D * A_G)). Integrates to 1. */
export function profileRate(tMin: number, p: AbsorptionProfile): number {
  if (!(tMin > 0)) return 0;
  const gamma = (t: number, tau: number): number => (t > 0 ? (t / (tau * tau)) * Math.exp(-t / tau) : 0);
  return (1 - p.phi) * gamma(tMin, p.tauFastMin) + p.phi * gamma(tMin - p.delayMin, p.tauSlowMin);
}

/** Throws RangeError for a profile outside the documented bounds (used by tests and as a guard for stored/replayed profiles). */
export function assertValidProfile(p: AbsorptionProfile): void {
  const P = ABSORPTION_PARAMS;
  const ok =
    Number.isFinite(p.tauFastMin) && p.tauFastMin >= P.tauFastBoundsMin.min && p.tauFastMin <= P.tauFastBoundsMin.max &&
    Number.isFinite(p.phi) && p.phi >= 0 && p.phi <= P.phiMax &&
    Number.isFinite(p.delayMin) && p.delayMin >= 0 && p.delayMin <= P.deltaMaxMin &&
    Number.isFinite(p.tauSlowMin) && p.tauSlowMin > 0 && (p.phi === 0 || p.delayMin >= P.deltaMinWhenDelayedMin) &&
    p.uncertaintyWeight >= 0 && p.uncertaintyWeight <= 1 &&
    (p.extraEquivalentG === undefined || (Number.isFinite(p.extraEquivalentG) && p.extraEquivalentG >= 0 && p.extraEquivalentG <= P.equivalentMaxG));
  if (!ok) throw new RangeError('absorption profile outside its documented bounds: ' + JSON.stringify(p));
}
