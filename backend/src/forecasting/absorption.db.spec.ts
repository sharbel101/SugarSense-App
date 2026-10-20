import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { profileCumulative, resolveAbsorptionProfile } from '../engine/absorption.js';
import { computeRun, type RunInputs } from '../engine/run.js';
import { closeAll, hasTestDb, iso, makeRig, nowSec, okGlucose, setTestTherapy, type Rig } from '../../test/forecasting-rig.js';
import { MealsService } from '../meals/meals.service.js';
import { FakeMealVisionProvider } from '../meals/providers/fake-meal-vision.provider.js';
import type { ForecastOkDisplay } from './forecast-response.js';

/**
 * End to end on a real PostgreSQL (scratch database): food photo (mocked Gemini response) -> Gate 1 / Gate 2 -> stored meal with the
 * new features -> confirmation -> prediction inputs -> forecast -> stored prediction with its inputs, in the shadow and the active
 * deployment modes. Constructed worlds verify the mathematics and the plumbing, NOT clinical accuracy.
 */
const photo = { images: [{ base64Data: 'ZmFrZQ==', mimeType: 'image/jpeg' as const }] };
const CARBS = 60;

const pizza = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    foodStatus: 'detected',
    items: [{ name: 'pepperoni pizza', portionDescription: '3 slices', estimatedGrams: 330, netCarbsG: CARBS, caloriesKcal: 900, confidence: 'medium' }],
    totalNetCarbsG: CARBS,
    totalCarbsRangeLowG: 50,
    totalCarbsRangeHighG: 72,
    totalCaloriesKcal: 900,
    totalFatG: 45,
    totalProteinG: 35,
    totalFiberG: 3,
    estimatedGlycemicIndex: 65,
    glycemicIndexConfidence: 'medium',
    absorptionClass: 'slow_delayed',
    absorptionConfidence: 'medium',
    preparationAndMixtureFactors: { form: 'solid', carbohydrateQuality: 'refined_or_simple', preparation: 'baked_or_roasted', mixedMeal: true },
    analysisNotes: 'Cheese and oil amounts are not visible.',
    ...over,
  });

const ok = (f: unknown): ForecastOkDisplay => {
  const x = f as ForecastOkDisplay;
  expect(x.status).toBe('ok');
  return x;
};
const at = (f: ForecastOkDisplay, m: number) => f.points.find((p) => p.minutes === m)!;
const count = async (rig: Rig, sql: string, params: unknown[] = []): Promise<number> => Number((await rig.db.query<{ n: string }>(sql, params)).rows[0]!.n);
const svc = (rig: Rig, raw: string) => new MealsService(new FakeMealVisionProvider([{ kind: 'raw', rawText: raw }]), async () => {}, rig.flow);
const scan = async (rig: Rig, raw: string, eatenAt?: string): Promise<string> =>
  ((await svc(rig, raw).analyzeMeal({ ...photo, ...(eatenAt ? { eatenAt } : {}) })) as { mealEventId: string }).mealEventId;

const previousMode = process.env.ABSORPTION_MODE;
const setMode = (m: 'off' | 'shadow' | 'active' | undefined): void => {
  if (m === undefined) delete process.env.ABSORPTION_MODE;
  else process.env.ABSORPTION_MODE = m;
};

