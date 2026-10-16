import { describe, expect, it } from 'vitest';
import {
  MAX_LOG_STEP,
  governedStep,
  maeBaseline,
  ridgeScales,
  stepScale,
  validateCandidate,
  type FitExample,
} from './fit.js';

/** Deterministic pseudo-noise so the tests are reproducible. */
function lcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296 - 0.5;
  };
}

function synth(n: number, trueC: number, trueI: number, noise = 6, seed = 7): FitExample[] {
  const r = lcg(seed);
  return Array.from({ length: n }, () => {
    const c = 40 + 120 * (r() + 0.5);
    const i = 30 + 100 * (r() + 0.5);
    const base = 140 + 40 * r();
    return { base, c, i, obs: base + trueC * c - trueI * i + noise * r() * 2 };
  });
}

describe('bounded, shrunk, rate-limited scale fitting', () => {
  it('with no data the prior stands (scales 1, information 0)', () => {
    expect(ridgeScales([])).toMatchObject({ mCsf: 1, mIsf: 1, infoCsf: 0, infoIsf: 0 });
    const s = governedStep([], { mCsf: 1, mIsf: 1 });
    expect(s).toMatchObject({ mCsf: 1, mIsf: 1, movedCsf: false, movedIsf: false });
  });

  it('shrinks toward 1: the fit moves toward the truth but never all the way with little data', () => {
    const few = ridgeScales(synth(15, 0.8, 1.2));
    const many = ridgeScales(synth(600, 0.8, 1.2));
    expect(few.mCsf).toBeLessThan(1);
    expect(few.mCsf).toBeGreaterThan(0.8);
    expect(many.mCsf).toBeLessThan(few.mCsf);
    expect(many.mCsf).toBeCloseTo(0.8, 1);
    expect(many.mIsf).toBeCloseTo(1.2, 1);
    // information ratio is n / (n + 30)
    expect(few.infoCsf).toBeCloseTo(15 / 45, 6);
  });

  it('information gate: fewer than ~13 examples cannot move a scale at all', () => {
    const s = governedStep(synth(8, 0.7, 1.4), { mCsf: 1, mIsf: 1 });
    expect(s.movedCsf).toBe(false);
    expect(s.movedIsf).toBe(false);
    expect(s.mCsf).toBe(1);
  });

  it('rate limit: one update never moves a scale by more than 0.1/7 in log space, even with a large error', () => {
    const s = governedStep(synth(400, 0.6, 1.6), { mCsf: 1, mIsf: 1 });
    expect(Math.abs(Math.log(s.mCsf))).toBeLessThanOrEqual(MAX_LOG_STEP + 1e-12);
    expect(Math.abs(Math.log(s.mIsf))).toBeLessThanOrEqual(MAX_LOG_STEP + 1e-12);
    expect(s.mCsf).toBeLessThan(1); // right direction
    expect(s.mIsf).toBeGreaterThan(1);
  });

  it('hard bounds hold: a scale at the limit does not leave [0.6, 1.6]', () => {
    expect(stepScale(1.6, 3, { min: 0.6, max: 1.6 })).toBe(1.6);
    expect(stepScale(0.6, 0.1, { min: 0.6, max: 1.6 })).toBe(0.6);
  });

  it('one wild example does not make a large update', () => {
    const data = synth(40, 1, 1);
    const outlier = [...data, { base: 120, c: 150, i: 5, obs: 600 }];
    const s = governedStep(outlier, { mCsf: 1, mIsf: 1 });
    expect(Math.abs(Math.log(s.mCsf))).toBeLessThanOrEqual(MAX_LOG_STEP + 1e-12);
  });

  it('time-ordered validation promotes a candidate only if it beats the baseline AND the incumbent on later data', () => {
    const informative = synth(200, 0.7, 1.0, 4);
    const ok = validateCandidate(informative, { mCsf: 1.0, mIsf: 1.0 });
    expect(ok.testN).toBe(60);
    expect(ok.maeCandidate).toBeLessThan(ok.maeBaseline);
    expect(ok.promote).toBe(true);
  });

  it('does not promote when the layer does not help: baseline already explains the data', () => {
    // the baseline is exact and the events carry no signal (c = i = 0 contribution): any move is noise
    const r = lcg(3);
    const flat: FitExample[] = Array.from({ length: 120 }, () => ({ base: 140, obs: 140 + 3 * r(), c: 80, i: 80 }));
    const d = validateCandidate(flat, { mCsf: 1, mIsf: 1 });
    expect(maeBaseline(flat)).toBeLessThan(3);
    expect(d.promote).toBe(false);
  });

  it('refuses to validate without enough later examples', () => {
    const d = validateCandidate(synth(10, 0.7, 1), { mCsf: 1, mIsf: 1 });
    expect(d.promote).toBe(false);
    expect(d.reason).toMatch(/not enough/);
  });
});
