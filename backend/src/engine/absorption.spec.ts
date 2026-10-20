import { describe, expect, it } from 'vitest';
import { ABSORPTION_PARAMS, assertValidProfile, defaultProfile, profileCumulative, profileRate, resolveAbsorptionProfile } from './absorption.js';
import { insulinActivity, insulinCumulativeAction, insulinRemainingFraction, mealCumulativeAbsorption } from './kernels.js';
import { DEFAULT_ENGINE_PARAMS, STEP_MIN } from './params.js';
import { computeRun, type RunInputs } from './run.js';
import type { AbsorptionFeatures, AbsorptionProfile, MealInput } from './types.js';

const TAU_M = DEFAULT_ENGINE_PARAMS.tauMMin; // 40
const features = (over: Partial<AbsorptionFeatures> = {}): AbsorptionFeatures => ({
  legacyClass: 'medium',
  legacyClassIsUserSet: false,
  aiClass: null,
  aiConfidence: null,
  giEstimate: null,
  giConfidence: null,
  fatG: null,
  proteinG: null,
  fiberG: null,
  ...over,
});
const resolve = (over: Partial<AbsorptionFeatures> = {}): AbsorptionProfile => resolveAbsorptionProfile(features(over), TAU_M);

/** Trapezoid integral of the rate over [0, tEnd] minutes with step dt. */
function integrateRate(p: AbsorptionProfile, tEnd: number, dt = 0.05): number {
  let sum = 0;
  let prev = profileRate(0, p);
  for (let t = dt; t <= tEnd + 1e-9; t += dt) {
    const cur = profileRate(t, p);
    sum += ((prev + cur) / 2) * dt;
    prev = cur;
  }
  return sum;
}

const PROFILES: Record<string, AbsorptionProfile> = {
  default: defaultProfile(TAU_M),
  sugary: resolve({ aiClass: 'fast', aiConfidence: 'high', fatG: 0, proteinG: 0 }),
  mixed: resolve({ aiClass: 'moderate_mixed', aiConfidence: 'medium', fatG: 12, proteinG: 15 }),
  highFat: resolve({ aiClass: 'slow_delayed', aiConfidence: 'medium', fatG: 50, proteinG: 40 }),
  macrosOnly: resolve({ fatG: 35, proteinG: 30 }),
  capped: resolve({ aiClass: 'slow_delayed', aiConfidence: 'high', fatG: 200, proteinG: 200, fiberG: 100 }),
};

