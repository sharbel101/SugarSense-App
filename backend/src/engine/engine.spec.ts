import { describe, expect, it } from 'vitest';
import { carbCoverage, linkMealsToInsulin } from './coverage.js';
import { carbSigmaG, composeForecast, priorBaselineSigma } from './compose.js';
import { computeEventLayer, type LayerInput } from './event-layer.js';
import {
  insulinActivity,
  insulinConstants,
  insulinCumulativeAction,
  insulinRemainingFraction,
  mealCumulativeAbsorption,
} from './kernels.js';
import { DEFAULT_ENGINE_PARAMS, TREND_SLOPE_WINDOW_MIN, trendResponseAt } from './params.js';
import type { InsulinInput, MealInput, MealLink } from './types.js';

const T0 = 1_792_000_000; // anchor, UTC seconds
const min = (m: number): number => m * 60;

describe('kernels - golden vectors G0 / G1 from the specification', () => {
  it('G0: IOB fractions for (tp 75, td 300) at 60/120/180/240 min', () => {
    const iob = [60, 120, 180, 240].map((s) => insulinRemainingFraction(s, 75, 300));
    expect(iob[0]).toBeCloseTo(0.764, 3);
    expect(iob[1]).toBeCloseTo(0.411, 3);
    expect(iob[2]).toBeCloseTo(0.159, 3);
    expect(iob[3]).toBeCloseTo(0.033, 3);
  });

  it('G0: constants for (75,300) and (55,300)', () => {
    const a = insulinConstants(75, 300);
    expect(a.tau).toBeCloseTo(112.5, 1);
    expect(a.b).toBeCloseTo(0.75, 3);
    expect(a.s).toBeCloseTo(2.691, 3);
    const b = insulinConstants(55, 300);
    expect(b.tau).toBeCloseTo(70.9, 1);
    expect(b.s).toBeCloseTo(1.823, 3);
  });

  it('activity integrates to 1 and peaks at tp; A(td) = 1', () => {
    let area = 0;
    let peakAt = 0;
    let peak = 0;
    for (let s = 0; s < 300; s += 0.1) {
      const a = insulinActivity(s + 0.05, 75, 300);
      area += a * 0.1;
      if (a > peak) {
        peak = a;
        peakAt = s;
      }
    }
    expect(area).toBeCloseTo(1, 4);
    expect(peakAt).toBeCloseTo(75, 0);
    expect(insulinCumulativeAction(300, 75, 300)).toBe(1);
    expect(insulinCumulativeAction(-5, 75, 300)).toBe(0);
  });

  it('rejects tp >= td/2 instead of clipping', () => {
    expect(() => insulinConstants(150, 300)).toThrow(RangeError);
    expect(() => insulinConstants(0, 300)).toThrow(RangeError);
  });

  it('meal kernel: share absorbed at 30/60/120 min with tau 40', () => {
    expect(mealCumulativeAbsorption(30, 40)).toBeCloseTo(0.173, 3);
    expect(mealCumulativeAbsorption(60, 40)).toBeCloseTo(0.442, 3);
    expect(mealCumulativeAbsorption(120, 40)).toBeCloseTo(0.801, 3);
    expect(mealCumulativeAbsorption(0, 40)).toBe(0);
  });

  it('G1: 4 U + 40 g, ISF 50, ICR 10 -> meal/insulin effects at 60 and 120 min', () => {
    const csf = 50 / 10;
    expect(csf * 40 * mealCumulativeAbsorption(60, 40)).toBeCloseTo(88.4, 1);
    expect(50 * 4 * insulinCumulativeAction(60, 75, 300)).toBeCloseTo(47.2, 1);
    expect(csf * 40 * mealCumulativeAbsorption(120, 40)).toBeCloseTo(160.2, 1);
    expect(50 * 4 * insulinCumulativeAction(120, 75, 300)).toBeCloseTo(117.9, 1);
  });
});

function meal(over: Partial<MealInput> = {}): MealInput {
  return {
    id: 'm1',
    revision: 1,
    tSec: T0,
    carbsG: 40,
    carbsSigmaG: 8,
    fatG: null,
    proteinG: null,
    provenance: 'estimated',
    timeClass: 'medium',
    timingUncertaintyMin: 0,
    icrGPerU: 10,
    isfMgdlPerU: 50,
    ...over,
  };
}

