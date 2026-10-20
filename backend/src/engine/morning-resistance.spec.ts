import { describe, expect, it } from 'vitest';
import { DEFAULT_ENGINE_PARAMS, MORNING_RESISTANCE, STEP_MIN } from './params.js';
import { computeRun, type RunInputs } from './run.js';
import type { InsulinInput } from './types.js';

const T0 = 1_792_000_000;
const dose = (id: string, ageMin: number, units: number, over: Partial<InsulinInput> = {}): InsulinInput => ({
  id, revision: 1, tSec: T0 - ageMin * 60, units, kind: 'correction', ultraRapid: false, uncertain: false, isfMgdlPerU: 50, declaredMealId: null, ...over,
});
function run(insulin: InsulinInput[]) {
  const inputs: RunInputs = {
    layerVersion: 'test', anchorSec: T0, horizonMin: 180,
    baseline: Array.from({ length: 24 }, (_, k) => ({ minutes: (k + 1) * 5, value: 150 })),
    baselineSigmaKnots: [[0, 0], [60, 30], [180, 60]],
    meals: [], insulin, links: [], params: { ...DEFAULT_ENGINE_PARAMS, trendOverlap: false }, excludeMealIds: [], insulinHistory: 'logged',
  };
  return computeRun(inputs);
}
const effectAt = (r: ReturnType<typeof run>, minutes: number) => r.layer.series.insulinApplied[minutes / STEP_MIN - 1] as number;
const sigmaAt = (r: ReturnType<typeof run>, minutes: number) => r.layer.series.sigmaInsulin[minutes / STEP_MIN - 1] as number;

describe('morning insulin resistance in the engine', () => {
  it('a flagged dose lowers glucose by 1/(1+r) of the normal amount, at every horizon', () => {
    const normal = run([dose('a', 0, 4)]);
    const morning = run([dose('a', 0, 4, { morningResistanceRel: 0.25 })]);
    for (const m of [30, 60, 120, 180]) expect(effectAt(morning, m)).toBeCloseTo(effectAt(normal, m) / 1.25, 6);
    expect(effectAt(morning, 120)).toBeGreaterThan(0);
    expect(morning.points.find((p) => p.minutes === 120)!.adjusted).toBeGreaterThan(normal.points.find((p) => p.minutes === 120)!.adjusted);
  });

  it('only the flagged dose is affected; an unflagged dose, 0 and a missing value all act normally', () => {
    const base = run([dose('a', 90, 3), dose('b', 0, 2)]);
    expect(effectAt(run([dose('a', 90, 3, { morningResistanceRel: 0 }), dose('b', 0, 2)]), 60)).toBeCloseTo(effectAt(base, 60), 9);
    const flaggedA = run([dose('a', 90, 3, { morningResistanceRel: 0.3 }), dose('b', 0, 2)]);
    const aOnly = (r: ReturnType<typeof run>) => effectAt(r, 60) - effectAt(run([dose('b', 0, 2)]), 60);
    expect(aOnly(flaggedA)).toBeCloseTo(aOnly(base) / 1.3, 6);
  });

  it('the size of the morning effect is uncertain: the band is wider, never narrower, and the units on board are unchanged', () => {
    const normal = run([dose('a', 0, 4)]);
    const morning = run([dose('a', 0, 4, { morningResistanceRel: 0.25 })]);
    // the reduced effect has a smaller absolute error from the normal sources, so compare the relative part: sigma/effect grows
    expect(sigmaAt(morning, 120) / effectAt(morning, 120)).toBeGreaterThan(sigmaAt(normal, 120) / effectAt(normal, 120));
    expect(morning.layer.iobU).toBeCloseTo(normal.layer.iobU as number, 9);
  });

  it('a negative or absurd value cannot make insulin stronger than normal', () => {
    const normal = run([dose('a', 0, 4)]);
    expect(effectAt(run([dose('a', 0, 4, { morningResistanceRel: -0.5 })]), 120)).toBeCloseTo(effectAt(normal, 120), 9);
  });

  it('constants: default 25%, at most 50%, day starts at 03:00', () => {
    expect(MORNING_RESISTANCE).toMatchObject({ defaultPercent: 25, maxPercent: 50, dayStartHour: 3 });
  });
});