describe('absorption kernel - physics', () => {
  it.each(Object.entries(PROFILES))('%s: finite, non-negative, normalised (mass conserved) and monotone', (_name, p) => {
    assertValidProfile(p);
    let last = 0;
    for (let s = 0; s <= 1500; s += 5) {
      const f = profileCumulative(s, p);
      const r = profileRate(s, p);
      expect(Number.isFinite(f) && Number.isFinite(r)).toBe(true);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(f).toBeGreaterThanOrEqual(last - 1e-12);
      expect(f).toBeLessThanOrEqual(1 + 1e-12);
      last = f;
    }
    expect(profileCumulative(4000, p)).toBeCloseTo(1, 9);
    expect(integrateRate(p, 3000)).toBeCloseTo(1, 3); // the reference's "integral of Ra = D x A_G", normalised to one
    // the rate is the derivative of the cumulative curve
    for (const s of [20, 60, 140]) expect(integrateRate(p, s)).toBeCloseTo(profileCumulative(s, p), 3);
  });

  it('the default profile is exactly the existing single gamma(2) kernel (golden numbers unchanged)', () => {
    for (const s of [-5, 0, 10, 30, 60, 120, 240]) expect(profileCumulative(s, PROFILES.default as AbsorptionProfile)).toBe(mealCumulativeAbsorption(s, TAU_M));
    expect(profileCumulative(30, PROFILES.default as AbsorptionProfile)).toBeCloseTo(0.173, 3);
    expect(profileCumulative(60, PROFILES.default as AbsorptionProfile)).toBeCloseTo(0.442, 3);
  });

  it('the delayed component contributes nothing before its delay', () => {
    const p: AbsorptionProfile = { ...defaultProfile(TAU_M), phi: 0.5, delayMin: 60, tauSlowMin: 90, source: 'test' };
    const early = { ...p, phi: 0 };
    for (const s of [1, 20, 59, 60]) {
      expect(profileCumulative(s, p)).toBeCloseTo(0.5 * mealCumulativeAbsorption(s, TAU_M), 12); // only the early half has acted
      expect(profileRate(s, p)).toBeCloseTo(0.5 * profileRate(s, early), 12);
    }
    expect(profileCumulative(61, p)).toBeGreaterThan(0.5 * mealCumulativeAbsorption(61, TAU_M));
  });

  it('a larger delayed fraction or a longer delay moves absorption later without creating carbohydrate mass', () => {
    const base = { ...defaultProfile(TAU_M), delayMin: 45, tauSlowMin: 90, source: 'test' };
    let prevMean = -Infinity;
    for (const phi of [0, 0.2, 0.4, 0.6]) {
      const p = { ...base, phi };
      expect(profileCumulative(5000, p)).toBeCloseTo(1, 9); // same total
      // mean absorption time = integral of (1 - F): grows with phi
      let mean = 0;
      for (let s = 0; s < 4000; s += 1) mean += 1 - profileCumulative(s + 0.5, p);
      expect(mean).toBeGreaterThan(prevMean);
      prevMean = mean;
      if (phi > 0) expect(profileCumulative(60, p)).toBeLessThan(profileCumulative(60, { ...base, phi: 0 }));
    }
    let prevAt150 = Infinity;
    for (const delayMin of [30, 60, 90]) {
      const p = { ...base, phi: 0.4, delayMin };
      expect(profileCumulative(5000, p)).toBeCloseTo(1, 9);
      const at150 = profileCumulative(150, p);
      expect(at150).toBeLessThan(prevAt150); // a longer delay leaves less absorbed at the same time
      prevAt150 = at150;
    }
  });

  it('is deterministic: equal inputs give identical profiles and curves', () => {
    const a = resolve({ aiClass: 'slow_delayed', aiConfidence: 'medium', fatG: 40, proteinG: 33, fiberG: 6, giEstimate: 55, giConfidence: 'low' });
    const b = resolve({ aiClass: 'slow_delayed', aiConfidence: 'medium', fatG: 40, proteinG: 33, fiberG: 6, giEstimate: 55, giConfidence: 'low' });
    expect(a).toEqual(b);
    expect(profileCumulative(137, a)).toBe(profileCumulative(137, b));
  });

  it('insulin action and insulin on board are unchanged by the absorption work (spec golden vectors)', () => {
    const iob = [60, 120, 180, 240].map((s) => insulinRemainingFraction(s, 75, 300));
    expect(iob.map((v) => Math.round(v * 1000) / 1000)).toEqual([0.764, 0.411, 0.159, 0.033]);
    let area = 0;
    for (let s = 0; s < 300; s += 0.1) area += insulinActivity(s + 0.05, 75, 300) * 0.1;
    expect(area).toBeCloseTo(1, 4);
    expect(insulinCumulativeAction(300, 75, 300)).toBe(1);
  });
});