describe.skipIf(!hasTestDb)('glycaemic-response-aware absorption, end to end on PostgreSQL', () => {
  afterAll(closeAll);
  afterEach(() => setMode(previousMode as 'off' | 'shadow' | 'active' | undefined));

  /** Confirm a scanned meal and record "I took none" so the meal is counted in full. */
  async function confirmWithNoInsulin(rig: Rig, mealId: string, whenSec: number): Promise<void> {
    expect((await rig.api.editMeal(mealId, { status: 'confirmed' })).result).toBe('updated');
    await rig.api.addInsulin({ clientId: `none-${mealId.slice(0, 8)}`, administeredAt: iso(whenSec), kind: 'bolus', confirmation: 'confirmed', unitsAdministered: 0, source: 'manual' });
  }

  it('stores the new features with the meal, keeps the original response, and leaves older meals untouched', async () => {
    const rig = makeRig({ glucose: 130, baseline: () => 130 });
    await setTestTherapy(rig);
    const id = await scan(rig, pizza());
    const row = (await rig.db.query('SELECT * FROM meal_events WHERE meal_id = $1', [id])).rows[0];
    expect(row).toMatchObject({
      absorption_class_ai: 'slow_delayed',
      absorption_confidence: 'medium',
      feature_schema_version: 'meal-features-v2',
      prompt_version: 'meal-analysis-v2',
      absorption_class: 'medium', // what the PERSON chose is separate and untouched
      absorption_class_user: false,
      gi_confidence: 'medium',
    });
    expect(Number(row.glycemic_load)).toBe(39); // 65 x 60 / 100
    expect(row.meal_factors).toEqual({ form: 'solid', carbohydrateQuality: 'refined_or_simple', preparation: 'baked_or_roasted', mixedMeal: true });
    expect(row.analysis_raw.absorptionClass).toBe('slow_delayed'); // the model's own answer, preserved verbatim
    expect(Number(row.fat_g)).toBe(45);

    // an older-style answer (no new keys): stored as "not provided"
    const rig2 = makeRig({ glucose: 130, baseline: () => 130 });
    const old = JSON.parse(pizza());
    for (const k of ['absorptionClass', 'absorptionConfidence', 'preparationAndMixtureFactors']) delete old[k];
    const oldId = await scan(rig2, JSON.stringify(old));
    const oldRow = (await rig2.db.query('SELECT * FROM meal_events WHERE meal_id = $1', [oldId])).rows[0];
    expect([oldRow.absorption_class_ai, oldRow.absorption_confidence, oldRow.meal_factors]).toEqual([null, null, null]);
    expect(await rig2.events.mealById(rig2.userId, oldId)).toMatchObject({ absorptionClassAi: null, absorptionConfidence: null, mealFactors: null });
  });

  it('SHADOW mode (default): the forecast shown is the incumbent; the candidate is stored beside it, tagged, scoreable, and never learned from', async () => {
    setMode(undefined);
    const rig = makeRig({ glucose: 130, baseline: () => 130 });
    await setTestTherapy(rig);
    const t0 = nowSec() - 30;
    const id = await scan(rig, pizza(), iso(t0));
    await confirmWithNoInsulin(rig, id, t0);
    const shown = ok(await rig.forecast.run());
    expect(shown.models.eventLayer).toBe('meal-aware-0.1');

    // identical to a person whose meal had no features at all (the incumbent behaviour)
    const control = makeRig({ glucose: 130, baseline: () => 130 });
    await setTestTherapy(control);
    await control.api.addMeal({ clientId: 'plain-meal-00001', eatenAt: iso(t0), carbsG: CARBS });
    await control.api.addInsulin({ clientId: 'plain-none-0001', administeredAt: iso(t0), kind: 'bolus', confirmation: 'confirmed', unitsAdministered: 0, source: 'manual' });
    const plain = ok(await control.forecast.run());
    expect(shown.points.map((p) => p.adjusted)).toEqual(plain.points.map((p) => p.adjusted));

    const stored = await rig.db.query<{ model_version: string; feature_config: string; snapshot: { role: string; shadowOf: string }; inputs_hash: string }>(
      'SELECT model_version, feature_config, input_snapshot AS snapshot, inputs_hash FROM predictions WHERE user_id = $1 ORDER BY model_version, horizon_min',
      [rig.userId],
    );
    const shadow = stored.rows.filter((r) => r.model_version === 'meal-aware-0.3-shadow+direct_120');
    const main = stored.rows.filter((r) => r.model_version === 'meal-aware-0.1+direct_120');
    expect(shadow.length).toBeGreaterThan(0);
    expect(shadow.every((r) => r.snapshot.role === 'meal_aware_shadow')).toBe(true);
    expect(shadow.every((r) => main.some((m) => m.inputs_hash === r.snapshot.shadowOf))).toBe(true);
    expect(stored.rows.filter((r) => r.model_version.includes('-shadow+') && r.feature_config === 'glucose_only')).toEqual([]); // no duplicate baseline rows
    expect(await count(rig, "SELECT COUNT(*) AS n FROM prediction_event_links l JOIN forecast_runs r USING (run_id) WHERE r.user_id = $1 AND r.layer_version = 'meal-aware-0.3'", [rig.userId])).toBe(0);
    // a meal with no non-default profile creates no shadow at all (nothing to compare)
    expect(await count(control, "SELECT COUNT(*) AS n FROM predictions WHERE user_id = $1 AND model_version LIKE '%-shadow+%'", [control.userId])).toBe(0);
  });

  it('ACTIVE mode: the candidate draws the forecast - earlier absorption is lower, the delayed part keeps rising after +2 h - and the incumbent is the shadow', async () => {
    const rig = makeRig({ glucose: 130, baseline: () => 130 });
    await setTestTherapy(rig);
    const id = await scan(rig, pizza());
    await confirmWithNoInsulin(rig, id, nowSec() - 30);
    setMode('shadow');
    const legacy = ok(await rig.forecast.run());
    setMode('active');
    const cand = ok(await rig.forecast.run());
    expect(cand.models.eventLayer).toBe('meal-aware-0.3');
    expect(at(cand, 60).adjusted).toBeLessThan(at(legacy, 60).adjusted - 5); // slower early rise
    expect(at(cand, 120).adjusted).toBeLessThan(at(legacy, 120).adjusted);
    const rise = (f: ForecastOkDisplay) => at(f, 180).adjusted - at(f, 120).adjusted;
    expect(rise(cand)).toBeGreaterThan(rise(legacy)); // the delayed component is still acting at +2..3 h
    expect(cand.notes.join(' ')).toMatch(/estimated from the photo analysis/);
    for (const p of cand.points) for (const v of [p.adjusted, p.low, p.high]) expect(Number.isFinite(v)).toBe(true);

    const versions = (await rig.db.query<{ v: string }>('SELECT DISTINCT model_version AS v FROM predictions WHERE user_id = $1 ORDER BY 1', [rig.userId])).rows.map((r) => r.v);
    expect(versions).toContain('meal-aware-0.3+direct_120');
    expect(versions).toContain('meal-aware-0.1-shadow+direct_120');

    // reproducibility: the stored run holds the features AND the resolved profile, and replaying it gives the stored forecast
    const run = (
      await rig.db.query<{ input_snapshot: { inputs: RunInputs }; trajectory: { minutes: number; adjusted: number }[] }>(
        "SELECT input_snapshot, trajectory FROM forecast_runs WHERE user_id = $1 AND layer_version = 'meal-aware-0.3' ORDER BY created_at DESC LIMIT 1",
        [rig.userId],
      )
    ).rows[0]!;
    const m = run.input_snapshot.inputs.meals[0]!;
    expect(m.absorptionFeatures).toMatchObject({ aiClass: 'slow_delayed', aiConfidence: 'medium', fatG: 45, proteinG: 35, giEstimate: 65, giConfidence: 'medium' });
    expect(m.absorption).toMatchObject({ version: 'absorption-v3' });
    expect(m.absorption!.source).toContain('class+macros');
    expect(m.absorption!.phi).toBeGreaterThan(0.3);
    const replay = computeRun(run.input_snapshot.inputs);
    expect(replay.points.map((p) => p.adjusted)).toEqual(run.trajectory.map((p) => p.adjusted));
  });

  it('older meals and manual meals behave exactly as before in ACTIVE mode, and create no shadow rows', async () => {
    const rig = makeRig({ glucose: 130, baseline: () => 130 });
    await setTestTherapy(rig);
    await rig.api.addMeal({ clientId: 'manual-meal-0001', eatenAt: iso(nowSec() - 300), carbsG: 50 });
    await rig.api.addInsulin({ clientId: 'manual-none-0001', administeredAt: iso(nowSec() - 300), kind: 'bolus', confirmation: 'confirmed', unitsAdministered: 0, source: 'manual' });
    setMode('shadow');
    const a = ok(await rig.forecast.run());
    setMode('active');
    const b = ok(await rig.forecast.run());
    expect(b.points.map((p) => [p.adjusted, p.low, p.high])).toEqual(a.points.map((p) => [p.adjusted, p.low, p.high]));
    expect(await count(rig, "SELECT COUNT(*) AS n FROM predictions WHERE user_id = $1 AND model_version LIKE '%-shadow+%'", [rig.userId])).toBe(0);
  });

  it('a speed class the person chooses outranks the model; editing it is recorded as the person\'s choice', async () => {
    const rig = makeRig({ glucose: 130, baseline: () => 130 });
    await setTestTherapy(rig);
    const id = await scan(rig, pizza());
    await confirmWithNoInsulin(rig, id, nowSec() - 30);
    setMode('active');
    const before = ok(await rig.forecast.run());
    const edited = await rig.api.editMeal(id, { absorptionClass: 'fast' });
    expect(edited.result).toBe('updated');
    expect((await rig.db.query('SELECT absorption_class_user FROM meal_events WHERE meal_id = $1', [id])).rows[0]).toEqual({ absorption_class_user: true });
    const after = ok(await rig.forecast.run());
    const run = (await rig.db.query<{ input_snapshot: { inputs: RunInputs } }>("SELECT input_snapshot FROM forecast_runs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1", [rig.userId])).rows[0]!;
    expect(run.input_snapshot.inputs.meals[0]!.absorption).toMatchObject({ source: 'user_class', phi: 0, tauFastMin: 20 });
    expect(at(after, 60).adjusted).toBeGreaterThan(at(before, 60).adjusted); // "fast" absorbs earlier than the model's slow/delayed profile
  });

  it('the preview of a scanned draft uses the same profile and still saves nothing', async () => {
    setMode('active');
    const rig = makeRig({ glucose: 130, baseline: () => 130 });
    await setTestTherapy(rig);
    const id = await scan(rig, pizza());
    const runs = await count(rig, 'SELECT COUNT(*) AS n FROM forecast_runs WHERE user_id = $1', [rig.userId]);
    const p = ok(await rig.forecast.preview({ mealId: id }));
    expect(p.preview).toBe(true);
    expect(p.models.eventLayer).toBe('meal-aware-0.3');
    setMode('shadow');
    const q = ok(await rig.forecast.preview({ mealId: id }));
    expect(at(p, 60).adjusted).toBeLessThan(at(q, 60).adjusted);
    expect(await count(rig, 'SELECT COUNT(*) AS n FROM forecast_runs WHERE user_id = $1', [rig.userId])).toBe(runs);
  });

  describe('scored comparison in a constructed world (verifies the pipeline and the arithmetic, not accuracy)', () => {
    const TM = nowSec() - 6 * 3600;
    const features = { aiClass: 'slow_delayed' as const, aiConfidence: 'medium' as const, fatG: 45, proteinG: 35, fiberG: 3 };
    const truthProfile = resolveAbsorptionProfile({ legacyClass: 'medium', legacyClassIsUserSet: false, giEstimate: 65, giConfidence: 'medium', ...features }, 40);
    const truth = (t: number): number => 120 + 5 * CARBS * profileCumulative((t - TM) / 60, truthProfile); // CSF = 50 / 10

    async function build(): Promise<Rig> {
      setMode('shadow');
      const rig = makeRig();
      await setTestTherapy(rig, 10, 50);
      const id = await scan(rig, pizza(), iso(TM));
      await confirmWithNoInsulin(rig, id, TM);
      for (let k = 0; k < 19; k += 1) {
        const a = TM + k * 300;
        rig.fake.response = okGlucose(a, truth(a), () => truth(a)); // the glucose-only baseline is blind to the meal
        await rig.forecast.run({ nowSec: a + 120 });
      }
      const readings = [] as { time: string; value: number }[];
      for (let t = TM - 600; t <= nowSec() - 2 * 3600; t += 300) readings.push({ time: iso(t), value: Math.round(truth(t) * 10) / 10 });
      await rig.ingest.recordReadings(readings);
      return rig;
    }

    it('shadow forecasts are scored against the shown forecast on the same anchors; in this world the delayed profile is closer', async () => {
      const rig = await build();
      const rows = await rig.personalization.absorptionShadowComparison(rig.userId);
      expect(rows.length).toBeGreaterThan(0);
      const h120 = rows.find((r) => r.horizonMin === 120)!;
      expect(h120).toMatchObject({ shownModel: 'meal-aware-0.1+direct_120', shadowModel: 'meal-aware-0.3-shadow+direct_120' });
      expect(h120.n).toBeGreaterThan(5);
      expect(h120.maeShadow).toBeLessThan(h120.maeShown); // truth was generated with the delayed profile
      for (const r of rows) for (const v of [r.maeShown, r.maeShadow, r.rmseShown, r.rmseShadow, r.coverageShown, r.coverageShadow]) expect(Number.isFinite(v)).toBe(true);
    });

    it('shadow predictions never enter the evidence, the performance snapshots or the parameter learning', async () => {
      const rig = await build();
      const mainScored = await count(
        rig,
        "SELECT COUNT(*) AS n FROM predictions p JOIN prediction_outcomes o USING (prediction_id) WHERE p.user_id = $1 AND p.horizon_min = 60 AND p.model_version = 'meal-aware-0.1+direct_120' AND p.feature_config <> 'glucose_only'",
        [rig.userId],
      );
      const shadowScored = await count(
        rig,
        "SELECT COUNT(*) AS n FROM predictions p JOIN prediction_outcomes o USING (prediction_id) WHERE p.user_id = $1 AND p.horizon_min = 60 AND p.model_version LIKE '%-shadow+%'",
        [rig.userId],
      );
      expect(shadowScored).toBeGreaterThan(0);
      const cmp = await rig.personalization.compareBaselineVsAdjusted(rig.userId);
      expect(cmp.find((c) => c.horizonMin === 60)!.n).toBe(mainScored); // shadow rows are not counted
      const { examples } = await rig.personalization.eligibleExamples(rig.userId);
      expect(examples.length).toBeLessThanOrEqual(mainScored * 2);
    });
  });
});