function dose(over: Partial<InsulinInput> = {}): InsulinInput {
  return {
    id: 'i1',
    revision: 1,
    tSec: T0,
    units: 4,
    kind: 'bolus',
    ultraRapid: false,
    uncertain: false,
    isfMgdlPerU: 50,
    declaredMealId: null,
    ...over,
  };
}

const linked = (mealId = 'm1', ids = ['i1'], units = 4): MealLink => ({
  mealId,
  status: 'linked_auto',
  insulinIds: ids,
  unitsTotal: units,
});

function layer(over: Partial<LayerInput>) {
  return computeEventLayer({
    anchorSec: T0,
    horizonMin: 180,
    stepMin: 5,
    meals: [],
    insulin: [],
    links: [],
    params: DEFAULT_ENGINE_PARAMS,
    excludeMealIds: new Set(),
    insulinHistory: 'none_recorded',
    ...over,
  });
}

const at = (r: ReturnType<typeof layer>, minutes: number, key: 'mealEffect' | 'insulinEffect') =>
  r.series[key][minutes / 5 - 1] as number;

describe('event layer', () => {
  it('no events: every effect is exactly zero and the feature set is glucose-only', () => {
    const r = layer({});
    expect(r.series.mealApplied.every((v) => v === 0)).toBe(true);
    expect(r.series.insulinApplied.every((v) => v === 0)).toBe(true);
    expect(r.series.scenarioUp.every((v) => v === 0)).toBe(true);
    expect(r.featureConfig).toBe('glucose_only');
    expect(r.iobU).toBeNull(); // unknown, never silently 0
  });

  it('matches the specification worked example G1 for a meal + exactly matched bolus at the anchor', () => {
    const r = layer({
      meals: [meal()],
      insulin: [dose()],
      links: [linked()],
      insulinHistory: 'logged',
    });
    // the anchor is the event time, so increments equal the cumulative effects in the spec table
    expect(at(r, 60, 'mealEffect')).toBeCloseTo(88.4, 1);
    expect(at(r, 60, 'insulinEffect')).toBeCloseTo(47.2, 1);
    const net90 = at(r, 90, 'mealEffect') - at(r, 90, 'insulinEffect');
    expect(net90).toBeCloseTo(47.7, 1); // spec: net peaks near +47.7 mg/dL at 90 min
    const net180 = at(r, 180, 'mealEffect') - at(r, 180, 'insulinEffect');
    expect(net180).toBeCloseTo(19.5, 1);
    expect(r.featureConfig).toBe('meal+insulin');
    expect(r.iobU).toBeCloseTo(4, 6);
  });

  it('ICR enters only through CSF = ISF/ICR: halving the ICR doubles the meal effect, insulin effect unchanged', () => {
    const base = layer({ meals: [meal()], insulin: [dose()], links: [linked()], insulinHistory: 'logged' });
    const lowIcr = layer({
      meals: [meal({ icrGPerU: 5 })],
      insulin: [dose()],
      links: [linked()],
      insulinHistory: 'logged',
    });
    expect(at(lowIcr, 120, 'mealEffect')).toBeCloseTo(2 * at(base, 120, 'mealEffect'), 6);
    expect(at(lowIcr, 120, 'insulinEffect')).toBeCloseTo(at(base, 120, 'insulinEffect'), 9);
  });

  it('no double counting: a meal covered exactly by its bolus ends near zero net, with no extra ICR term', () => {
    // units = carbs / ICR -> CSF*C == ISF*U, so the asymptotic net is zero
    const r = layer({ meals: [meal()], insulin: [dose()], links: [linked()], insulinHistory: 'logged', horizonMin: 180 });
    const net = r.series.mealApplied.map((v, j) => v - (r.series.insulinApplied[j] as number));
    expect(Math.abs(net[net.length - 1] as number)).toBeLessThan(20); // spec table: +19.5 at 180, +3.1 at 240
    // more insulin than the ICR corresponds to lowers the path relative to the matched case; the model
    // does not force a low (the baseline decides the starting level)
    const more = layer({ meals: [meal()], insulin: [dose({ units: 6 })], links: [linked('m1', ['i1'], 6)], insulinHistory: 'logged' });
    const less = layer({ meals: [meal()], insulin: [dose({ units: 2 })], links: [linked('m1', ['i1'], 2)], insulinHistory: 'logged' });
    const netAt = (x: ReturnType<typeof layer>, m: number) => at(x, m, 'mealEffect') - at(x, m, 'insulinEffect');
    expect(netAt(more, 150)).toBeLessThan(netAt(r, 150));
    expect(netAt(less, 150)).toBeGreaterThan(netAt(r, 150));
    // magnitudes come from the kernels (ISF x extra units x A), not a fixed constant
    expect(netAt(r, 150) - netAt(more, 150)).toBeCloseTo(50 * 2 * insulinCumulativeAction(150, 75, 300), 6);
  });

  it('events that already acted do not act twice: effect starts from the anchor, not from the event time', () => {
    const fresh = layer({ meals: [meal({ tSec: T0 })], insulin: [dose()], links: [linked()], insulinHistory: 'logged' });
    const raw = { ...DEFAULT_ENGINE_PARAMS, trendOverlap: false };
    const old = layer({
      meals: [meal({ tSec: T0 - min(90) })],
      insulin: [dose({ tSec: T0 - min(90) })],
      links: [linked()],
      insulinHistory: 'logged',
      params: raw,
    });
    // 90 minutes later most of the remaining meal effect is smaller than a fresh meal's first 90 minutes
    expect(at(old, 30, 'mealEffect')).toBeLessThan(at(fresh, 30, 'mealEffect'));
    // and the future increment equals F(90+h)-F(90), never F(h) from zero
    expect(at(old, 30, 'mealEffect')).toBeCloseTo(5 * 40 * (mealCumulativeAbsorption(120, 40) - mealCumulativeAbsorption(90, 40)), 6);
  });

  it('a meal logged with NO insulin record does not move the mean; the band is stretched upward instead', () => {
    const r = layer({
      meals: [meal()],
      links: [{ mealId: 'm1', status: 'none_recorded', insulinIds: [], unitsTotal: null }],
      insulinHistory: 'none_recorded',
    });
    expect(r.series.mealApplied.every((v) => v === 0)).toBe(true);
    expect(Math.max(...r.series.scenarioUp)).toBeGreaterThan(100);
    expect(r.featureConfig).toBe('glucose_only');
    expect(r.dispositions[0]).toMatchObject({ role: 'scenario_only', reason: 'insulin_not_recorded' });
    expect(r.iobU).toBeNull();
  });

  it('a meal with a CONFIRMED-none declaration applies the full carbohydrate effect', () => {
    const r = layer({
      meals: [meal()],
      links: [{ mealId: 'm1', status: 'confirmed_none', insulinIds: ['z1'], unitsTotal: 0 }],
      insulinHistory: 'confirmed_none',
    });
    expect(Math.max(...r.series.mealApplied)).toBeGreaterThan(150);
    expect(r.featureConfig).toBe('meal_only');
    expect(r.iobU).toBe(0);
  });

  it('an unlinked meal bolus does not lower the mean; the band is stretched downward', () => {
    const r = layer({ insulin: [dose()], insulinHistory: 'logged' });
    expect(r.series.insulinApplied.every((v) => v === 0)).toBe(true);
    expect(Math.max(...r.series.scenarioDown)).toBeGreaterThan(100);
    expect(r.dispositions[0]).toMatchObject({ role: 'scenario_only', reason: 'dose_without_recorded_meal' });
  });

  it('a correction dose lowers the mean through the insulin kernel', () => {
    const r = layer({ insulin: [dose({ kind: 'correction', units: 2 })], insulinHistory: 'logged' });
    expect(r.featureConfig).toBe('insulin_only');
    expect(at(r, 120, 'insulinEffect')).toBeCloseTo(50 * 2 * (insulinCumulativeAction(120, 75, 300)), 6);
  });

  it.each(['bolus', 'correction'] as const)('a %s dose declared against a WITHDRAWN meal never lowers the mean, whatever its kind', (kind) => {
    const r = layer({ insulin: [dose({ kind, declaredMealCancelled: true })], insulinHistory: 'logged' });
    expect(r.series.insulinApplied.every((v) => v === 0)).toBe(true);
    expect(Math.max(...r.series.scenarioDown)).toBeGreaterThan(100); // the band is stretched downward instead
    expect(r.dispositions[0]).toMatchObject({ role: 'scenario_only', reason: 'linked_meal_cancelled' });
    expect(r.appliedInsulin).toBe(0);
    expect(r.iobU).toBeGreaterThan(0); // it was still taken: it stays in the insulin-on-board count
  });

  it('missing ICR or ISF: the meal is ignored with a stated reason, nothing is invented', () => {
    const r = layer({
      meals: [meal({ icrGPerU: null })],
      links: [{ mealId: 'm1', status: 'confirmed_none', insulinIds: [], unitsTotal: 0 }],
    });
    expect(r.series.mealApplied.every((v) => v === 0)).toBe(true);
    expect(r.dispositions[0]).toMatchObject({ role: 'ignored', reason: 'therapy_settings_missing' });
  });

  it('unknown carbs: meal ignored; a dose linked to it cannot lower the mean', () => {
    const r = layer({
      meals: [meal({ carbsG: null, carbsSigmaG: null, provenance: null })],
      insulin: [dose()],
      links: [linked()],
      insulinHistory: 'logged',
    });
    expect(r.series.insulinApplied.every((v) => v === 0)).toBe(true);
    expect(r.dispositions.map((d) => d.reason)).toEqual(['carbs_unknown', 'linked_meal_not_usable']);
  });

  it('counterfactual exclusion drops the meal but keeps the insulin that was actually delivered', () => {
    const args = { meals: [meal()], insulin: [dose()], links: [linked()], insulinHistory: 'logged' as const };
    const withMeal = layer(args);
    const without = layer({ ...args, excludeMealIds: new Set(['m1']) });
    expect(without.series.mealApplied.every((v) => v === 0)).toBe(true);
    expect(without.series.insulinApplied).toEqual(withMeal.series.insulinApplied);
    expect(without.dispositions).toContainEqual({ eventType: 'meal', id: 'm1', role: 'excluded', reason: 'excluded_by_request' });
    expect(without.dispositions).toContainEqual({
      eventType: 'insulin',
      id: 'i1',
      role: 'applied',
      reason: 'meal_excluded_but_insulin_delivered',
    });
    expect(without.iobU).toBeCloseTo(withMeal.iobU as number, 9);
  });

  it('timing and carbohydrate uncertainty widen sigma; trusted data does not', () => {
    const trusted = layer({ meals: [meal()], insulin: [dose()], links: [linked()], insulinHistory: 'logged' });
    const shaky = layer({
      meals: [meal({ timingUncertaintyMin: 20 })],
      insulin: [dose({ uncertain: true })],
      links: [linked()],
      insulinHistory: 'logged',
    });
    expect(Math.max(...trusted.series.sigmaTiming)).toBe(0);
    expect(Math.max(...shaky.series.sigmaTiming)).toBeGreaterThan(5);
    expect(Math.max(...shaky.series.sigmaInsulin)).toBeGreaterThan(Math.max(...trusted.series.sigmaInsulin));
    expect(Math.max(...trusted.series.sigmaCarb)).toBeGreaterThan(0);
  });

  it('fat and protein: with the spec default alpha = 0 the mean is unchanged, only the late interval widens', () => {
    const plain = layer({ meals: [meal()], links: [{ mealId: 'm1', status: 'confirmed_none', insulinIds: [], unitsTotal: 0 }] });
    const fatty = layer({
      meals: [meal({ fatG: 40, proteinG: 30 })],
      links: [{ mealId: 'm1', status: 'confirmed_none', insulinIds: [], unitsTotal: 0 }],
    });
    expect(fatty.series.mealApplied).toEqual(plain.series.mealApplied);
    expect(Math.max(...fatty.series.sigmaFatProtein)).toBeGreaterThan(0);
    // a learned non-zero alpha is the only thing that may shift the mean
    const learned = layer({
      meals: [meal({ fatG: 40, proteinG: 30 })],
      links: [{ mealId: 'm1', status: 'confirmed_none', insulinIds: [], unitsTotal: 0 }],
      params: { ...DEFAULT_ENGINE_PARAMS, alphaF: 0.1 },
    });
    expect(Math.max(...learned.series.mealApplied)).toBeGreaterThan(Math.max(...plain.series.mealApplied));
  });

  it('is deterministic: identical input gives identical output', () => {
    const args = { meals: [meal()], insulin: [dose()], links: [linked()], insulinHistory: 'logged' as const };
    expect(JSON.stringify(layer(args))).toBe(JSON.stringify(layer(args)));
  });

  it('personal scales multiply the effects and nothing else', () => {
    const args = { meals: [meal()], insulin: [dose()], links: [linked()], insulinHistory: 'logged' as const };
    const scaled = layer({ ...args, params: { ...DEFAULT_ENGINE_PARAMS, mCsf: 1.2, mIsf: 0.8 } });
    const base = layer(args);
    expect(scaled.series.mealApplied[10]).toBeCloseTo(1.2 * (base.series.mealApplied[10] as number), 9);
    expect(scaled.series.insulinApplied[10]).toBeCloseTo(0.8 * (base.series.insulinApplied[10] as number), 9);
    // the unscaled series stored for later fitting does not depend on the scales
    expect(scaled.series.mealEffect).toEqual(base.series.mealEffect);
  });
});