describe('absorption profile - how the evidence chooses it', () => {
  it('no evidence at all (or only unusable values) is exactly the default profile, never a guess', () => {
    for (const over of [
      {},
      { fatG: null, proteinG: null, fiberG: null },
      { fatG: Number.NaN, proteinG: -5, fiberG: Number.POSITIVE_INFINITY },
      { giEstimate: 85, giConfidence: 'low' as const }, // low-confidence GI is not evidence
      { giEstimate: 30, giConfidence: 'medium' as const }, // low GI does not mean slow
      { aiClass: 'moderate_mixed' as const, aiConfidence: 'high' as const, fatG: 10, proteinG: 12 },
    ]) {
      const p = resolve(over);
      expect(p).toMatchObject({ tauFastMin: TAU_M, phi: 0, delayMin: 0, uncertaintyWeight: 0 });
    }
  });

  it('a speed class chosen by the PERSON is authoritative and keeps the previous single-component behaviour', () => {
    const fast = resolve({ legacyClass: 'fast', legacyClassIsUserSet: true, aiClass: 'slow_delayed', aiConfidence: 'high', fatG: 80, proteinG: 60 });
    expect(fast).toMatchObject({ source: 'user_class', tauFastMin: 20, phi: 0, delayMin: 0, uncertaintyWeight: 0 });
    expect(resolve({ legacyClass: 'slow', legacyClassIsUserSet: true })).toMatchObject({ tauFastMin: 60, phi: 0 });
    expect(resolve({ legacyClass: 'fast', legacyClassIsUserSet: false })).toMatchObject({ tauFastMin: TAU_M }); // a default is not a choice
  });

  it('class sets the early time constant: fast < moderate-fast < mixed', () => {
    const t = (c: 'fast' | 'moderate_fast' | 'moderate_mixed') => resolve({ aiClass: c, aiConfidence: 'high' }).tauFastMin;
    expect(t('fast')).toBeCloseTo(25, 9);
    expect(t('moderate_fast')).toBeCloseTo(32.5, 9);
    expect(t('moderate_mixed')).toBeCloseTo(40, 9);
    expect(t('fast')).toBeLessThan(t('moderate_fast'));
    expect(t('moderate_fast')).toBeLessThan(t('moderate_mixed'));
  });

  it('GI is weak evidence only: it can nudge an unclassified meal to moderate-fast, never overrides a class, never slows a meal', () => {
    expect(resolve({ giEstimate: 80, giConfidence: 'medium' })).toMatchObject({ source: 'gi', tauFastMin: 32.5, phi: 0 });
    expect(resolve({ giEstimate: 80, giConfidence: 'medium', aiClass: 'moderate_mixed', aiConfidence: 'medium' }).tauFastMin).toBe(TAU_M);
    expect(resolve({ giEstimate: 20, giConfidence: 'medium' }).tauFastMin).toBe(TAU_M);
  });

  it('fat and protein add a delayed fraction continuously (a hinge, no jump), capped at 0.6, delay at most 90 min', () => {
    const phi = (fat: number, protein: number) => resolve({ fatG: fat, proteinG: protein }).phi;
    const { fatOnsetG, proteinOnsetG } = ABSORPTION_PARAMS;
    expect(phi(fatOnsetG, proteinOnsetG)).toBe(0);
    let last = phi(0, 30);
    for (let fat = 0; fat <= 120; fat += 0.5) {
      const v = phi(fat, 30);
      expect(v).toBeGreaterThanOrEqual(last);
      expect(v - last).toBeLessThan(0.02); // small steps: continuous
      expect(v).toBeLessThanOrEqual(0.6);
      last = v;
    }
    expect(phi(200, 200)).toBe(0.6);
    const p = resolve({ fatG: 200, proteinG: 200 });
    expect(p.delayMin).toBeLessThanOrEqual(90);
    expect(p.delayMin).toBeGreaterThanOrEqual(30);
    expect(resolve({ fatG: 0, proteinG: 0 }).delayMin).toBe(0);
  });

  it('slow_delayed implies a delayed part even when fat and protein were not reported; low confidence halves it; a typical mixed meal is not shifted much', () => {
    const none = resolve({ aiClass: 'slow_delayed', aiConfidence: 'high' });
    expect(none.phi).toBeCloseTo(0.3, 9);
    expect(none.delayMin).toBeGreaterThanOrEqual(45);
    expect(resolve({ aiClass: 'slow_delayed', aiConfidence: 'low' }).phi).toBeCloseTo(0.15, 9);
    expect(resolve({ fatG: 20, proteinG: 25 }).phi).toBeLessThan(0.1);
  });

  it('fibre slows the early component (0.05 per gram, capped at 15 g = +75%)', () => {
    expect(resolve({ fiberG: 0 }).tauFastMin).toBe(TAU_M);
    expect(resolve({ fiberG: 10 }).tauFastMin).toBeCloseTo(TAU_M * 1.5, 9);
    expect(resolve({ fiberG: 15 }).tauFastMin).toBeCloseTo(TAU_M * 1.75, 9);
    expect(resolve({ fiberG: 500 }).tauFastMin).toBeCloseTo(TAU_M * 1.75, 9);
    expect(resolve({ fiberG: 500 }).tauFastMin).toBeLessThanOrEqual(ABSORPTION_PARAMS.tauFastBoundsMin.max);
    // slower appearance moves carbohydrate later without adding any: the total is unchanged
    expect(profileCumulative(6000, resolve({ fiberG: 15 }))).toBeCloseTo(1, 9);
  });

  it('the fat/protein "stretch" and "extra equivalent" terms are OFF by default: profiles carry no extra amount and match their previous values', () => {
    const p = resolve({ fatG: 60, proteinG: 40 });
    expect(p.extraEquivalentG).toBeUndefined();
    expect(p.tauFastMin).toBe(TAU_M);
    expect(ABSORPTION_PARAMS.stretchPerFatG).toBe(0);
    expect(ABSORPTION_PARAMS.equivalentPerFatG).toBe(0);
  });

  it('when enabled, the extra equivalent ADDS late glucose (not only moves it), follows the delayed kernel, and is bounded', () => {
    const P = ABSORPTION_PARAMS as unknown as Record<string, number>;
    const saved = { s: P.stretchPerFatG, e: P.equivalentPerFatG, ep: P.equivalentPerProteinG };
    try {
      P.equivalentPerFatG = 0.5;
      P.equivalentPerProteinG = 0.25;
      const p = resolve({ fatG: 55, proteinG: 40 });
      expect(p.extraEquivalentG).toBeCloseTo(0.5 * 40 + 0.25 * 20, 9);
      assertValidProfile(p);
      const withExtra = run(meal(p, { fatG: 55, proteinG: 40 }));
      const without = run(meal({ ...p, extraEquivalentG: undefined }, { fatG: 55, proteinG: 40 }));
      expect(at(withExtra, 30)).toBeCloseTo(at(without, 30), 6); // nothing before the delay
      expect(at(withExtra, 180)).toBeGreaterThan(at(without, 180) + 5); // glucose is added later
      const csf = 50 / 10;
      const added = csf * (p.extraEquivalentG as number) * mealCumulativeAbsorption(180 - p.delayMin, p.tauSlowMin);
      expect(at(withExtra, 180) - at(without, 180)).toBeCloseTo(added, 6);
      // the carbohydrate itself is still conserved
      expect(profileCumulative(6000, p)).toBeCloseTo(1, 9);
      // the bound holds for absurd macros
      P.equivalentPerFatG = 100;
      expect(resolve({ fatG: 300, proteinG: 300 }).extraEquivalentG).toBe(ABSORPTION_PARAMS.equivalentMaxG);
      assertValidProfile(resolve({ fatG: 300, proteinG: 300 }));
    } finally {
      P.stretchPerFatG = saved.s;
      P.equivalentPerFatG = saved.e;
      P.equivalentPerProteinG = saved.ep;
    }
  });

  it('every valid input combination yields an in-bounds profile and finite curves (no NaN, no infinity)', () => {
    const classes = [null, 'fast', 'moderate_fast', 'moderate_mixed', 'slow_delayed'] as const;
    const confs = [null, 'low', 'medium', 'high'] as const;
    const grams = [null, 0, 3, 15, 40, 90, 400];
    let n = 0;
    for (const aiClass of classes) for (const aiConfidence of confs) for (const fatG of grams) for (const proteinG of grams) for (const fiberG of [null, 0, 12, 60]) {
      const p = resolve({ aiClass, aiConfidence, fatG, proteinG, fiberG, giEstimate: 70, giConfidence: 'medium' });
      assertValidProfile(p);
      for (const s of [0, 1, 30, 90, 180, 600]) expect(Number.isFinite(profileCumulative(s, p))).toBe(true);
      n += 1;
    }
    expect(n).toBeGreaterThan(1000);
    expect(() => assertValidProfile({ ...defaultProfile(TAU_M), phi: 0.9 })).toThrow(RangeError);
    expect(() => assertValidProfile({ ...defaultProfile(TAU_M), phi: 0.3, delayMin: 0 })).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Controlled comparison: same carbohydrate amount, same starting conditions, same insulin record; only the meal's absorption differs.
// ---------------------------------------------------------------------------------------------------------------------
const T0 = 1_792_000_000;
const CARBS = 60;

function meal(profile: AbsorptionProfile | undefined, over: Partial<MealInput> = {}): MealInput {
  return {
    id: 'm1',
    revision: 1,
    tSec: T0,
    carbsG: CARBS,
    carbsSigmaG: 9,
    fatG: null,
    proteinG: null,
    provenance: 'estimated',
    timeClass: 'medium',
    timingUncertaintyMin: 0,
    icrGPerU: 10,
    isfMgdlPerU: 50,
    ...(profile ? { absorption: profile } : {}),
    ...over,
  };
}

function run(m: MealInput) {
  const inputs: RunInputs = {
    layerVersion: 'test',
    anchorSec: T0,
    horizonMin: 180,
    baseline: Array.from({ length: 24 }, (_, k) => ({ minutes: (k + 1) * 5, value: 120 })),
    baselineSigmaKnots: [[0, 0], [60, 30], [180, 60]],
    meals: [m],
    insulin: [],
    links: [{ mealId: 'm1', status: 'confirmed_none', insulinIds: [], unitsTotal: 0 }], // "took none": the meal is counted in full
    params: { ...DEFAULT_ENGINE_PARAMS, trendOverlap: false },
    excludeMealIds: [],
    insulinHistory: 'confirmed_none',
  };
  return computeRun(inputs);
}
const at = (r: ReturnType<typeof run>, minutes: number) => r.layer.series.mealApplied[minutes / STEP_MIN - 1] as number;
const cob = (r: ReturnType<typeof run>, minutes: number) => r.layer.series.cobGrams[minutes / STEP_MIN - 1] as number;

describe('controlled meal scenarios (same carbohydrate, same start, same insulin record)', () => {
  const sugary = run(meal(PROFILES.sugary));
  const mixed = run(meal(PROFILES.mixed));
  const highFat = run(meal(PROFILES.highFat));
  const uncertain = run(meal(resolve({ giEstimate: 85, giConfidence: 'low' }))); // GI uncertain, nothing else known
  const legacy = run(meal(undefined));

  it('the early absorption profiles differ in the intended direction: sugary > mixed > high fat/protein', () => {
    for (const m of [15, 30, 60, 90]) {
      expect(at(sugary, m)).toBeGreaterThan(at(mixed, m));
      expect(at(mixed, m)).toBeGreaterThan(at(highFat, m));
    }
  });

  it('late horizons: the high-fat/protein meal is still absorbing at +2-3 h (delayed absorption does not vanish), the fast meal is nearly done', () => {
    for (const m of [120, 150, 180]) {
      expect(cob(highFat, m)).toBeGreaterThan(cob(mixed, m));
      expect(cob(mixed, m)).toBeGreaterThan(cob(sugary, m));
    }
    const lateRise = (r: ReturnType<typeof run>) => at(r, 180) - at(r, 120); // glucose still to appear between +2 h and +3 h
    expect(lateRise(highFat)).toBeGreaterThan(lateRise(mixed));
    expect(lateRise(mixed)).toBeGreaterThan(lateRise(sugary));
    expect(cob(highFat, 180)).toBeGreaterThan(0.2 * CARBS); // a substantial share is still to come after three hours
    // ...and the delayed part has really not been dropped: the profile keeps absorbing well beyond the forecast window
    expect(profileCumulative(300, PROFILES.highFat as AbsorptionProfile)).toBeLessThan(0.99);
    expect(profileCumulative(300, PROFILES.highFat as AbsorptionProfile)).toBeGreaterThan(profileCumulative(180, PROFILES.highFat as AbsorptionProfile));
  });

  it('the total carbohydrate is the same in every scenario (only its timing differs)', () => {
    for (const p of [PROFILES.sugary, PROFILES.mixed, PROFILES.highFat]) expect(profileCumulative(6000, p as AbsorptionProfile)).toBeCloseTo(1, 9);
    for (const r of [sugary, mixed, highFat]) {
      let last = CARBS;
      for (let m = 5; m <= 180; m += 5) {
        expect(cob(r, m)).toBeLessThanOrEqual(last + 1e-9); // carbohydrate on board only runs down and never exceeds what was eaten
        expect(cob(r, m)).toBeGreaterThanOrEqual(0);
        last = cob(r, m);
      }
    }
  });

  it('a meal with uncertain GI and incomplete data falls back to the existing behaviour, exactly', () => {
    expect(uncertain.layer.series.mealApplied).toEqual(legacy.layer.series.mealApplied);
    expect(uncertain.points.map((p) => [p.adjusted, p.low, p.high])).toEqual(legacy.points.map((p) => [p.adjusted, p.low, p.high]));
    expect(mixed.layer.series.mealApplied).toEqual(legacy.layer.series.mealApplied); // a standard mixed meal keeps the default profile
  });

  it('every value in every scenario is finite, and the glucose-only baseline stays inside the band', () => {
    for (const r of [sugary, mixed, highFat, uncertain, legacy]) {
      for (const p of r.points) {
        for (const v of [p.adjusted, p.low, p.high]) expect(Number.isFinite(v)).toBe(true);
        expect(p.low).toBeLessThanOrEqual(p.adjusted);
        expect(p.high).toBeGreaterThanOrEqual(p.adjusted);
      }
    }
  });

  it('a shifted profile on weak evidence widens the band (the shift is only partly trusted); the line does not move because of it', () => {
    const weak = resolve({ aiClass: 'slow_delayed', aiConfidence: 'low', fatG: 50, proteinG: 40 });
    const strong = resolve({ aiClass: 'slow_delayed', aiConfidence: 'high', fatG: 50, proteinG: 40 });
    expect(weak.uncertaintyWeight).toBeGreaterThan(strong.uncertaintyWeight);
    const w = run(meal(weak));
    const s = run(meal({ ...weak, uncertaintyWeight: 0 }));
    expect(w.layer.series.mealApplied).toEqual(s.layer.series.mealApplied);
    const width = (r: ReturnType<typeof run>, m: number) => (r.points.find((p) => p.minutes === m)?.high as number) - (r.points.find((p) => p.minutes === m)?.low as number);
    expect(width(w, 120)).toBeGreaterThan(width(s, 120));
  });

  it('the project spec\'s optional extra delayed amplitude is not added on top of a delayed profile (no double counting)', () => {
    const withAlpha = computeRun({
      layerVersion: 'test',
      anchorSec: T0,
      horizonMin: 180,
      baseline: Array.from({ length: 24 }, (_, k) => ({ minutes: (k + 1) * 5, value: 120 })),
      baselineSigmaKnots: [[0, 0], [180, 60]],
      meals: [meal(PROFILES.highFat, { fatG: 50, proteinG: 40 })],
      insulin: [],
      links: [{ mealId: 'm1', status: 'confirmed_none', insulinIds: [], unitsTotal: 0 }],
      params: { ...DEFAULT_ENGINE_PARAMS, trendOverlap: false, alphaP: 0.5, alphaF: 0.2 },
      excludeMealIds: [],
      insulinHistory: 'confirmed_none',
    });
    expect(withAlpha.layer.series.mealApplied).toEqual(highFat.layer.series.mealApplied);
  });
});
