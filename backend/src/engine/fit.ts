import { PARAM_BOUNDS } from './params.js';

/**
 * Bounded, shrunk, rate-limited estimation of the two personal scales (spec section 8). Pure maths,
 * no I/O. The model being fitted is the layer's own correction of the glucose-only baseline:
 *
 *   observed - baseline  =  m_csf * C  -  m_isf * I  +  noise
 *
 * where C and I are the UNSCALED meal and insulin effects the layer computed for that prediction
 * (stored with it). Writing m = 1 + b, the prior is b = 0 (the clinic settings stand) and the fit is a
 * ridge regression with strength lambda_f = k * mean(x_f^2), which equals the usual shrinkage
 * n / (n + k) toward the prior (CLAUDE.md section 7, k ~ 30). A scale with too little information
 * (n / (n + k) below the spec's 0.3 gate) is left alone.
 */

export interface FitExample {
  base: number; // glucose-only prediction (mg/dL)
  obs: number; // observed CGM value at the target time (mg/dL)
  c: number; // unscaled meal effect increment (mg/dL, >= 0)
  i: number; // unscaled insulin effect increment (mg/dL, >= 0)
}

export const SHRINKAGE_K = 30;
export const INFO_GATE = 0.3;
/** Spec section 8: no log-parameter moves more than 0.1 per week; one update per day -> 0.1 / 7. */
export const MAX_LOG_STEP = 0.1 / 7;

export interface ScaleFit {
  /** Fitted absolute scales (1 + b), unbounded; apply stepScale() before use. */
  mCsf: number;
  mIsf: number;
  /** Information ratio per scale: 1 = data dominates the prior, 0 = prior only. */
  infoCsf: number;
  infoIsf: number;
  n: number;
}

export function ridgeScales(examples: readonly FitExample[], k: number = SHRINKAGE_K): ScaleFit {
  const n = examples.length;
  if (n === 0) return { mCsf: 1, mIsf: 1, infoCsf: 0, infoIsf: 0, n };
  // features x1 = c, x2 = -i ; target r = obs - base - (c - i)
  let s11 = 0;
  let s22 = 0;
  let s12 = 0;
  let t1 = 0;
  let t2 = 0;
  for (const e of examples) {
    const x1 = e.c;
    const x2 = -e.i;
    const r = e.obs - e.base - (e.c - e.i);
    s11 += x1 * x1;
    s22 += x2 * x2;
    s12 += x1 * x2;
    t1 += x1 * r;
    t2 += x2 * r;
  }
  const l1 = (k * s11) / n;
  const l2 = (k * s22) / n;
  const a = s11 + l1;
  const d = s22 + l2;
  const det = a * d - s12 * s12;
  let b1 = 0;
  let b2 = 0;
  if (s11 > 0 && s22 > 0 && det > 1e-12) {
    b1 = (d * t1 - s12 * t2) / det;
    b2 = (a * t2 - s12 * t1) / det;
  } else if (s11 > 0) {
    b1 = t1 / a;
  } else if (s22 > 0) {
    b2 = t2 / d;
  }
  return {
    mCsf: 1 + b1,
    mIsf: 1 + b2,
    infoCsf: s11 > 0 ? s11 / (s11 + l1) : 0,
    infoIsf: s22 > 0 ? s22 / (s22 + l2) : 0,
    n,
  };
}

/** Moves `current` toward `target` by at most MAX_LOG_STEP in log space, inside the hard bounds. */
export function stepScale(current: number, target: number, bounds: { min: number; max: number }): number {
  if (!(target > 0) || !(current > 0)) return current;
  const delta = Math.log(target) - Math.log(current);
  const capped = Math.max(-MAX_LOG_STEP, Math.min(MAX_LOG_STEP, delta));
  return Math.min(bounds.max, Math.max(bounds.min, current * Math.exp(capped)));
}

export interface ScaleStep {
  mCsf: number;
  mIsf: number;
  /** false for a scale whose information ratio is below the gate (it stays where it is). */
  movedCsf: boolean;
  movedIsf: boolean;
}

/** One governed update: ridge fit -> information gate -> rate limit -> bounds. */
export function governedStep(
  examples: readonly FitExample[],
  current: { mCsf: number; mIsf: number },
): ScaleStep {
  const fit = ridgeScales(examples);
  const gateC = fit.infoCsf >= INFO_GATE;
  const gateI = fit.infoIsf >= INFO_GATE;
  return {
    mCsf: gateC ? stepScale(current.mCsf, fit.mCsf, PARAM_BOUNDS.mCsf) : current.mCsf,
    mIsf: gateI ? stepScale(current.mIsf, fit.mIsf, PARAM_BOUNDS.mIsf) : current.mIsf,
    movedCsf: gateC,
    movedIsf: gateI,
  };
}

export const mean = (xs: readonly number[]): number => (xs.length === 0 ? Number.NaN : xs.reduce((a, b) => a + b, 0) / xs.length);

/** Mean absolute error of baseline + m_csf*C - m_isf*I against the observed values. */
export function maeWithScales(examples: readonly FitExample[], s: { mCsf: number; mIsf: number }): number {
  return mean(examples.map((e) => Math.abs(e.obs - (e.base + s.mCsf * e.c - s.mIsf * e.i))));
}

export function maeBaseline(examples: readonly FitExample[]): number {
  return mean(examples.map((e) => Math.abs(e.obs - e.base)));
}

export interface PromotionDecision {
  promote: boolean;
  reason: string;
  testN: number;
  maeBaseline: number;
  maeCurrent: number;
  maeCandidate: number;
}

/**
 * Time-ordered validation of a candidate against the incumbent AND the original glucose-only baseline.
 * `examples` must be sorted oldest to newest. The candidate is fitted on the earlier 70% only and scored
 * on the later 30%; it is promoted only if it beats both on those later examples.
 */
export function validateCandidate(
  examples: readonly FitExample[],
  current: { mCsf: number; mIsf: number },
  minTest = 5,
): PromotionDecision {
  const cut = Math.floor(examples.length * 0.7);
  const train = examples.slice(0, cut);
  const test = examples.slice(cut);
  const nan = Number.NaN;
  if (test.length < minTest || train.length === 0) {
    return { promote: false, reason: 'not enough later examples to validate', testN: test.length, maeBaseline: nan, maeCurrent: nan, maeCandidate: nan };
  }
  const cand = governedStep(train, current);
  const maeBase = maeBaseline(test);
  const maeCur = maeWithScales(test, current);
  const maeCand = maeWithScales(test, cand);
  const promote = maeCand < maeCur && maeCand < maeBase;
  return {
    promote,
    reason: promote
      ? 'candidate beat the incumbent and the glucose-only baseline on later data'
      : maeCand >= maeBase
        ? 'candidate did not beat the glucose-only baseline on later data'
        : 'candidate did not beat the incumbent on later data',
    testN: test.length,
    maeBaseline: maeBase,
    maeCurrent: maeCur,
    maeCandidate: maeCand,
  };
}