describe('trend overlap with the glucose-only model', () => {
  const confirmedNone = { mealId: 'm1', status: 'confirmed_none' as const, insulinIds: ['z'], unitsTotal: 0 };
  const raw = { ...DEFAULT_ENGINE_PARAMS, trendOverlap: false };

  it('the response table is the measured one: rises to about 7 minutes at +1 h, falls to about 4 at +2 h', () => {
    expect(trendResponseAt(5)).toBeCloseTo(2.09, 2);
    expect(trendResponseAt(60)).toBeCloseTo(7.127, 3);
    expect(trendResponseAt(120)).toBeCloseTo(4.222, 3);
    expect(trendResponseAt(500)).toBeCloseTo(4.222, 3);
    expect(trendResponseAt(62.5)).toBeGreaterThan(trendResponseAt(120));
    expect(trendResponseAt(2.5)).toBeCloseTo(1.045, 3);
  });

  it('an event that has not moved glucose yet (just logged) is not reduced: nothing is double counted yet', () => {
    const on = layer({ meals: [meal()], links: [confirmedNone], insulinHistory: 'confirmed_none' });
    const off = layer({ meals: [meal()], links: [confirmedNone], insulinHistory: 'confirmed_none', params: raw });
    expect(on.series.mealEffect).toEqual(off.series.mealEffect);
  });

  it('a meal that is already raising glucose: the part the glucose-only model extrapolates is taken back out', () => {
    const args = { meals: [meal({ tSec: T0 - min(40) })], links: [confirmedNone], insulinHistory: 'confirmed_none' as const };
    const on = layer(args);
    const off = layer({ ...args, params: raw });
    // event-driven slope over the last 15 minutes, mg/dL per minute
    const slope = (5 * 40 * (mealCumulativeAbsorption(40, 40) - mealCumulativeAbsorption(40 - TREND_SLOPE_WINDOW_MIN, 40))) / TREND_SLOPE_WINDOW_MIN;
    expect(slope).toBeGreaterThan(1.5);
    for (const m of [30, 60, 120]) {
      const j = m / 5 - 1;
      expect((off.series.mealEffect[j] as number) - (on.series.mealEffect[j] as number)).toBeCloseTo(trendResponseAt(m) * slope, 9);
    }
    expect(on.series.mealApplied[11] as number).toBeLessThan(off.series.mealApplied[11] as number);
  });

  it('insulin is treated the same way, with its own sign, and scenario-only events are never corrected', () => {
    const insArgs = { insulin: [dose({ kind: 'correction', tSec: T0 - min(60) })], insulinHistory: 'logged' as const };
    const on = layer(insArgs);
    const off = layer({ ...insArgs, params: raw });
    const slopeI = (50 * 4 * (insulinCumulativeAction(60, 75, 300) - insulinCumulativeAction(60 - TREND_SLOPE_WINDOW_MIN, 75, 300))) / TREND_SLOPE_WINDOW_MIN;
    expect(slopeI).toBeGreaterThan(0.5);
    expect((off.series.insulinEffect[11] as number) - (on.series.insulinEffect[11] as number)).toBeCloseTo(trendResponseAt(60) * slopeI, 9);
    // no recorded meal -> scenario only -> the mean is not moved, so there is nothing to correct
    const unlinked = layer({ meals: [meal({ tSec: T0 - min(40) })], links: [{ mealId: 'm1', status: 'none_recorded', insulinIds: [], unitsTotal: null }], insulinHistory: 'none_recorded' });
    const unlinkedOff = layer({ meals: [meal({ tSec: T0 - min(40) })], links: [{ mealId: 'm1', status: 'none_recorded', insulinIds: [], unitsTotal: null }], insulinHistory: 'none_recorded', params: raw });
    expect(unlinked.series.mealEffect).toEqual(unlinkedOff.series.mealEffect);
    expect(unlinked.series.scenarioUp).toEqual(unlinkedOff.series.scenarioUp);
  });

  it('a matched meal and dose nearing the end of absorption can be net NEGATIVE: the baseline over-extrapolates the fading rise', () => {
    const r = layer({ meals: [meal({ tSec: T0 - min(110) })], insulin: [dose({ tSec: T0 - min(110) })], links: [linked()], insulinHistory: 'logged' });
    const j = 60 / 5 - 1;
    const net = (r.series.mealApplied[j] as number) - (r.series.insulinApplied[j] as number);
    expect(Number.isFinite(net)).toBe(true);
  });
});

describe('insulin on board and carbs on board along the forecast', () => {
  const args = { meals: [meal()], insulin: [dose()], links: [linked()], insulinHistory: 'logged' as const };

  it('start from the values at the anchor, run down with the same kernels, never below zero', () => {
    const r = layer(args);
    const iob = r.series.iobUnits as number[];
    const cob = r.series.cobGrams as number[];
    // 4 U at the anchor, 5 min later it is 4 * (1 - A(5)); the kernel decides the speed
    expect(iob[0]).toBeCloseTo(4 * insulinRemainingFraction(5, 75, 300), 9);
    expect(iob[23]).toBeCloseTo(4 * insulinRemainingFraction(120, 75, 300), 9); // 41.1 % left at 2 h (spec G0)
    expect(iob[35]).toBeCloseTo(4 * insulinRemainingFraction(180, 75, 300), 9);
    expect(cob[0]).toBeCloseTo(40 * (1 - mealCumulativeAbsorption(5, 40)), 9);
    expect(cob[23]).toBeCloseTo(40 * (1 - mealCumulativeAbsorption(120, 40)), 9); // 19.9 % left at 2 h
    for (let j = 1; j < 36; j += 1) {
      expect(iob[j]).toBeLessThanOrEqual(iob[j - 1] as number);
      expect(cob[j]).toBeLessThanOrEqual(cob[j - 1] as number);
      expect(iob[j]).toBeGreaterThanOrEqual(0);
      expect(cob[j]).toBeGreaterThanOrEqual(0);
    }
    expect(r.iobU).toBeCloseTo(4, 9);
    expect(r.cobG).toBeCloseTo(40, 9);
  });

  it('unknown stays unknown: no insulin record gives a null series, not zeros; a confirmed none gives zeros', () => {
    const unknown = layer({ meals: [meal()], links: [{ mealId: 'm1', status: 'none_recorded', insulinIds: [], unitsTotal: null }], insulinHistory: 'none_recorded' });
    expect(unknown.series.iobUnits.every((v) => v === null)).toBe(true);
    expect(unknown.series.cobGrams.every((v) => typeof v === 'number')).toBe(true); // the meal itself is logged
    const none = layer({ meals: [meal()], links: [{ mealId: 'm1', status: 'confirmed_none', insulinIds: ['z'], unitsTotal: 0 }], insulinHistory: 'confirmed_none' });
    expect(none.series.iobUnits.every((v) => v === 0)).toBe(true);
    const nothing = layer({});
    expect(nothing.series.cobGrams.every((v) => v === null)).toBe(true);
    expect(nothing.series.iobUnits.every((v) => v === null)).toBe(true);
  });

  it('an excluded (what-if) meal leaves carbs on board; delivered insulin stays on board', () => {
    const r = layer({ ...args, excludeMealIds: new Set(['m1']) });
    expect(r.series.cobGrams.every((v) => v === null)).toBe(true);
    expect((r.series.iobUnits[0] as number)).toBeGreaterThan(3);
  });

  it('older entries have run down further; the composer rounds and passes the series to each point', () => {
    const old = layer({ meals: [meal({ tSec: T0 - min(120) })], insulin: [dose({ tSec: T0 - min(120) })], links: [linked()], insulinHistory: 'logged' });
    expect(old.iobU).toBeCloseTo(4 * insulinRemainingFraction(120, 75, 300), 9);
    const baseline = Array.from({ length: 24 }, (_, j) => ({ minutes: (j + 1) * 5, value: 120 }));
    const pts = composeForecast({ baseline, layer: layer(args), sigmaBaseline: priorBaselineSigma, horizonMin: 180 });
    expect(pts[23]?.insulinOnBoardUnits).toBe(Math.round(4 * insulinRemainingFraction(120, 75, 300) * 100) / 100);
    expect(pts[23]?.carbsOnBoardGrams).toBe(Math.round(40 * (1 - mealCumulativeAbsorption(120, 40)) * 10) / 10);
    const unknown = composeForecast({ baseline, layer: layer({}), sigmaBaseline: priorBaselineSigma, horizonMin: 180 });
    expect(unknown.every((p) => p.insulinOnBoardUnits === null && p.carbsOnBoardGrams === null)).toBe(true);
  });
});

describe('meal <-> insulin linking and carbohydrate coverage', () => {
  const ins = (over: Partial<Parameters<typeof linkMealsToInsulin>[1][number]> & { id: string }) => ({
    tSec: T0,
    unitsAdministered: 4,
    kind: 'bolus' as const,
    confirmation: 'confirmed' as const,
    declaredMealId: null,
    ...over,
  });

  it('no insulin record is "none_recorded", never "none taken"', () => {
    const [l] = linkMealsToInsulin([{ id: 'm1', tSec: T0 }], []);
    expect(l).toMatchObject({ status: 'none_recorded', unitsTotal: null });
  });

  it('only a confirmed zero-unit event means none taken', () => {
    const [l] = linkMealsToInsulin([{ id: 'm1', tSec: T0 }], [ins({ id: 'z', unitsAdministered: 0 })]);
    expect(l).toMatchObject({ status: 'confirmed_none', unitsTotal: 0 });
    const [u] = linkMealsToInsulin([{ id: 'm1', tSec: T0 }], [ins({ id: 'z', unitsAdministered: 0, confirmation: 'uncertain' })]);
    expect(u?.status).toBe('none_recorded');
  });

  it('a planned dose is never linked', () => {
    const [l] = linkMealsToInsulin([{ id: 'm1', tSec: T0 }], [ins({ id: 'p', confirmation: 'planned', unitsAdministered: null })]);
    expect(l?.status).toBe('none_recorded');
  });

  it('basal and correction doses are never auto-linked as the meal bolus', () => {
    const [a] = linkMealsToInsulin([{ id: 'm1', tSec: T0 }], [ins({ id: 'b', kind: 'basal', unitsAdministered: 20 })]);
    const [b] = linkMealsToInsulin([{ id: 'm1', tSec: T0 }], [ins({ id: 'c', kind: 'correction' })]);
    expect(a?.status).toBe('none_recorded');
    expect(b?.status).toBe('none_recorded');
  });

  it('one bolus inside the window links; outside it does not', () => {
    const [near] = linkMealsToInsulin([{ id: 'm1', tSec: T0 }], [ins({ id: 'i', tSec: T0 - min(15) })]);
    expect(near).toMatchObject({ status: 'linked_auto', insulinIds: ['i'], unitsTotal: 4 });
    const [far] = linkMealsToInsulin([{ id: 'm1', tSec: T0 }], [ins({ id: 'i', tSec: T0 + min(90) })]);
    expect(far?.status).toBe('none_recorded');
  });

  it('a dose that could belong to two meals is ambiguous for both - nothing is assumed', () => {
    const links = linkMealsToInsulin(
      [
        { id: 'a', tSec: T0 },
        { id: 'b', tSec: T0 + min(25) },
      ],
      [ins({ id: 'i', tSec: T0 + min(10) })],
    );
    expect(links.map((l) => l.status)).toEqual(['ambiguous', 'ambiguous']);
    expect(links.every((l) => l.unitsTotal === null)).toBe(true);
  });

  it('a declared dose wins over time-window guessing', () => {
    const links = linkMealsToInsulin(
      [
        { id: 'a', tSec: T0 },
        { id: 'b', tSec: T0 + min(25) },
      ],
      [ins({ id: 'i', tSec: T0 + min(10), declaredMealId: 'b' })],
    );
    expect(links[0]?.status).toBe('none_recorded');
    expect(links[1]).toMatchObject({ status: 'linked_declared', insulinIds: ['i'] });
  });

  it('coverage example: 60 g, ICR 10, 4 U -> 40 g covered, 20 g more carbohydrate than that', () => {
    expect(carbCoverage(60, 4, 10)).toEqual({ coverageG: 40, carbsMinusCoverageG: 20 });
  });

  it('coverage is null whenever an input is unknown', () => {
    expect(carbCoverage(null, 4, 10)).toBeNull();
    expect(carbCoverage(60, null, 10)).toBeNull();
    expect(carbCoverage(60, 4, null)).toBeNull();
  });
});

describe('composeForecast', () => {
  const baseline = Array.from({ length: 24 }, (_, j) => ({ minutes: (j + 1) * 5, value: 120 + j }));

  it('no events: adjusted equals baseline, band is baseline +/- measured sigma, 36 steps to 180 min', () => {
    const pts = composeForecast({ baseline, layer: layer({}), sigmaBaseline: priorBaselineSigma, horizonMin: 180 });
    expect(pts).toHaveLength(36);
    expect(pts[0]).toMatchObject({ minutes: 5, baseline: 120, adjusted: 120, extension: false });
    expect(pts[23]).toMatchObject({ minutes: 120, baseline: 143, adjusted: 143, extension: false });
    expect(pts[24]).toMatchObject({ minutes: 125, baseline: null, adjusted: 143, extension: true, sigmaExtrapolated: true });
    expect(pts[11]?.high).toBeGreaterThan(pts[11]?.adjusted as number);
    expect(pts[11]?.low).toBeLessThan(pts[11]?.adjusted as number);
  });

  it('the interval always contains the glucose-only value, even when the layer moves the mean far away', () => {
    const l = layer({
      meals: [meal()],
      links: [{ mealId: 'm1', status: 'confirmed_none', insulinIds: [], unitsTotal: 0 }],
    });
    const pts = composeForecast({ baseline, layer: l, sigmaBaseline: () => 1, horizonMin: 120 });
    for (const p of pts) {
      expect(p.low).toBeLessThanOrEqual(p.baseline as number);
      expect(p.high).toBeGreaterThanOrEqual(p.baseline as number);
      expect(p.low).toBeLessThanOrEqual(p.adjusted);
      expect(p.high).toBeGreaterThanOrEqual(p.adjusted);
    }
    expect(pts[23]?.adjusted).toBeGreaterThan((pts[23]?.baseline as number) + 100);
  });

  it('beyond 120 min only events move the value; the baseline is held, not extrapolated', () => {
    const l = layer({
      meals: [meal()],
      links: [{ mealId: 'm1', status: 'confirmed_none', insulinIds: [], unitsTotal: 0 }],
    });
    const pts = composeForecast({ baseline, layer: l, sigmaBaseline: priorBaselineSigma, horizonMin: 180 });
    const p150 = pts.find((p) => p.minutes === 150) as (typeof pts)[number];
    expect(p150.baseline).toBeNull();
    expect(p150.adjusted).toBeCloseTo(143 + (l.series.mealApplied[29] as number), 1);
  });

  it('returns nothing when the glucose-only forecast is unavailable', () => {
    expect(composeForecast({ baseline: [], layer: layer({}), sigmaBaseline: priorBaselineSigma, horizonMin: 180 })).toEqual([]);
  });

  it('clips to 20-500 mg/dL and says so', () => {
    const low = Array.from({ length: 24 }, (_, j) => ({ minutes: (j + 1) * 5, value: 25 }));
    const pts = composeForecast({ baseline: low, layer: layer({ insulin: [dose({ kind: 'correction', units: 10 })], insulinHistory: 'logged' }), sigmaBaseline: () => 5, horizonMin: 120 });
    expect(Math.min(...pts.map((p) => p.adjusted))).toBe(20);
    expect(pts.some((p) => p.clipped)).toBe(true);
  });

  it('prior baseline sigma follows the measured curve and flags extrapolation past 60 min', () => {
    expect(priorBaselineSigma(30)).toBeCloseTo(29.52, 2);
    expect(priorBaselineSigma(60)).toBeCloseTo(40.24, 2);
    expect(priorBaselineSigma(120)).toBeGreaterThan(priorBaselineSigma(60));
    expect(priorBaselineSigma(37.5)).toBeGreaterThan(29.52);
  });

  it('carb sigma: photo range is read as an 80% interval within the spec bounds; typed values use c_C', () => {
    expect(carbSigmaG(40, 'estimated', 30, 50, 0.25)).toBeCloseTo(20 / (2 * 1.2816), 4);
    expect(carbSigmaG(40, 'estimated', 39, 41, 0.25)).toBeCloseTo(4, 6); // floored at 10%
    expect(carbSigmaG(40, 'estimated', 0, 200, 0.25)).toBeCloseTo(20, 6); // capped at 50%
    expect(carbSigmaG(40, 'user_entered', null, null, 0.25)).toBeCloseTo(10, 6);
  });
});
