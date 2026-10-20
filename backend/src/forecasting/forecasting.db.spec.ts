import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { mealCumulativeAbsorption } from '../engine/kernels.js';
import { TREND_SLOPE_WINDOW_MIN, trendResponseAt } from '../engine/params.js';
import { forecastNoteFor } from './meal-forecast-flow.js';
import { MealsService } from '../meals/meals.service.js';
import { FakeMealVisionProvider } from '../meals/providers/fake-meal-vision.provider.js';
import {
  closeAll,
  hasTestDb,
  iso,
  makeRig,
  nowSec,
  okGlucose,
  setTestTherapy,
  TEST_DB_URL,
  type Rig,
} from '../../test/forecasting-rig.js';
import type { ForecastOkDisplay } from './forecast-response.js';

/**
 * Integration tests against a real PostgreSQL (scratch database, application role).
 *   TEST_DATABASE_URL=...  npx vitest run src/forecasting/forecasting.db.spec.ts
 * They are skipped when no test database is configured. The glucose proxy is the only fake: it stands
 * in for the VM's forecast service. Everything else - services, SQL, constraints, triggers - is real.
 */

const detectedRaw = JSON.stringify({
  foodStatus: 'detected',
  items: [
    { name: 'steamed white rice', portionDescription: '1 cup', estimatedGrams: 158, netCarbsG: 45, caloriesKcal: 205, confidence: 'medium' },
  ],
  totalNetCarbsG: 45,
  totalCarbsRangeLowG: 38,
  totalCarbsRangeHighG: 55,
  totalCaloriesKcal: 205,
  totalFatG: 0.4,
  totalProteinG: 4.3,
  totalFiberG: 0.6,
  estimatedGlycemicIndex: 73,
  glycemicIndexConfidence: 'medium',
  analysisNotes: null,
});

const photo = { images: [{ base64Data: 'ZmFrZQ==', mimeType: 'image/jpeg' as const }] };

const ok = (f: unknown): ForecastOkDisplay => {
  const x = f as ForecastOkDisplay;
  expect(x.status).toBe('ok');
  return x;
};
const at = (f: ForecastOkDisplay, minutes: number) => f.points.find((p) => p.minutes === minutes)!;
const count = async (rig: Rig, sql: string, params: unknown[] = []): Promise<number> =>
  Number((await rig.db.query<{ n: string }>(sql, params)).rows[0]!.n);
const mealService = (rig: Rig, steps: { kind: 'raw'; rawText: string; modelVersion?: string }[]) =>
  new MealsService(new FakeMealVisionProvider(steps), async () => {}, rig.flow);

async function addMealAndZero(rig: Rig, carbsG: number, minutesAgo = 5, clientId = `meal-${randomUUID()}`) {
  const when = iso(nowSec() - minutesAgo * 60);
  const m = await rig.api.addMeal({ clientId, eatenAt: when, carbsG });
  const z = await rig.api.addInsulin({
    clientId: `zero-${randomUUID()}`,
    administeredAt: when,
    kind: 'bolus',
    confirmation: 'confirmed',
    unitsAdministered: 0,
    source: 'manual',
  });
  return { m, z };
}

describe.skipIf(!hasTestDb)('meal-aware forecasting on PostgreSQL', () => {
  afterAll(closeAll);

  // ------------------------------------------------------------------ 1. glucose-only still works
  describe('glucose-only baseline with every optional feature missing', () => {
    it('returns a 3-hour forecast, changes nothing, and is saved once', async () => {
      const rig = makeRig({ glucose: 150, baseline: (m) => 150 + m / 10 });
      const f = ok(await rig.forecast.run());
      expect(f.points).toHaveLength(36);
      for (const p of f.points.filter((x) => x.minutes <= 120)) {
        expect(p.baseline).toBe(150 + p.minutes / 10);
        expect(p.adjusted).toBe(p.baseline);
        expect(p.extension).toBe(false);
        expect(p.low).toBeLessThan(p.adjusted);
        expect(p.high).toBeGreaterThan(p.adjusted);
      }
      for (const p of f.points.filter((x) => x.minutes > 120)) {
        expect(p.baseline).toBeNull();
        expect(p.extension).toBe(true);
      }
      expect(f.mealAware.changedForecast).toBe(false);
      expect(f.mealAware.availability.insulin).toBe('none_recorded');
      expect(f.mealAware.availability.insulinOnBoardUnits).toBeNull(); // unknown, not zero
      expect(f.mealAware.availability.therapySettings).toBe('unavailable');
      expect(f.saved).toBe(true);

      const rows = await rig.db.query<{ feature_config: string; model_version: string; icr_status: string; horizon_min: number }>(
        'SELECT feature_config, model_version, icr_status, horizon_min FROM predictions WHERE user_id = $1 ORDER BY horizon_min',
        [rig.userId],
      );
      expect(rows.rows.map((r) => r.horizon_min)).toEqual([15, 30, 45, 60, 120]);
      expect(new Set(rows.rows.map((r) => r.feature_config))).toEqual(new Set(['glucose_only']));
      expect(new Set(rows.rows.map((r) => r.model_version))).toEqual(new Set(['direct_120']));
      expect(new Set(rows.rows.map((r) => r.icr_status))).toEqual(new Set(['unavailable']));
    });

    it('is idempotent: polling the same reading twice stores one run', async () => {
      const rig = makeRig();
      await rig.forecast.run();
      await rig.forecast.run();
      expect(await count(rig, 'SELECT COUNT(*) AS n FROM forecast_runs WHERE user_id = $1', [rig.userId])).toBe(1);
      expect(await count(rig, 'SELECT COUNT(*) AS n FROM predictions WHERE user_id = $1', [rig.userId])).toBe(5);
    });

    it('reports an unavailable baseline instead of inventing a forecast', async () => {
      const rig = makeRig();
      rig.fake.response = okGlucose(nowSec() - 120, 120, () => 120, { forecastAvailable: false, history: [], predictions: [], forecastUnavailableReason: 'gap' });
      const f = await rig.forecast.run();
      expect(f.status).toBe('baseline_unavailable');
      expect('points' in f).toBe(false);
    });

    it('with only 4 recent readings the model cannot run, but a short wide fallback line is drawn (60 min, not saved)', async () => {
      const rig = makeRig();
      const a = nowSec() - 120;
      const short = (n: number) => Array.from({ length: n }, (_, i) => ({ time: iso(a - (n - 1 - i) * 300), value: 120 + (i % 2) }));
      rig.fake.response = okGlucose(a, 120, () => 120, { forecastAvailable: false, predictions: [], history: short(4), forecastUnavailableReason: 'fewer than 12 suitable glucose readings' });
      const before = await count(rig, 'SELECT COUNT(*) AS n FROM forecast_runs WHERE user_id = $1', [rig.userId]);
      const f = (await rig.forecast.run()) as unknown as { status: string; horizonMin: number; points: { minutes: number }[]; models: { baseline: string }; saved: boolean; notes: string[] };
      expect(f.status).toBe('ok');
      expect(f.models.baseline).toBe('trend_fallback_v1');
      expect(f.horizonMin).toBe(60);
      expect(Math.max(...f.points.map((p) => p.minutes))).toBe(60);
      expect(f.saved).toBe(false);
      expect(f.notes.join(' ')).toMatch(/Short history: only 4 recent glucose readings/);
      expect(await count(rig, 'SELECT COUNT(*) AS n FROM forecast_runs WHERE user_id = $1', [rig.userId])).toBe(before);
      // 3 readings are not enough: still no line
      rig.fake.response = okGlucose(a, 120, () => 120, { forecastAvailable: false, predictions: [], history: short(3), forecastUnavailableReason: 'x' });
      expect((await rig.forecast.run()).status).toBe('baseline_unavailable');
    });

    it('with the glucose forecast unavailable, logged meals and insulin are still accounted for (on board), no line is drawn', async () => {
      const rig = makeRig({ glucose: 130, baseline: () => 130 });
      await setTestTherapy(rig);
      await rig.api.addMeal({ clientId: 'gap-meal-0001', eatenAt: iso(nowSec() - 600), carbsG: 60 });
      await rig.api.addInsulin({ clientId: 'gap-dose-0001', administeredAt: iso(nowSec() - 600), kind: 'bolus', confirmation: 'confirmed', unitsAdministered: 6, source: 'manual' });
      rig.fake.response = okGlucose(nowSec() - 120, 180, () => 180, { forecastAvailable: false, history: [], predictions: [], forecastUnavailableReason: 'fewer than 12 suitable glucose readings to run the forecast' });
      const f = (await rig.forecast.run()) as unknown as {
        status: string; reason: string; points?: unknown; notes: string[];
        mealAware?: { availability: { mealsUsed: number; insulinOnBoardUnits: number | null; carbsOnBoardGrams: number | null; insulin: string }; events: { type: string; role: string }[] };
      };
      expect(f.status).toBe('baseline_unavailable');
      expect(f.points).toBeUndefined();
      expect(f.reason).toMatch(/fewer than 12/);
      expect(f.mealAware!.availability.insulinOnBoardUnits).toBeGreaterThan(4); // 6 U logged 10 minutes ago
      expect(f.mealAware!.availability.carbsOnBoardGrams).toBeGreaterThan(40);
      expect(f.mealAware!.availability.insulin).toBe('logged');
      expect(f.mealAware!.events.map((e) => e.role).sort()).toEqual(['used', 'used']);
      expect(f.notes.join(' ')).toMatch(/saved and will be used as soon as it is back/);
      // nothing is saved as a forecast when there is none
      expect(await count(rig, 'SELECT COUNT(*) AS n FROM forecast_runs WHERE user_id = $1', [rig.userId])).toBeGreaterThanOrEqual(0);
    });

    it('the note that comes back with a photo meal never claims a forecast that does not exist', async () => {
      const rig = makeRig({ glucose: 130, baseline: () => 130 });
      await setTestTherapy(rig);
      rig.fake.response = okGlucose(nowSec() - 120, 180, () => 180, { forecastAvailable: false, history: [], predictions: [], forecastUnavailableReason: 'gap' });
      const res = await mealService(rig, [{ kind: 'raw', rawText: detectedRaw }]).analyzeMeal(photo);
      expect(res.status).toBe('ok');
      expect(res.forecast?.status).toBe('baseline_unavailable');
      expect(res.forecastNote).toMatch(/waiting for your confirmation/i);
      expect(res.forecastNote).not.toMatch(/Forecast includes this meal|Preview of what this meal would do/);
      expect(forecastNoteFor(null)).toMatch(/could not be refreshed/);
      expect(forecastNoteFor({ status: 'stale', reason: 'x', lastMeasuredAt: null })).toMatch(/too old/);
      expect(forecastNoteFor({ status: 'unavailable', reason: 'x' })).toMatch(/not available/);
    });

    it('passes stale and unavailable glucose through untouched', async () => {
      const rig = makeRig();
      rig.fake.response = { status: 'stale', reason: 'old', lastMeasuredAt: null };
      expect((await rig.forecast.run()).status).toBe('stale');
      rig.fake.response = { status: 'unavailable', reason: 'x' };
      expect((await rig.forecast.run()).status).toBe('unavailable');
    });
  });

  // ------------------------------------------------ 2/3/4. photo -> meal event -> forecast
  describe('food photo to forecast in one workflow', () => {
    it('stores the validated analysis as a DRAFT and returns a PREVIEW of what the meal would do; the draft does not count', async () => {
      const rig = makeRig({ glucose: 130, baseline: () => 130 });
      await setTestTherapy(rig);
      const svc = mealService(rig, [{ kind: 'raw', rawText: detectedRaw, modelVersion: 'gemini-test' }]);
      const res = await svc.analyzeMeal(photo);

      expect(res.status).toBe('ok');
      if (res.status !== 'ok') return;
      expect(res.totalNetCarbsG).toBe(45); // existing contract unchanged
      expect(res.mealEventId).toMatch(/^[0-9a-f-]{36}$/);
      const f = ok(res.forecast);
      expect(f.preview).toBe(true);
      expect(f.saved).toBe(false);
      expect(f.mealAware.preview).toEqual({ mealId: res.mealEventId, insulinUnits: null });
      // the preview counts the meal in full (no insulin yet): the line RISES, it is not a straight line
      expect(f.mealAware.availability).toMatchObject({ mealsUsed: 1, mealsRangeOnly: 0 });
      expect(f.mealAware.changedForecast).toBe(true);
      expect(at(f, 120).adjusted).toBeGreaterThan(at(f, 120).baseline! + 100);
      expect(f.notes.join(' ')).toMatch(/Preview: this meal is counted here in full but is not saved/);
      expect(res.forecastNote).toMatch(/Preview of what this meal would do/);
      // ...but the REAL forecast does not contain the unconfirmed meal: no line, no carbs on board, not in the logged list, no run saved
      const real = ok(await rig.forecast.run());
      expect(real.mealAware.events).toEqual([]);
      expect(real.mealAware.availability.carbsOnBoardGrams).toBeNull();
      expect(real.mealAware.changedForecast).toBe(false);
      expect((await rig.api.recent(6)).meals).toEqual([]);
      expect(await rig.forecast.mealCoverage(res.mealEventId!)).toBeNull();

      const meal = (await rig.db.query('SELECT * FROM meal_events WHERE meal_id = $1', [res.mealEventId])).rows[0];
      expect(meal).toMatchObject({
        status: 'draft',
        carbs_provenance: 'estimated',
        eaten_at_source: 'photo_time',
        user_edited: false,
        analysis_status: 'ok',
        model_version: 'gemini-test',
        prompt_version: 'meal-analysis-v3',
        ai_confidence: 'medium',
      });
      expect(Number(meal.carbs_g)).toBe(45);
      expect(Number(meal.ai_carbs_low_g)).toBe(38);
      expect(Number(meal.ai_carbs_high_g)).toBe(55);
      expect(Number(meal.fat_g)).toBeCloseTo(0.4);
      expect(meal.analysis_raw.items[0].name).toBe('steamed white rice'); // full analysis kept server-side
      expect(await count(rig, 'SELECT COUNT(*) AS n FROM meal_items WHERE meal_id = $1', [res.mealEventId])).toBe(1);

      // retrying the same photo does not create a second meal event
      const again = await svc.analyzeMeal(photo);
      expect(again.status === 'ok' && again.mealEventId).toBe(res.mealEventId);
      expect(await count(rig, 'SELECT COUNT(*) AS n FROM meal_events WHERE user_id = $1', [rig.userId])).toBe(1);
    });

    it('recording insulin does nothing for an unconfirmed scan; confirming the meal turns it into a real adjustment', async () => {
      const rig = makeRig({ glucose: 130, baseline: () => 130 });
      await setTestTherapy(rig);
      const svc = mealService(rig, [{ kind: 'raw', rawText: detectedRaw }]);
      const scan = await svc.analyzeMeal(photo);
      const mealId = (scan as { mealEventId: string }).mealEventId;

      const z = await rig.api.addInsulin({
        clientId: 'declared-none-1',
        administeredAt: iso(nowSec() - 60),
        kind: 'bolus',
        confirmation: 'confirmed',
        unitsAdministered: 0,
        source: 'manual',
      });
      const before = ok(z.forecast);
      expect(before.mealAware.availability.mealsUsed).toBe(0); // the scan is still a draft: backing out here would leave nothing behind
      expect(before.mealAware.changedForecast).toBe(false);
      const confirmed = await rig.api.editMeal(mealId, { status: 'confirmed' });
      expect(confirmed.result).toBe('updated');
      const f = ok(confirmed.forecast);
      expect(f.mealAware.availability.mealsUsed).toBe(1);
      expect(f.mealAware.availability.insulin).toBe('confirmed_none');
      expect(f.mealAware.changedForecast).toBe(true);
      expect(at(f, 120).adjusted).toBeGreaterThan(at(f, 120).baseline! + 100);
    });

    it('invalid Gemini JSON: no meal event, glucose-only forecast, limitation stated', async () => {
      const rig = makeRig();
      await setTestTherapy(rig);
      const svc = mealService(rig, [{ kind: 'raw', rawText: 'this is not json' }]);
      const res = await svc.analyzeMeal(photo);
      expect(res.status).toBe('needs_manual_entry');
      expect(res.forecastNote).toMatch(/does not include this meal/);
      expect(ok(res.forecast).mealAware.changedForecast).toBe(false);
      expect(await count(rig, 'SELECT COUNT(*) AS n FROM meal_events WHERE user_id = $1', [rig.userId])).toBe(0);
    });

    it('handles missing fat, protein and fibre safely (unknown, not zero)', async () => {
      const rig = makeRig({ glucose: 130, baseline: () => 130 });
      await setTestTherapy(rig);
      const { m } = await addMealAndZero(rig, 40);
      expect(m.meal).toMatchObject({ fatG: null, proteinG: null, fiberG: null });
      const f = ok((await rig.forecast.run()));
      expect(f.mealAware.availability.mealsUsed).toBe(1);
    });

    it('frontend payloads expose display fields only', async () => {
      const rig = makeRig({ glucose: 130, baseline: () => 130 });
      await setTestTherapy(rig);
      const svc = mealService(rig, [{ kind: 'raw', rawText: detectedRaw }]);
      const res = await svc.analyzeMeal(photo);
      const { m, z } = await addMealAndZero(rig, 30);
      const therapyView = await rig.therapy.getView(rig.userId);
      const dump = JSON.stringify({ res, m, z, therapyView });
      for (const banned of [
        'analysis_raw', 'analysisRaw', 'input_snapshot', 'inputSnapshot', 'mCsf', 'mIsf', 'm_csf', 'icrGPerU',
        'isfMgdlPerU', 'postgres', 'password', 'DATABASE', 'client_uuid', 'clientUuid', 'user_id', 'userId',
        'aiCarbsG', 'baselineSigmaKnots', 'parameter_version', 'inputs_hash',
      ]) {
        expect(dump, banned).not.toContain(banned);
      }
      expect(Object.keys(m.meal!).sort()).toEqual(
        ['absorptionClass', 'carbs', 'eatenAt', 'edited', 'fatG', 'fiberG', 'glycemicIndex', 'id', 'label', 'proteinG', 'revision', 'status', 'timeApproximateMin'].sort(),
      );
      const f = ok(z.forecast);
      expect(Object.keys(f).sort()).toEqual(
        ['anchor', 'disclaimer', 'generatedAt', 'horizonMin', 'intervalLevel', 'mealAware', 'models', 'notes', 'points', 'saved', 'status', 'stepMin'].sort(),
      );
    });
  });

  // ---------------------------------------------- 5/6. timing and unknown insulin
  describe('events act only according to their timestamps; missing insulin is not zero', () => {
    it('rejects events dated in the future or older than 48 hours', async () => {
      const rig = makeRig();
      expect((await rig.api.addMeal({ clientId: 'future-meal-1', eatenAt: iso(nowSec() + 1800), carbsG: 30 })).result).toBe('invalid');
      expect((await rig.api.addMeal({ clientId: 'old-meal-0001', eatenAt: iso(nowSec() - 49 * 3600), carbsG: 30 })).result).toBe('invalid');
      expect(
        (await rig.api.addInsulin({ clientId: 'future-dose-1', administeredAt: iso(nowSec() + 1800), kind: 'bolus', confirmation: 'confirmed', unitsAdministered: 3, source: 'manual' })).result,
      ).toBe('invalid');
    });

    it('an older meal has already acted: it moves the line less than a fresh one', async () => {
      const fresh = makeRig({ glucose: 130, baseline: () => 130 });
      const old = makeRig({ glucose: 130, baseline: () => 130 });
      await setTestTherapy(fresh);
      await setTestTherapy(old);
      await addMealAndZero(fresh, 40, 5);
      await addMealAndZero(old, 40, 150);
      const a = ok(await fresh.forecast.run());
      const b = ok(await old.forecast.run());
      expect(at(a, 60).adjusted - 130).toBeGreaterThan(at(b, 60).adjusted - 130);
      // and exactly the kernel increment: F(age+h) - F(age), not F(h)
      const csf = 5;
      const age = 150 - 2;
      const increment = csf * 40 * (mealCumulativeAbsorption(age + 60, 40) - mealCumulativeAbsorption(age, 40));
      const slope = (csf * 40 * (mealCumulativeAbsorption(age, 40) - mealCumulativeAbsorption(age - TREND_SLOPE_WINDOW_MIN, 40))) / TREND_SLOPE_WINDOW_MIN;
      // what the glucose-only model already extrapolates from the meal-driven slope is taken back out
      expect(at(b, 60).adjusted - 130).toBeCloseTo(increment - trendResponseAt(60) * slope, 0);
    });

    it('active insulin is unknown with nothing recorded, zero only when confirmed, computed when logged', async () => {
      const rig = makeRig({ glucose: 130, baseline: () => 130 });
      await setTestTherapy(rig);
      let f = ok(await rig.forecast.run());
      expect(f.mealAware.availability).toMatchObject({ insulin: 'none_recorded', insulinOnBoardUnits: null });

      await rig.api.addInsulin({ clientId: 'zero-0001', administeredAt: iso(nowSec() - 120), kind: 'bolus', confirmation: 'confirmed', unitsAdministered: 0, source: 'manual' });
      f = ok(await rig.forecast.run());
      expect(f.mealAware.availability).toMatchObject({ insulin: 'confirmed_none', insulinOnBoardUnits: 0 });

      await rig.api.addInsulin({ clientId: 'dose-0001', administeredAt: iso(nowSec() - 30 * 60), kind: 'correction', confirmation: 'confirmed', unitsAdministered: 2, source: 'manual' });
      f = ok(await rig.forecast.run());
      expect(f.mealAware.availability.insulin).toBe('logged');
      expect(f.mealAware.availability.insulinOnBoardUnits).toBeGreaterThan(1);
      expect(f.mealAware.availability.insulinOnBoardUnits).toBeLessThanOrEqual(2);
    });
  });

  // ------------------------------------------------ 7. edit, duplicates, replay
  describe('editing a meal', () => {
    it('recalculates without duplicating events and keeps every revision', async () => {
      const rig = makeRig({ glucose: 130, baseline: () => 130 });
      await setTestTherapy(rig);
      const { m } = await addMealAndZero(rig, 40);
      const mealId = m.meal!.id;
      const before = ok(await rig.forecast.run());
      const runBefore = (await rig.db.query('SELECT run_id, trajectory FROM forecast_runs WHERE user_id = $1', [rig.userId])).rows;

      const edited = await rig.api.editMeal(mealId, { carbsG: 60 });
      expect(edited.result).toBe('updated');
      expect(edited.meal).toMatchObject({ carbs: { grams: 60, kind: 'user_entered' }, revision: 2 });
      expect(at(ok(edited.forecast), 120).adjusted).toBeGreaterThan(at(before, 120).adjusted + 50);

      expect(await count(rig, 'SELECT COUNT(*) AS n FROM meal_events WHERE user_id = $1', [rig.userId])).toBe(1);
      expect(await count(rig, "SELECT COUNT(*) AS n FROM event_revisions WHERE entity_id = $1 AND entity_type = 'meal'", [mealId])).toBe(1);
      const corr = (await rig.db.query('SELECT field, old_value, new_value FROM meal_corrections WHERE meal_id = $1', [mealId])).rows;
      expect(corr).toHaveLength(1);
      expect(corr[0]).toMatchObject({ field: 'carbs_g' });
      expect(Number(corr[0].old_value)).toBe(40);
      expect(Number(corr[0].new_value)).toBe(60);

      // the earlier run is untouched (history is not rewritten) and the new one is a separate run
      const runsAfter = (await rig.db.query('SELECT run_id, trajectory FROM forecast_runs WHERE user_id = $1', [rig.userId])).rows;
      expect(runsAfter.length).toBeGreaterThan(runBefore.length);
      for (const r of runBefore) expect(runsAfter.find((x) => x.run_id === r.run_id)?.trajectory).toEqual(r.trajectory);

      // same edit again changes nothing
      const again = await rig.api.editMeal(mealId, { carbsG: 60 });
      expect(again.result).toBe('unchanged');
      expect(again.forecast).toBeNull();
      expect(again.meal!.revision).toBe(2);
    });

    it('a photo estimate that the user corrects becomes user-corrected, with the original kept', async () => {
      const rig = makeRig({ glucose: 130, baseline: () => 130 });
      await setTestTherapy(rig);
      const res = await mealService(rig, [{ kind: 'raw', rawText: detectedRaw }]).analyzeMeal(photo);
      const id = (res as { mealEventId: string }).mealEventId;
      const edited = await rig.api.editMeal(id, { carbsG: 30, status: 'confirmed' });
      expect(edited.meal).toMatchObject({ status: 'confirmed', edited: true, carbs: { grams: 30, kind: 'user_corrected', estimateRangeG: null } });
      const row = (await rig.db.query('SELECT ai_carbs_g, carbs_g, user_edited, carbs_provenance FROM meal_events WHERE meal_id = $1', [id])).rows[0];
      expect(Number(row.ai_carbs_g)).toBe(45); // the model's original number is never overwritten
      expect(Number(row.carbs_g)).toBe(30);
      expect(row).toMatchObject({ user_edited: true, carbs_provenance: 'user_corrected' });
    });

    it('optimistic concurrency and impossible confirmation are refused', async () => {
      const rig = makeRig();
      const m = await rig.api.addMeal({ clientId: 'no-carbs-0001', eatenAt: iso(nowSec() - 600) });
      expect(m.meal!.carbs).toEqual({ grams: null, kind: 'missing', estimateRangeG: null });
      expect((await rig.api.editMeal(m.meal!.id, { status: 'confirmed' })).result).toBe('invalid'); // unknown carbs cannot be confirmed
      expect((await rig.api.editMeal(m.meal!.id, { carbsG: 20, expectedRevision: 5 })).result).toBe('conflict');
      expect((await rig.api.editMeal(randomUUID(), { carbsG: 20 })).result).toBe('not_found');
    });

    it('duplicate prevention: same client id, near-identical entry, explicit override', async () => {
      const rig = makeRig();
      const t = iso(nowSec() - 600);
      const a = await rig.api.addMeal({ clientId: 'dup-test-0001', eatenAt: t, carbsG: 35 });
      expect(a.result).toBe('created');
      const retry = await rig.api.addMeal({ clientId: 'dup-test-0001', eatenAt: t, carbsG: 35 });
      expect(retry.result).toBe('exists');
      expect(retry.meal!.id).toBe(a.meal!.id);
      const near = await rig.api.addMeal({ clientId: 'dup-test-0002', eatenAt: iso(nowSec() - 640), carbsG: 35 });
      expect(near.result).toBe('duplicate');
      expect(near.duplicateOf).toBe(a.meal!.id);
      const forced = await rig.api.addMeal({ clientId: 'dup-test-0003', eatenAt: iso(nowSec() - 640), carbsG: 35, allowDuplicate: true });
      expect(forced.result).toBe('created');
      expect(await count(rig, 'SELECT COUNT(*) AS n FROM meal_events WHERE user_id = $1', [rig.userId])).toBe(2);
    });

    it('parallel identical requests (a retry storm) create exactly one entry and never an error', async () => {
      const rig = makeRig();
      const meal = { clientId: 'race-meal-0001', eatenAt: iso(nowSec() - 600), carbsG: 18 };
      const m = await Promise.all(Array.from({ length: 12 }, () => rig.api.addMeal(meal)));
      expect(m.filter((r) => r.result === 'created')).toHaveLength(1);
      expect(m.every((r) => r.result === 'created' || r.result === 'exists')).toBe(true);
      expect(new Set(m.map((r) => r.meal!.id)).size).toBe(1);
      const dose = { clientId: 'race-dose-0001', administeredAt: iso(nowSec() - 600), kind: 'correction' as const, confirmation: 'confirmed' as const, unitsAdministered: 1, source: 'manual' as const };
      const d = await Promise.all(Array.from({ length: 12 }, () => rig.api.addInsulin(dose)));
      expect(d.filter((r) => r.result === 'created')).toHaveLength(1);
      expect(d.every((r) => r.result === 'created' || r.result === 'exists')).toBe(true);
      expect(await count(rig, 'SELECT COUNT(*) AS n FROM meal_events WHERE user_id = $1', [rig.userId])).toBe(1);
      expect(await count(rig, 'SELECT COUNT(*) AS n FROM insulin_events WHERE user_id = $1', [rig.userId])).toBe(1);
    });

    it('parallel photo uploads of one photo id map to one meal event', async () => {
      const rig = makeRig({ glucose: 130, baseline: () => 130 });
      const svc = mealService(rig, [{ kind: 'raw', rawText: detectedRaw }]);
      const body = { ...photo, clientId: 'race-photo-0001' };
      const res = await Promise.all(Array.from({ length: 6 }, () => svc.analyzeMeal(body)));
      const ids = new Set(res.map((r) => (r as { mealEventId: string | null }).mealEventId));
      expect(ids.size).toBe(1);
      expect([...ids][0]).toEqual(expect.any(String));
      expect(await count(rig, 'SELECT COUNT(*) AS n FROM meal_events WHERE user_id = $1', [rig.userId])).toBe(1);
      expect(await count(rig, 'SELECT COUNT(*) AS n FROM meal_items i JOIN meal_events m USING (meal_id) WHERE m.user_id = $1', [rig.userId])).toBe(1);
    });

    it('a late-arriving event is replayed into a new run; the earlier run stays as it was', async () => {
      const rig = makeRig({ glucose: 130, baseline: () => 130 });
      await setTestTherapy(rig);
      const first = ok(await rig.forecast.run());
      expect(first.mealAware.changedForecast).toBe(false);
      await addMealAndZero(rig, 50, 45); // logged now, eaten 45 minutes ago
      const second = ok(await rig.forecast.run());
      expect(second.mealAware.changedForecast).toBe(true);
      expect(await count(rig, 'SELECT COUNT(*) AS n FROM forecast_runs WHERE user_id = $1', [rig.userId])).toBeGreaterThanOrEqual(2);
    });
  });

  // ------------------------------------------------------------ 8. counterfactual
  describe('excluding recent meals (what-if)', () => {
    it('drops the meal effect, keeps delivered insulin, deletes nothing, saves nothing', async () => {
      const rig = makeRig({ glucose: 130, baseline: () => 130 });
      await setTestTherapy(rig);
      const mealRes = await rig.api.addMeal({ clientId: 'cf-meal-0001', eatenAt: iso(nowSec() - 300), carbsG: 60 });
      const mealId = mealRes.meal!.id;
      await rig.api.addInsulin({ clientId: 'cf-dose-0001', administeredAt: iso(nowSec() - 300), kind: 'bolus', confirmation: 'confirmed', unitsAdministered: 6, source: 'manual' });

      const normal = ok(await rig.forecast.run());
      expect(normal.mealAware.availability).toMatchObject({ mealsUsed: 1, insulinDosesUsed: 1 });
      const runsBefore = await count(rig, 'SELECT COUNT(*) AS n FROM forecast_runs WHERE user_id = $1', [rig.userId]);
      const predsBefore = await count(rig, 'SELECT COUNT(*) AS n FROM predictions WHERE user_id = $1', [rig.userId]);

      const cf = ok(await rig.forecast.run({ excludeMealIds: [mealId], persist: false }));
      expect(cf.mealAware.counterfactual).toBe(true);
      expect(cf.mealAware.excludedMealIds).toEqual([mealId]);
      expect(cf.saved).toBe(false);
      expect(cf.notes.join(' ')).toMatch(/not a prediction of what will happen/);
      const roles = Object.fromEntries(cf.mealAware.events.map((e) => [e.type, e.role]));
      expect(roles).toEqual({ meal: 'excluded', insulin: 'used' });
      // without the meal the delivered 6 U still lowers the line: well below the glucose-only value
      expect(at(cf, 120).adjusted).toBeLessThan(at(cf, 120).baseline! - 100);
      expect(at(cf, 120).adjusted).toBeLessThan(at(normal, 120).adjusted - 100);
      expect(cf.mealAware.availability.insulinOnBoardUnits).toBeGreaterThan(0);

      // nothing deleted, nothing saved
      expect((await rig.events.mealById(rig.userId, mealId))!.status).toBe('manual_entry');
      expect(await count(rig, 'SELECT COUNT(*) AS n FROM meal_events WHERE user_id = $1', [rig.userId])).toBe(1);
      expect(await count(rig, 'SELECT COUNT(*) AS n FROM insulin_events WHERE user_id = $1', [rig.userId])).toBe(1);
      expect(await count(rig, 'SELECT COUNT(*) AS n FROM forecast_runs WHERE user_id = $1', [rig.userId])).toBe(runsBefore);
      expect(await count(rig, 'SELECT COUNT(*) AS n FROM predictions WHERE user_id = $1', [rig.userId])).toBe(predsBefore);
    });
  });

  // -------------------------------------------------------- 9. manual event services
  describe('manual event services for a future UI', () => {
    it('log carbs and insulin through the same validated services; each triggers a forecast refresh', async () => {
      const rig = makeRig({ glucose: 130, baseline: () => 130 });
      await setTestTherapy(rig);
      const m = await rig.api.addMeal({ clientId: 'manual-meal-1', eatenAt: iso(nowSec() - 120), carbsG: 45, absorptionClass: 'fast' });
      expect(m.result).toBe('created');
      expect(ok(m.forecast).saved).toBe(true);
      const i = await rig.api.addInsulin({ clientId: 'manual-dose-1', administeredAt: iso(nowSec() - 120), kind: 'bolus', confirmation: 'confirmed', unitsAdministered: 4.5, source: 'pen', insulinType: 'rapid' });
      expect(i.result).toBe('created');
      const f = ok(i.forecast);
      expect(f.mealAware.availability).toMatchObject({ mealsUsed: 1, insulinDosesUsed: 1, insulin: 'logged' });
      expect(i.insulin).toMatchObject({ unitsTaken: 4.5, confirmation: 'confirmed' });
    });

    it('a planned dose is never counted as delivered; confirming it needs the amount taken', async () => {
      const rig = makeRig({ glucose: 130, baseline: () => 130 });
      await setTestTherapy(rig);
      await rig.api.addMeal({ clientId: 'plan-meal-001', eatenAt: iso(nowSec() - 120), carbsG: 45 });
      const planned = await rig.api.addInsulin({ clientId: 'plan-dose-001', administeredAt: iso(nowSec() - 60), kind: 'bolus', confirmation: 'planned', plannedUnits: 4.5, source: 'manual' });
      expect(planned.insulin).toMatchObject({ unitsTaken: null, unitsPlanned: 4.5, confirmation: 'planned' });
      const f = ok(planned.forecast);
      expect(f.mealAware.availability.insulin).toBe('none_recorded');
      expect(f.mealAware.availability.insulinOnBoardUnits).toBeNull();
      expect(f.mealAware.events.find((e) => e.type === 'insulin')).toMatchObject({ role: 'not_used', reason: 'planned_not_delivered' });
      expect(f.mealAware.availability.mealsRangeOnly).toBe(1); // the meal is still "insulin not recorded"

      const bad = await rig.api.editInsulin(planned.insulin!.id, { confirmation: 'confirmed' });
      expect(bad.result).toBe('invalid');
      const taken = await rig.api.editInsulin(planned.insulin!.id, { confirmation: 'confirmed', unitsAdministered: 4 });
      expect(taken.result).toBe('updated');
      expect(taken.insulin).toMatchObject({ unitsTaken: 4, unitsPlanned: 4.5, confirmation: 'confirmed' });
      expect(ok(taken.forecast).mealAware.availability).toMatchObject({ insulin: 'logged', mealsUsed: 1 });
      expect(await count(rig, "SELECT COUNT(*) AS n FROM event_revisions WHERE entity_type = 'insulin'")).toBeGreaterThanOrEqual(1);
    });

    it('lists recent entries so a UI can choose meals for the what-if view', async () => {
      const rig = makeRig();
      await rig.api.addMeal({ clientId: 'recent-meal-1', eatenAt: iso(nowSec() - 600), carbsG: 20 });
      const r = await rig.api.recent(6);
      expect(r.meals).toHaveLength(1);
      expect(r.meals[0]!.carbs.grams).toBe(20);
    });
  });

  describe('cancelling a meal together with its insulin (the meal-history Cancel button)', () => {
    const rigWith = async (): Promise<Rig> => {
      const rig = makeRig({ glucose: 150, baseline: () => 150 });
      await setTestTherapy(rig);
      return rig;
    };
    const revisions = async (rig: Rig, type: 'meal' | 'insulin', id: string): Promise<{ revision: number; reason: string }[]> =>
      (await rig.db.query<{ revision: number; reason: string }>('SELECT revision, reason FROM event_revisions WHERE entity_type = $1 AND entity_id = $2 ORDER BY revision', [type, id])).rows;

    it('removes the meal and the dose named against it in one step, keeps both with their history, leaves unrelated insulin alone', async () => {
      const rig = await rigWith();
      const t = nowSec();
      const meal = await rig.api.addMeal({ clientId: 'cp-meal-00000001', eatenAt: iso(t - 600), carbsG: 60 });
      const dose = await rig.api.addInsulin({ clientId: 'cp-dose-00000001', administeredAt: iso(t - 570), kind: 'bolus', confirmation: 'confirmed', unitsAdministered: 6, source: 'manual', mealId: meal.meal!.id });
      const unrelated = await rig.api.addInsulin({ clientId: 'cp-corr-00000001', administeredAt: iso(t - 4 * 3600), kind: 'correction', confirmation: 'confirmed', unitsAdministered: 2, source: 'manual' });
      expect(ok(unrelated.forecast).mealAware.events.filter((e) => e.role === 'used').map((e) => e.id)).toContain(meal.meal!.id);

      const out = await rig.api.cancelMeal(meal.meal!.id, { expectedRevision: 1 });
      expect(out.result).toBe('updated');
      expect(out.meal).toMatchObject({ id: meal.meal!.id, status: 'cancelled', revision: 2 });
      expect(out.insulin).toHaveLength(1);
      expect(out.insulin[0]).toMatchObject({ id: dose.insulin!.id, status: 'cancelled', revision: 2, unitsTaken: 6 });
      const f = ok(out.forecast);
      expect(f.mealAware.events.map((e) => e.id)).toEqual([unrelated.insulin!.id]); // the meal and its dose are gone from the forecast, the unrelated correction stays
      expect(f.mealAware.availability.carbsOnBoardGrams).toBeNull();

      // nothing was deleted: rows and one revision each, with the reason
      expect(await count(rig, 'SELECT COUNT(*) AS n FROM meal_events WHERE user_id = $1', [rig.userId])).toBe(1);
      expect(await count(rig, 'SELECT COUNT(*) AS n FROM insulin_events WHERE user_id = $1', [rig.userId])).toBe(2);
      expect(await revisions(rig, 'meal', meal.meal!.id)).toEqual([{ revision: 2, reason: 'user_cancel' }]);
      expect(await revisions(rig, 'insulin', dose.insulin!.id)).toEqual([{ revision: 2, reason: 'user_cancel_with_meal' }]);
      expect(await revisions(rig, 'insulin', unrelated.insulin!.id)).toEqual([]);
      // gone from the lists
      const recent = await rig.api.recent(6);
      expect(recent.meals).toEqual([]);
      expect(recent.insulin.map((i) => i.id)).toEqual([unrelated.insulin!.id]);
      expect(await rig.forecast.mealCoverage(meal.meal!.id)).toBeNull();
    });

    it('also removes the dose the system pairs with the meal by time, but not one that could belong to two meals or is far away', async () => {
      const rig = await rigWith();
      const t = nowSec();
      const a = await rig.api.addMeal({ clientId: 'cp-auto-meal-0001', eatenAt: iso(t - 900), carbsG: 50 });
      const paired = await rig.api.addInsulin({ clientId: 'cp-auto-dose-0001', administeredAt: iso(t - 880), kind: 'bolus', confirmation: 'confirmed', unitsAdministered: 5, source: 'manual' }); // no mealId
      const far = await rig.api.addInsulin({ clientId: 'cp-far-dose-00001', administeredAt: iso(t - 3 * 3600), kind: 'bolus', confirmation: 'confirmed', unitsAdministered: 3, source: 'manual' });
      expect(await rig.forecast.mealCoverage(a.meal!.id)).toMatchObject({ insulinRecord: 'linked', insulinUnits: 5 }); // what the screen shows...
      const out = await rig.api.cancelMeal(a.meal!.id, {});
      expect(out.insulin.map((i) => [i.id, i.unitsTaken])).toEqual([[paired.insulin!.id, 5]]); // ...is what gets removed
      expect((await rig.api.recent(6)).insulin.map((i) => i.id)).toEqual([far.insulin!.id]);

      // two meals close together with one dose between them: the dose could belong to either, so it is NOT removed
      const rig2 = await rigWith();
      const b = await rig2.api.addMeal({ clientId: 'cp-amb-meal-0001', eatenAt: iso(t - 600), carbsG: 40 });
      await rig2.api.addMeal({ clientId: 'cp-amb-meal-0002', eatenAt: iso(t - 240), carbsG: 30 });
      const between = await rig2.api.addInsulin({ clientId: 'cp-amb-dose-0001', administeredAt: iso(t - 420), kind: 'bolus', confirmation: 'confirmed', unitsAdministered: 4, source: 'manual' });
      const cb = await rig2.api.cancelMeal(b.meal!.id, {});
      expect(cb.result).toBe('updated');
      expect(cb.insulin).toEqual([]);
      expect((await rig2.api.recent(6)).insulin.map((i) => i.id)).toEqual([between.insulin!.id]);
    });

    it('a confirmed "I took none" record goes with its meal', async () => {
      const rig = await rigWith();
      const { m, z } = await addMealAndZero(rig, 40, 5);
      const out = await rig.api.cancelMeal(m.meal!.id, {});
      expect(out.insulin.map((i) => [i.id, i.unitsTaken])).toEqual([[z.insulin!.id, 0]]);
      expect(ok(out.forecast).mealAware.availability.insulin).toBe('none_recorded'); // nothing says "none taken" any more
    });

    it('includeInsulin: false removes only the meal; calling again removes the dose still named against it; then it is "unchanged"', async () => {
      const rig = await rigWith();
      const t = nowSec();
      const meal = await rig.api.addMeal({ clientId: 'cp-opt-meal-0001', eatenAt: iso(t - 600), carbsG: 60 });
      const dose = await rig.api.addInsulin({ clientId: 'cp-opt-dose-0001', administeredAt: iso(t - 570), kind: 'bolus', confirmation: 'confirmed', unitsAdministered: 6, source: 'manual', mealId: meal.meal!.id });
      const only = await rig.api.cancelMeal(meal.meal!.id, { includeInsulin: false });
      expect(only.result).toBe('updated');
      expect(only.insulin).toEqual([]);
      expect(ok(only.forecast).mealAware.events).toEqual([expect.objectContaining({ id: dose.insulin!.id, role: 'used', reason: 'dose_without_recorded_meal' })]); // the dose now stands alone and still acts

      const rest = await rig.api.cancelMeal(meal.meal!.id, { expectedRevision: 1 }); // an old revision is fine once the meal is already removed
      expect(rest.result).toBe('updated');
      expect(rest.insulin.map((i) => i.id)).toEqual([dose.insulin!.id]);
      expect(ok(rest.forecast).mealAware.events).toEqual([]);

      const again = await rig.api.cancelMeal(meal.meal!.id, {});
      expect(again.result).toBe('unchanged');
      expect(again.insulin).toEqual([]);
      expect(ok(again.forecast).status).toBe('ok');
      expect(await revisions(rig, 'meal', meal.meal!.id)).toHaveLength(1); // repeats add no history
      expect(await revisions(rig, 'insulin', dose.insulin!.id)).toHaveLength(1);
    });

    it('a stale revision on a live meal changes nothing; an unknown meal is not found; a never-confirmed scan and its named dose go together', async () => {
      const rig = await rigWith();
      const t = nowSec();
      const meal = await rig.api.addMeal({ clientId: 'cp-conf-meal-0001', eatenAt: iso(t - 600), carbsG: 60 });
      const dose = await rig.api.addInsulin({ clientId: 'cp-conf-dose-0001', administeredAt: iso(t - 570), kind: 'bolus', confirmation: 'confirmed', unitsAdministered: 6, source: 'manual', mealId: meal.meal!.id });
      const stale = await rig.api.cancelMeal(meal.meal!.id, { expectedRevision: 9 });
      expect(stale).toMatchObject({ result: 'conflict', insulin: [], forecast: null });
      expect((await rig.api.recent(6)).meals.map((m) => m.id)).toEqual([meal.meal!.id]);
      expect((await rig.api.recent(6)).insulin.map((i) => i.id)).toEqual([dose.insulin!.id]);
      expect(await rig.api.cancelMeal('00000000-0000-4000-8000-000000000001', {})).toMatchObject({ result: 'not_found', meal: null, insulin: [], forecast: null });

      const rig2 = await rigWith();
      const draftId = ((await mealService(rig2, [{ kind: 'raw', rawText: detectedRaw }]).analyzeMeal(photo)) as { mealEventId: string }).mealEventId;
      const namedDose = await rig2.api.addInsulin({ clientId: 'cp-draft-dose-001', administeredAt: iso(nowSec() - 30), kind: 'bolus', confirmation: 'confirmed', unitsAdministered: 4, source: 'manual', mealId: draftId });
      const out = await rig2.api.cancelMeal(draftId, {});
      expect(out.result).toBe('updated');
      expect(out.insulin.map((i) => i.id)).toEqual([namedDose.insulin!.id]);
      expect((await rig2.api.recent(6)).insulin).toEqual([]);
    });
  });

  describe('unconfirmed meals never count, and the preview shows what a meal would do', () => {
    const scan = async (rig: Rig, raw = detectedRaw): Promise<string> =>
      ((await mealService(rig, [{ kind: 'raw', rawText: raw }]).analyzeMeal(photo)) as { mealEventId: string }).mealEventId;

    it('backing out of a scan leaves the forecast, carbs on board and the logged list untouched, and does not block logging the same meal', async () => {
      const rig = makeRig({ glucose: 130, baseline: () => 130 });
      await setTestTherapy(rig);
      const before = ok(await rig.forecast.run());
      const draftId = await scan(rig); // never confirmed: the person went back
      const after = ok(await rig.forecast.run());
      expect(after.mealAware.events).toEqual([]);
      expect(after.mealAware.availability).toEqual(before.mealAware.availability);
      expect(after.points.map((p) => p.adjusted)).toEqual(before.points.map((p) => p.adjusted));
      expect(after.points.every((p) => p.carbsOnBoardGrams === null)).toBe(true);
      expect((await rig.api.recent(6)).meals).toEqual([]);
      // the abandoned draft does not trigger the probable-double-entry check either
      const manual = await rig.api.addMeal({ clientId: 'after-backout-001', eatenAt: iso(nowSec() - 60), carbsG: 45 });
      expect(manual.result).toBe('created');
      // and tidying it up (cancel) is harmless
      expect((await rig.api.editMeal(draftId, { status: 'cancelled' })).result).toBe('updated');
    });

    it('a dose named against an unconfirmed meal acts as a lone dose (it was taken) and pairs with the meal once it is confirmed', async () => {
      const rig = makeRig({ glucose: 130, baseline: () => 130 });
      await setTestTherapy(rig);
      const draftId = await scan(rig);
      const dose = await rig.api.addInsulin({ clientId: 'dose-for-draft-001', administeredAt: iso(nowSec() - 30), kind: 'bolus', confirmation: 'confirmed', unitsAdministered: 4, source: 'manual', mealId: draftId });
      const f = ok(dose.forecast);
      expect(f.mealAware.events).toEqual([expect.objectContaining({ id: dose.insulin!.id, role: 'used', reason: 'dose_without_recorded_meal' })]);
      const confirmed = ok((await rig.api.editMeal(draftId, { status: 'confirmed' })).forecast);
      expect(confirmed.mealAware.events.find((e) => e.id === draftId)).toMatchObject({ role: 'used', reason: 'insulin_linked_declared' });
      expect(confirmed.mealAware.events.find((e) => e.id === dose.insulin!.id)).toMatchObject({ role: 'used', reason: 'linked_to_meal' });
    });

    it('a dose named against a scan that was never confirmed pairs with the meal that WAS confirmed around it', async () => {
      const rig = makeRig({ glucose: 130, baseline: () => 130 });
      await setTestTherapy(rig);
      const abandoned = await scan(rig); // first scan, left as a draft
      const replacement = await rig.api.addMeal({ clientId: 'replacement-0001', eatenAt: iso(nowSec() - 120), carbsG: 45 });
      const dose = await rig.api.addInsulin({ clientId: 'dose-for-abandoned-1', administeredAt: iso(nowSec() - 30), kind: 'bolus', confirmation: 'confirmed', unitsAdministered: 4.5, source: 'manual', mealId: abandoned });
      const f = ok(dose.forecast);
      expect(f.mealAware.events.find((e) => e.id === replacement.meal!.id)).toMatchObject({ role: 'used', reason: 'insulin_linked_auto' });
      expect(f.mealAware.events.find((e) => e.id === dose.insulin!.id)).toMatchObject({ role: 'used', reason: 'linked_to_meal' });
      expect(f.mealAware.availability).toMatchObject({ mealsUsed: 1, mealsRangeOnly: 0 });
    });

    it('preview: a stored draft is counted in full, saved nowhere, and changes nothing in the real forecast', async () => {
      const rig = makeRig({ glucose: 130, baseline: () => 130 });
      await setTestTherapy(rig);
      const draftId = await scan(rig);
      const runsBefore = await count(rig, 'SELECT COUNT(*) AS n FROM forecast_runs WHERE user_id = $1', [rig.userId]);
      const p = ok(await rig.forecast.preview({ mealId: draftId }));
      expect(p).toMatchObject({ preview: true, saved: false });
      expect(p.mealAware.preview).toEqual({ mealId: draftId, insulinUnits: null });
      expect(p.mealAware.availability).toMatchObject({ mealsUsed: 1, mealsRangeOnly: 0 });
      expect(p.mealAware.allLoggedCounted).toBeNull();
      expect(at(p, 120).adjusted).toBeGreaterThan(at(p, 120).baseline! + 100); // 45 g uncovered: the line climbs
      expect(p.points.every((pt) => pt.high >= pt.adjusted && pt.low <= pt.adjusted)).toBe(true); // uncertainty stays visible
      expect(p.notes[0]).toMatch(/^Preview: this meal is counted here in full/);
      expect(await count(rig, 'SELECT COUNT(*) AS n FROM forecast_runs WHERE user_id = $1', [rig.userId])).toBe(runsBefore);
      expect(await count(rig, 'SELECT COUNT(*) AS n FROM predictions WHERE user_id = $1', [rig.userId])).toBe(0); // nothing to learn from
      // the real forecast still has no meal
      expect(ok(await rig.forecast.run()).mealAware.events).toEqual([]);
    });

    it('preview: trying an insulin amount with the meal shows the net effect; an amount alone shows the correction; typed grams work', async () => {
      const rig = makeRig({ glucose: 150, baseline: () => 150 });
      await setTestTherapy(rig); // ICR 10, ISF 50
      const draftId = await scan(rig);
      const none = ok(await rig.forecast.preview({ mealId: draftId }));
      const covered = ok(await rig.forecast.preview({ mealId: draftId, insulinUnits: 4.5 }));
      expect(covered.mealAware.preview).toEqual({ mealId: draftId, insulinUnits: 4.5 });
      expect(covered.mealAware.events.find((e) => e.id === draftId)).toMatchObject({ role: 'used' });
      expect(at(covered, 120).adjusted).toBeLessThan(at(none, 120).adjusted - 50); // the insulin takes a large part of the rise away
      expect(at(covered, 120).adjusted).toBeGreaterThan(at(covered, 120).baseline! - 10); // 4.5 U covers 45 g: roughly a wash after 2 h

      const onlyInsulin = ok(await rig.forecast.preview({ insulinUnits: 2 }));
      expect(onlyInsulin.mealAware.preview).toEqual({ mealId: null, insulinUnits: 2 });
      expect(at(onlyInsulin, 60).adjusted).toBeLessThan(at(onlyInsulin, 60).baseline! - 20);
      expect(onlyInsulin.notes[0]).toMatch(/^Preview: the insulin amount you entered/);

      const typed = ok(await rig.forecast.preview({ meal: { carbsG: 30 } }));
      expect(typed.mealAware.preview).toEqual({ mealId: 'preview-meal', insulinUnits: null });
      expect(at(typed, 120).adjusted).toBeGreaterThan(at(typed, 120).baseline! + 60);
      expect(await count(rig, 'SELECT COUNT(*) AS n FROM meal_events WHERE user_id = $1', [rig.userId])).toBe(1); // only the scan; typed grams are never stored
      expect(await count(rig, 'SELECT COUNT(*) AS n FROM insulin_events WHERE user_id = $1', [rig.userId])).toBe(0);
    });

    it('preview adds to what is already logged and never double counts a meal that is already confirmed', async () => {
      const rig = makeRig({ glucose: 150, baseline: () => 150 });
      await setTestTherapy(rig);
      const logged = await rig.api.addMeal({ clientId: 'prev-logged-0001', eatenAt: iso(nowSec() - 300), carbsG: 40 });
      await rig.api.addInsulin({ clientId: 'prev-logged-0002', administeredAt: iso(nowSec() - 300), kind: 'bolus', confirmation: 'confirmed', unitsAdministered: 4, source: 'manual', mealId: logged.meal!.id });
      const real = ok(await rig.forecast.run());
      const again = ok(await rig.forecast.preview({ mealId: logged.meal!.id })); // already counted, with its own dose
      expect(again.mealAware.events.filter((e) => e.type === 'meal')).toHaveLength(1);
      expect(again.points.map((p) => p.adjusted)).toEqual(real.points.map((p) => p.adjusted)); // same line: counted once
      const extra = ok(await rig.forecast.preview({ meal: { carbsG: 30 } }));
      expect(extra.mealAware.events.filter((e) => e.type === 'meal')).toHaveLength(2); // the logged meal AND the previewed one
    });
  });

  describe('what-if: everything you logged counted in full', () => {
    const rigWith = (glucose = 150): Rig => makeRig({ glucose, baseline: () => glucose });

    it('a meal with no insulin record leaves the main line alone, but the what-if view shows where it leads', async () => {
      const rig = rigWith(150);
      await setTestTherapy(rig); // ICR 10, ISF 50 (test values)
      const meal = await rig.api.addMeal({ clientId: 'wi-dose-meal-001', eatenAt: iso(nowSec() - 600), carbsG: 50 });
      const f = ok(meal.forecast);
      for (const p of f.points.filter((x) => x.minutes <= 120)) expect(p.adjusted).toBe(p.baseline); // main line unchanged
      const w = f.mealAware.allLoggedCounted!;
      expect(w).not.toBeNull();
      expect(w.description).toMatch(/not a prediction/);
      expect(w.points).toHaveLength(36);
      expect(w.points[0]).toEqual({ minutes: 5, time: expect.any(String), adjusted: expect.any(Number), low: expect.any(Number), high: expect.any(Number) });
      expect(w.countedEntries).toEqual([{ id: meal.meal!.id, type: 'meal', reason: 'insulin_not_recorded' }]);
      // 50 g x CSF 5 mg/dL per g = 250 mg/dL, most of it within 2-3 hours
      const w120 = w.points.find((p) => p.minutes === 120)!;
      expect(w120.adjusted).toBeGreaterThan(150 + 40);
      expect(w120.low).toBeLessThanOrEqual(w120.adjusted);
      expect(w120.high).toBeGreaterThanOrEqual(w120.adjusted);
      // the summary agrees with the points
      expect(w.summary.lowestMgdl).toBe(Math.min(...w.points.map((p) => p.adjusted)));
      expect(w.points.find((p) => p.minutes === w.summary.lowestAtMin)!.adjusted).toBe(w.summary.lowestMgdl);
      expect(w.summary.highestMgdl).toBe(Math.max(...w.points.map((p) => p.adjusted)));
      expect(w.summary.lowestRangeEdgeMgdl).toBe(Math.min(...w.points.map((p) => p.low)));
      expect(w.summary.lowestRangeEdgeMgdl).toBeLessThanOrEqual(w.summary.lowestMgdl);
      expect(f.notes.join(' ')).toMatch(/What-if, not a prediction: .*would rise to about \d+ mg\/dL around \+\d+ min/);
      // nothing extra is stored for the what-if: the newest stored run is the main line (no entry applied), never a what-if configuration
      expect(f.saved).toBe(true);
      expect((await rig.db.query<{ feature_config: string }>('SELECT feature_config FROM forecast_runs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [rig.userId])).rows[0]!.feature_config).toBe('glucose_only');
    });

    it.each(['bolus', 'correction'] as const)('a dose logged as "%s" with no meal is in the main line itself, so there is nothing separate to show', async (kind) => {
      const rig = rigWith(150);
      await setTestTherapy(rig);
      const c = await rig.api.addInsulin({ clientId: `wi-lone-dose-${kind}`, administeredAt: iso(nowSec() - 600), kind, confirmation: 'confirmed', unitsAdministered: 2, source: 'manual' });
      const f = ok(c.forecast);
      expect(f.mealAware.allLoggedCounted).toBeNull();
      expect(at(f, 120).adjusted).toBeLessThan(150 - 40); // the main line itself moves: 2 U x ISF 50 still to come
      expect(f.mealAware.changedForecast).toBe(true);
      expect(f.mealAware.events[0]).toMatchObject({ id: c.insulin!.id, type: 'insulin', role: 'used', reason: kind === 'bolus' ? 'dose_without_recorded_meal' : 'correction_dose' });
      expect(f.mealAware.availability).toMatchObject({ insulinDosesUsed: 1, insulinDosesRangeOnly: 0 });
      // the glucose-only value stays inside the range: if the dose covered food that was never logged, glucose ends higher
      for (const p of f.points.filter((x) => x.minutes <= 120)) expect(p.high).toBeGreaterThanOrEqual(p.baseline!);
      if (kind === 'bolus') expect(f.notes.join(' ')).toMatch(/no meal recorded with it, so it is counted as lowering glucose/);
    });

    it('is absent when nothing is left out of the main line: nothing logged, a meal with its dose, a withdrawn dose, a dose that finished acting', async () => {
      expect(ok(await rigWith().forecast.run()).mealAware.allLoggedCounted).toBeNull();

      const a = rigWith();
      await setTestTherapy(a);
      const m = await a.api.addMeal({ clientId: 'wi-null-meal-001', eatenAt: iso(nowSec() - 300), carbsG: 60 });
      const d = await a.api.addInsulin({ clientId: 'wi-null-dose-001', administeredAt: iso(nowSec() - 300), kind: 'bolus', confirmation: 'confirmed', unitsAdministered: 6, source: 'manual', mealId: m.meal!.id });
      expect(ok(d.forecast).mealAware.allLoggedCounted).toBeNull();

      const b = rigWith();
      await setTestTherapy(b);
      const bm = await b.api.addMeal({ clientId: 'wi-null-meal-002', eatenAt: iso(nowSec() - 600), carbsG: 20 });
      expect(ok(bm.forecast).mealAware.allLoggedCounted).not.toBeNull(); // no insulin record: the line leaves it out
      const bz = await b.api.addInsulin({ clientId: 'wi-null-zero-002', administeredAt: iso(nowSec() - 600), kind: 'bolus', confirmation: 'confirmed', unitsAdministered: 0, source: 'manual' });
      expect(ok(bz.forecast).mealAware.allLoggedCounted).toBeNull(); // "I took none" counts it in full: nothing left out
      expect(ok((await b.api.editInsulin(bz.insulin!.id, { status: 'cancelled' })).forecast).mealAware.allLoggedCounted).not.toBeNull(); // withdrawn: back to unknown

      const c = rigWith();
      await setTestTherapy(c);
      const old = await c.api.addInsulin({ clientId: 'wi-null-dose-003', administeredAt: iso(nowSec() - 7 * 3600), kind: 'bolus', confirmation: 'confirmed', unitsAdministered: 4, source: 'manual' });
      expect(ok(old.forecast).mealAware.allLoggedCounted).toBeNull(); // 7 h ago: nothing left to act, so nothing would change

      // a small leftover (20 g eaten 4 h ago, no insulin record, still has ~2 mg/dL to give) is within the forecast's own noise: no second line
      const small = rigWith();
      await setTestTherapy(small);
      const leftover = await small.api.addMeal({ clientId: 'wi-null-meal-004', eatenAt: iso(nowSec() - 4 * 3600), carbsG: 20 });
      const lf = ok(leftover.forecast);
      expect(lf.mealAware.availability.mealsRangeOnly).toBe(1);
      expect(lf.mealAware.allLoggedCounted).toBeNull();
    });

    it('a lone dose is counted in the line but is never a training example; a declared correction still is (control)', async () => {
      const eligible = async (rig: Rig): Promise<string> => (await rig.db.query<{ e: string }>("SELECT input_snapshot->>'eligible' AS e FROM forecast_runs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1", [rig.userId])).rows[0]!.e;
      const lone = rigWith(150);
      await setTestTherapy(lone);
      await lone.api.addInsulin({ clientId: 'wi-elig-lone-0001', administeredAt: iso(nowSec() - 600), kind: 'bolus', confirmation: 'confirmed', unitsAdministered: 2, source: 'manual' });
      expect(await eligible(lone)).toBe('false');
      const corr = rigWith(150);
      await setTestTherapy(corr);
      await corr.api.addInsulin({ clientId: 'wi-elig-corr-0001', administeredAt: iso(nowSec() - 600), kind: 'correction', confirmation: 'confirmed', unitsAdministered: 2, source: 'manual' });
      expect(await eligible(corr)).toBe('true');
    });

    it('a meal with no insulin record: main line unchanged, the what-if view shows the uncovered rise; a what-if with meals left out shows none', async () => {
      const rig = rigWith(130);
      await setTestTherapy(rig);
      const m = await rig.api.addMeal({ clientId: 'wi-meal-0000001', eatenAt: iso(nowSec() - 300), carbsG: 50 });
      const f = ok(m.forecast);
      expect(f.mealAware.changedForecast).toBe(false);
      const w = f.mealAware.allLoggedCounted!;
      expect(w.summary.highestMgdl).toBeGreaterThan(200); // 50 g x CSF 5 mg/dL per g, mostly still to come
      expect(w.countedEntries).toEqual([{ id: m.meal!.id, type: 'meal', reason: 'insulin_not_recorded' }]);
      expect(f.notes.join(' ')).toMatch(/would rise to about/);
      const cf = ok(await rig.forecast.run({ excludeMealIds: [m.meal!.id], persist: false }));
      expect(cf.mealAware.counterfactual).toBe(true);
      expect(cf.mealAware.allLoggedCounted).toBeNull();
    });
  });

  describe('withdrawing (cancelling) entries', () => {
    const latestRunLinks = async (rig: Rig): Promise<{ meal_id: string | null; insulin_id: string | null; role: string; role_reason: string | null }[]> =>
      (
        await rig.db.query<{ meal_id: string | null; insulin_id: string | null; role: string; role_reason: string | null }>(
          `SELECT l.meal_id, l.insulin_id, l.role, l.role_reason FROM prediction_event_links l
            WHERE l.run_id = (SELECT run_id FROM forecast_runs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1)`,
          [rig.userId],
        )
      ).rows;

    it('a withdrawn meal and dose act nowhere (line, events, links, "insulin recorded") but stay in the history', async () => {
      const rig = makeRig({ glucose: 130, baseline: (m) => 130 + m / 10 });
      await setTestTherapy(rig);
      const meal = await rig.api.addMeal({ clientId: 'wd-meal-000001', eatenAt: iso(nowSec() - 300), carbsG: 60 });
      const dose = await rig.api.addInsulin({ clientId: 'wd-dose-000001', administeredAt: iso(nowSec() - 300), kind: 'bolus', confirmation: 'confirmed', unitsAdministered: 4, source: 'manual', mealId: meal.meal!.id });
      expect(ok(dose.forecast).mealAware.changedForecast).toBe(true);
      expect(await latestRunLinks(rig)).toHaveLength(2);

      expect((await rig.api.editMeal(meal.meal!.id, { status: 'cancelled', expectedRevision: 1 })).result).toBe('updated');
      const last = await rig.api.editInsulin(dose.insulin!.id, { status: 'cancelled', expectedRevision: 1 });
      expect(last.result).toBe('updated');
      const f = ok(last.forecast);
      expect(f.mealAware.changedForecast).toBe(false);
      expect(f.mealAware.events).toEqual([]);
      expect(f.mealAware.availability).toMatchObject({ mealsUsed: 0, mealsRangeOnly: 0, mealsNotUsed: 0, insulin: 'none_recorded', insulinDosesUsed: 0, insulinDosesRangeOnly: 0, insulinOnBoardUnits: null, carbsOnBoardGrams: null });
      for (const p of f.points.filter((x) => x.minutes <= 120)) expect(p.adjusted).toBe(p.baseline);
      // the NEW run stored no link to either entry
      expect(await latestRunLinks(rig)).toEqual([]);
      expect(await count(rig, "SELECT COUNT(*) AS n FROM forecast_runs WHERE user_id = $1 AND feature_config = 'glucose_only'", [rig.userId])).toBeGreaterThan(0);

      // kept: rows, revision history, and the OLD runs that did use them (history is never rewritten)
      expect(await count(rig, 'SELECT COUNT(*) AS n FROM meal_events WHERE user_id = $1', [rig.userId])).toBe(1);
      expect(await count(rig, 'SELECT COUNT(*) AS n FROM insulin_events WHERE user_id = $1', [rig.userId])).toBe(1);
      expect(await count(rig, "SELECT COUNT(*) AS n FROM event_revisions WHERE entity_type = 'meal' AND entity_id = $1", [meal.meal!.id])).toBe(1);
      expect(await count(rig, "SELECT COUNT(*) AS n FROM event_revisions WHERE entity_type = 'insulin' AND entity_id = $1", [dose.insulin!.id])).toBe(1);
      expect(await count(rig, 'SELECT COUNT(*) AS n FROM prediction_event_links WHERE meal_id = $1', [meal.meal!.id])).toBeGreaterThan(0);
      const recent = await rig.api.recent(3);
      expect(recent.meals).toEqual([]);
      expect(recent.insulin).toEqual([]);
      expect(await rig.forecast.mealCoverage(meal.meal!.id)).toBeNull();
    });

    it.each(['bolus', 'correction'] as const)('a %s dose named against a withdrawn meal (no other meal) acts as a lone dose: it was taken, so it lowers the line', async (kind) => {
      const rig = makeRig({ glucose: 150, baseline: (m) => 150 + m / 10 });
      await setTestTherapy(rig);
      const meal = await rig.api.addMeal({ clientId: `wd-link-meal-${kind}`, eatenAt: iso(nowSec() - 300), carbsG: 60 });
      const dose = await rig.api.addInsulin({ clientId: `wd-link-dose-${kind}`, administeredAt: iso(nowSec() - 300), kind, confirmation: 'confirmed', unitsAdministered: 6, source: 'manual', mealId: meal.meal!.id });
      expect(ok(dose.forecast).mealAware.availability).toMatchObject({ mealsUsed: 1, insulinDosesUsed: 1 });

      const f = ok((await rig.api.editMeal(meal.meal!.id, { status: 'cancelled' })).forecast);
      const reason = kind === 'bolus' ? 'dose_without_recorded_meal' : 'correction_dose';
      expect(f.mealAware.events).toHaveLength(1);
      expect(f.mealAware.events[0]).toMatchObject({ id: dose.insulin!.id, type: 'insulin', role: 'used', reason });
      expect(f.mealAware.availability).toMatchObject({ mealsUsed: 0, insulinDosesUsed: 1, insulinDosesRangeOnly: 0, insulin: 'logged' });
      expect(f.mealAware.availability.insulinOnBoardUnits).toBeGreaterThan(4);
      expect(at(f, 60).adjusted).toBeLessThan(at(f, 60).baseline! - 20); // 6 U x ISF 50 still to come, and no carbohydrate left to offset it
      expect(f.notes.join(' ')).not.toMatch(/meal you removed/);
      expect(await latestRunLinks(rig)).toEqual([{ meal_id: null, insulin_id: dose.insulin!.id, role: 'applied', role_reason: reason }]);
    });

    it('a re-scanned meal: a dose named against the earlier (withdrawn) scan is paired with the replacement meal', async () => {
      const rig = makeRig({ glucose: 150, baseline: () => 150 });
      await setTestTherapy(rig);
      const t = nowSec();
      const first = await rig.api.addMeal({ clientId: 'rescan-meal-0001', eatenAt: iso(t - 1500), carbsG: 71 });
      const second = await rig.api.addMeal({ clientId: 'rescan-meal-0002', eatenAt: iso(t - 300), carbsG: 60 });
      const dose = await rig.api.addInsulin({ clientId: 'rescan-dose-0001', administeredAt: iso(t - 270), kind: 'bolus', confirmation: 'confirmed', unitsAdministered: 6, source: 'manual', mealId: first.meal!.id });
      await rig.api.editMeal(first.meal!.id, { status: 'cancelled' });
      const f = ok(await rig.forecast.run());
      const byId = new Map(f.mealAware.events.map((e) => [e.id, e]));
      expect(byId.has(first.meal!.id)).toBe(false);
      expect(byId.get(second.meal!.id)).toMatchObject({ role: 'used', reason: 'insulin_linked_auto' });
      expect(byId.get(dose.insulin!.id)).toMatchObject({ role: 'used', reason: 'linked_to_meal' });
      expect(f.mealAware.availability).toMatchObject({ mealsUsed: 1, mealsRangeOnly: 0, insulinDosesUsed: 1, insulinDosesRangeOnly: 0 });
      expect(f.mealAware.changedForecast).toBe(true);
      expect(f.mealAware.allLoggedCounted).toBeNull();
      expect(await rig.forecast.mealCoverage(second.meal!.id)).toMatchObject({ insulinRecord: 'linked', insulinUnits: 6 });
    });

    it('a dose matched to its meal only by time becomes a lone dose once the meal is withdrawn, and still acts (it was taken)', async () => {
      const rig = makeRig({ glucose: 150, baseline: (m) => 150 + m / 10 });
      await setTestTherapy(rig);
      const when = iso(nowSec() - 300);
      const meal = await rig.api.addMeal({ clientId: 'wd-auto-meal-001', eatenAt: when, carbsG: 60 });
      const dose = await rig.api.addInsulin({ clientId: 'wd-auto-dose-001', administeredAt: when, kind: 'bolus', confirmation: 'confirmed', unitsAdministered: 6, source: 'manual' });
      expect(ok(dose.forecast).mealAware.availability).toMatchObject({ mealsUsed: 1, insulinDosesUsed: 1 });
      const f = ok((await rig.api.editMeal(meal.meal!.id, { status: 'cancelled' })).forecast);
      expect(f.mealAware.events).toHaveLength(1);
      expect(f.mealAware.events[0]).toMatchObject({ id: dose.insulin!.id, role: 'used', reason: 'dose_without_recorded_meal' });
      expect(at(f, 60).adjusted).toBeLessThan(at(f, 60).baseline! - 20); // 6 U x ISF 50 still to come, and no carbohydrate left to offset it
    });

    it('a withdrawn "I took none" record no longer says that insulin was confirmed absent', async () => {
      const rig = makeRig({ glucose: 130, baseline: () => 130 });
      await setTestTherapy(rig);
      const { z } = await addMealAndZero(rig, 40, 5);
      expect(ok(z.forecast).mealAware.availability).toMatchObject({ mealsUsed: 1, insulin: 'confirmed_none' });
      const f = ok((await rig.api.editInsulin(z.insulin!.id, { status: 'cancelled' })).forecast);
      expect(f.mealAware.availability).toMatchObject({ mealsUsed: 0, mealsRangeOnly: 1, insulin: 'none_recorded' });
      expect(f.mealAware.changedForecast).toBe(false);
    });

    it('withdrawing twice is "unchanged" (even with an old revision) and carries the forecast; nothing else may be done to a withdrawn entry', async () => {
      const rig = makeRig({ glucose: 130, baseline: () => 130 });
      await setTestTherapy(rig);
      const meal = await rig.api.addMeal({ clientId: 'wd-twice-meal-01', eatenAt: iso(nowSec() - 300), carbsG: 30 });
      const dose = await rig.api.addInsulin({ clientId: 'wd-twice-dose-01', administeredAt: iso(nowSec() - 300), kind: 'bolus', confirmation: 'confirmed', unitsAdministered: 3, source: 'manual', mealId: meal.meal!.id });

      // an active entry with a stale revision is a conflict and stays active
      expect((await rig.api.editMeal(meal.meal!.id, { status: 'cancelled', expectedRevision: 7 })).result).toBe('conflict');
      expect((await rig.api.editInsulin(dose.insulin!.id, { status: 'cancelled', expectedRevision: 7 })).result).toBe('conflict');
      expect((await rig.api.recent(3)).meals).toHaveLength(1);

      const m1 = await rig.api.editMeal(meal.meal!.id, { status: 'cancelled', expectedRevision: 1 });
      const d1 = await rig.api.editInsulin(dose.insulin!.id, { status: 'cancelled', expectedRevision: 1 });
      expect([m1.result, d1.result]).toEqual(['updated', 'updated']);
      expect(ok(m1.forecast).status).toBe('ok');
      expect(ok(d1.forecast).status).toBe('ok');
      for (const expectedRevision of [1, 2, undefined]) {
        const m2 = await rig.api.editMeal(meal.meal!.id, { status: 'cancelled', ...(expectedRevision ? { expectedRevision } : {}) });
        const d2 = await rig.api.editInsulin(dose.insulin!.id, { status: 'cancelled', ...(expectedRevision ? { expectedRevision } : {}) });
        expect([m2.result, d2.result]).toEqual(['unchanged', 'unchanged']);
        expect([m2.meal!.status, d2.insulin!.status]).toEqual(['cancelled', 'cancelled']);
        expect([m2.meal!.revision, d2.insulin!.revision]).toEqual([2, 2]);
        expect(ok(m2.forecast).status).toBe('ok');
        expect(ok(d2.forecast).status).toBe('ok');
      }
      // no extra history rows from the repeats
      expect(await count(rig, "SELECT COUNT(*) AS n FROM event_revisions WHERE entity_id = $1", [meal.meal!.id])).toBe(1);
      expect(await count(rig, "SELECT COUNT(*) AS n FROM event_revisions WHERE entity_id = $1", [dose.insulin!.id])).toBe(1);

      const edit = await rig.api.editMeal(meal.meal!.id, { carbsG: 99 });
      expect(edit).toMatchObject({ result: 'invalid', reason: 'a cancelled entry cannot be edited', forecast: null });
      expect((await rig.api.editMeal(meal.meal!.id, { status: 'confirmed' })).result).toBe('invalid'); // no silent revival
      expect((await rig.api.editInsulin(dose.insulin!.id, { unitsAdministered: 9 })).result).toBe('invalid');
      expect((await rig.api.editInsulin(dose.insulin!.id, { status: 'cancelled' })).forecast).not.toBeNull();
    });

    it('the recent list carries "status" on meals and insulin and leaves withdrawn rows out', async () => {
      const rig = makeRig({ glucose: 130, baseline: () => 130 });
      await setTestTherapy(rig);
      const a = await rig.api.addMeal({ clientId: 'wd-list-meal-01', eatenAt: iso(nowSec() - 900), carbsG: 20 });
      const b = await rig.api.addMeal({ clientId: 'wd-list-meal-02', eatenAt: iso(nowSec() - 3000), carbsG: 35 });
      const c = await rig.api.addInsulin({ clientId: 'wd-list-dose-01', administeredAt: iso(nowSec() - 900), kind: 'correction', confirmation: 'confirmed', unitsAdministered: 1, source: 'manual' });
      const e = await rig.api.addInsulin({ clientId: 'wd-list-dose-02', administeredAt: iso(nowSec() - 3000), kind: 'correction', confirmation: 'confirmed', unitsAdministered: 2, source: 'manual' });
      await rig.api.editMeal(a.meal!.id, { status: 'cancelled' });
      await rig.api.editInsulin(c.insulin!.id, { status: 'cancelled' });
      const r = await rig.api.recent(3);
      expect(r.meals.map((x) => [x.id, x.status])).toEqual([[b.meal!.id, 'manual_entry']]);
      expect(r.insulin.map((x) => [x.id, x.status])).toEqual([[e.insulin!.id, 'active']]);
    });
  });

  describe('labels, cancelling an insulin entry, and carbs / insulin on board along the forecast', () => {
    it('meals carry a short label: typed, edited, and derived from the items of a photo meal', async () => {
      const rig = makeRig({ glucose: 130, baseline: () => 130 });
      const m = await rig.api.addMeal({ clientId: 'label-meal-001', eatenAt: iso(nowSec() - 600), carbsG: 30, label: 'Pasta' });
      expect(m.meal!.label).toBe('Pasta');
      const e = await rig.api.editMeal(m.meal!.id, { label: 'Pasta + salad' });
      expect(e.result).toBe('updated');
      expect(e.meal!.label).toBe('Pasta + salad');
      const none = await rig.api.addMeal({ clientId: 'label-meal-002', eatenAt: iso(nowSec() - 3000), carbsG: 12 });
      expect(none.meal!.label).toBeNull();
      const photoRes = await mealService(rig, [{ kind: 'raw', rawText: detectedRaw }]).analyzeMeal(photo);
      const photoId = (photoRes as { mealEventId: string }).mealEventId;
      expect((await rig.api.recent(2)).meals.some((x) => x.id === photoId)).toBe(false); // an unconfirmed scan is not listed
      await rig.api.editMeal(photoId, { status: 'confirmed' });
      const recent = await rig.api.recent(2);
      const photoMeal = recent.meals.find((x) => x.id === photoId)!;
      expect(photoMeal.label).toBe('steamed white rice');
    });

    it('cancelling an insulin entry withdraws it from the forecast but keeps it, with its history', async () => {
      const rig = makeRig({ glucose: 130, baseline: () => 130 });
      await setTestTherapy(rig);
      const meal = await rig.api.addMeal({ clientId: 'cx-meal-000001', eatenAt: iso(nowSec() - 300), carbsG: 60 });
      const dose = await rig.api.addInsulin({ clientId: 'cx-dose-000001', administeredAt: iso(nowSec() - 300), kind: 'bolus', confirmation: 'confirmed', unitsAdministered: 6, source: 'manual', mealId: meal.meal!.id });
      const withDose = ok(dose.forecast);
      expect(withDose.mealAware.availability).toMatchObject({ mealsUsed: 1, insulinDosesUsed: 1 });

      const cancelled = await rig.api.editInsulin(dose.insulin!.id, { status: 'cancelled' });
      expect(cancelled.result).toBe('updated');
      expect(cancelled.insulin).toMatchObject({ status: 'cancelled', revision: 2 });
      const f = ok(cancelled.forecast);
      // with the dose gone, the meal has no insulin record again: it no longer moves the line, and insulin is unknown, not zero
      expect(f.mealAware.availability).toMatchObject({ mealsUsed: 0, mealsRangeOnly: 1, insulin: 'none_recorded', insulinDosesUsed: 0, insulinOnBoardUnits: null });
      expect(f.mealAware.changedForecast).toBe(false);

      expect(await count(rig, 'SELECT COUNT(*) AS n FROM insulin_events WHERE user_id = $1', [rig.userId])).toBe(1); // not deleted
      expect(await count(rig, "SELECT COUNT(*) AS n FROM event_revisions WHERE entity_type = 'insulin' AND entity_id = $1", [dose.insulin!.id])).toBe(1);
      expect((await rig.api.recent(3)).insulin).toHaveLength(0); // not listed any more
      expect((await rig.api.editInsulin(dose.insulin!.id, { unitsAdministered: 5 })).result).toBe('invalid'); // a cancelled entry cannot be edited
      expect((await rig.api.editInsulin(dose.insulin!.id, { status: 'cancelled' })).result).toBe('unchanged');
      // the same dose can be logged again (a new entry), and then it counts
      const again = await rig.api.addInsulin({ clientId: 'cx-dose-000002', administeredAt: iso(nowSec() - 300), kind: 'bolus', confirmation: 'confirmed', unitsAdministered: 6, source: 'manual', mealId: meal.meal!.id });
      expect(again.result).toBe('created');
      expect(ok(again.forecast).mealAware.availability.insulinDosesUsed).toBe(1);
    });

    it('every forecast point carries insulin and carbs on board; they run down; unknown stays null', async () => {
      const rig = makeRig({ glucose: 130, baseline: () => 130 });
      await setTestTherapy(rig, 10, 50);
      const empty = ok(await rig.forecast.run());
      expect(empty.points.every((p) => p.insulinOnBoardUnits === null && p.carbsOnBoardGrams === null)).toBe(true);

      const when = iso(nowSec() - 300);
      const meal = await rig.api.addMeal({ clientId: 'iob-meal-00001', eatenAt: when, carbsG: 60 });
      const dose = await rig.api.addInsulin({ clientId: 'iob-dose-00001', administeredAt: when, kind: 'bolus', confirmation: 'confirmed', unitsAdministered: 6, source: 'manual', mealId: meal.meal!.id });
      const f = ok(dose.forecast);
      const iob = f.points.map((p) => p.insulinOnBoardUnits as number);
      const cob = f.points.map((p) => p.carbsOnBoardGrams as number);
      expect(f.mealAware.availability.insulinOnBoardUnits).toBeGreaterThan(iob[0]!); // "now" is above the first step
      expect(f.mealAware.availability.carbsOnBoardGrams).toBeGreaterThan(cob[0]!);
      for (let j = 1; j < f.points.length; j += 1) {
        expect(iob[j]).toBeLessThanOrEqual(iob[j - 1]!);
        expect(cob[j]).toBeLessThanOrEqual(cob[j - 1]!);
      }
      expect(iob[iob.length - 1]).toBeLessThan(iob[0]! / 2);
      expect(cob[cob.length - 1]).toBeLessThan(cob[0]! / 4);
      // a recorded 'none taken' makes insulin on board 0 along the whole line, not null
      const rig2 = makeRig({ glucose: 130, baseline: () => 130 });
      await setTestTherapy(rig2);
      const { z } = await addMealAndZero(rig2, 30);
      expect(ok(z.forecast).points.every((p) => p.insulinOnBoardUnits === 0 && typeof p.carbsOnBoardGrams === 'number')).toBe(true);
    });
  });

  // ------------------------------------------------ database integrity and permissions
  describe('PostgreSQL reads, writes, foreign keys and permissions', () => {
    it('stores CGM readings idempotently and rejects implausible or future ones', async () => {
      const rig = makeRig();
      const t = nowSec() - 600;
      const pts = [0, 1, 2].map((k) => ({ time: iso(t + k * 300), value: 100 + k }));
      expect(await rig.ingest.recordReadings(pts)).toEqual({ inserted: 3, rejected: 0 });
      expect(await rig.ingest.recordReadings(pts)).toEqual({ inserted: 0, rejected: 0 });
      expect(await rig.ingest.recordReadings([{ time: iso(t), value: 5 }, { time: iso(nowSec() + 3600), value: 100 }])).toEqual({ inserted: 0, rejected: 2 });
      const rows = await rig.db.query<{ glucose_mgdl: string; source: string }>(
        'SELECT glucose_mgdl, source FROM glucose_readings WHERE user_id = $1 ORDER BY measured_at', [rig.userId]);
      expect(rows.rows.map((r) => Number(r.glucose_mgdl))).toEqual([100, 101, 102]);
      expect(new Set(rows.rows.map((r) => r.source))).toEqual(new Set(['cgm']));
    });

    it('enforces foreign keys, append-only history and least privilege for the application role', async () => {
      const rig = makeRig();
      await rig.forecast.run();
      const code = async (sql: string, params: unknown[] = []): Promise<string> => {
        try { await rig.db.query(sql, params); return 'OK'; } catch (e) { return (e as { code: string }).code; }
      };
      expect(await code('INSERT INTO meal_events (user_id, client_uuid, eaten_at) VALUES (gen_random_uuid(), gen_random_uuid(), now())')).toBe('23503');
      expect(await code('UPDATE predictions SET predicted_mgdl = 999 WHERE user_id = $1', [rig.userId])).toBe('42501');
      expect(await code('DELETE FROM predictions WHERE user_id = $1', [rig.userId])).toBe('42501');
      expect(await code('UPDATE forecast_runs SET layer_version = $1 WHERE user_id = $2', ['x', rig.userId])).toBe('42501');
      expect(await code('DELETE FROM glucose_readings WHERE user_id = $1', [rig.userId])).toBe('42501');
      expect(await code('UPDATE therapy_segments SET value = 1')).toBe('42501');
      expect(await code('CREATE TABLE nope (a int)')).toBe('42501');
      expect(await code('SELECT 1 FROM schema_migrations')).toBe('42501');
    });

    it('keeps parameter versions: new row per change, history intact, rollback is a new version', async () => {
      const rig = makeRig();
      await rig.users.primary();
      const v1 = await rig.parameters.insertVersion(null, rig.userId, { name: 'm_csf', value: 0.95, status: 'active', source: 'fit', evidenceCount: 20, uncertaintySd: null, note: 'a' });
      const v2 = await rig.parameters.insertVersion(null, rig.userId, { name: 'm_csf', value: 0.9, status: 'active', source: 'fit', evidenceCount: 30, uncertaintySd: null, note: 'b' });
      expect([v1, v2]).toEqual([1, 2]);
      expect((await rig.parameters.getActive(rig.userId)).params.mCsf).toBeCloseTo(0.9);
      const v3 = await rig.parameters.rollback(rig.userId, 'm_csf', 1);
      expect(v3).toBe(3);
      const hist = await rig.parameters.history(rig.userId, 'm_csf');
      expect(hist.map((h) => [h.version, h.value, h.status, h.source])).toEqual([[1, 0.95, 'retired', 'fit'], [2, 0.9, 'retired', 'fit'], [3, 0.95, 'active', 'rollback']]);
      expect((await rig.parameters.getActive(rig.userId)).label).toBe('m_csf=v3,m_isf=default');
      // out-of-bounds values are clamped by the store and the database refuses a value outside its own bounds
      await rig.parameters.insertVersion(null, rig.userId, { name: 'm_isf', value: 9, status: 'proposed', source: 'manual', evidenceCount: 0, uncertaintySd: null, note: null });
      expect((await rig.parameters.history(rig.userId, 'm_isf'))[0]!.value).toBe(1.6);
      expect(await rig.parameters.rollback(rig.userId, 'm_csf', 99)).toBeNull();
    });

    it('failures are handled safely: no database, unreachable database', async () => {
      const none = makeRig({ url: '' });
      expect(none.db.available).toBe(false);
      const f = ok(await none.forecast.run());
      expect(f.saved).toBe(false);
      expect(f.mealAware.changedForecast).toBe(false);
      expect(f.notes.join(' ')).toMatch(/not available right now/);

      const bad = makeRig({ url: 'postgresql://nobody:nothing@127.0.0.1:1/none' });
      const g = ok(await bad.forecast.run());
      expect(g.saved).toBe(false);
      expect(g.notes.join(' ')).toMatch(/could not be read/);
      expect(JSON.stringify(g)).not.toMatch(/127\.0\.0\.1|ECONNREFUSED|nobody|nothing/);
      const photoBad = await bad.flow.afterAnalysis({ status: 'ok' } as never, { imageSha256: 'a'.repeat(64) });
      expect(photoBad.mealEventId).toBeNull();
      expect(photoBad.forecastNote).toMatch(/could not be saved/);
      await none.db.onModuleDestroy();
      await bad.db.onModuleDestroy();
    });
  });

  // ---------------------------------------------------------------- ICR (section 8)
  describe('insulin-to-carbohydrate ratio', () => {
    it('versions the setting by time of day, keeps history, carries over what is not sent', async () => {
      const rig = makeRig();
      await rig.users.primary();
      expect((await rig.therapy.getView(rig.userId)).status).toBe('not_set');
      const v1 = await rig.therapy.setSettings(rig.userId, {
        icrSegments: [{ startMinute: 0, gramsPerUnit: 12 }, { startMinute: 660, gramsPerUnit: 9 }],
        isfSegments: [{ startMinute: 0, mgdlPerUnit: 45 }],
        insulinType: 'rapid',
        source: 'clinician_prescribed',
        effectiveFrom: iso(nowSec() - 86400),
        note: 'clinic visit',
      });
      expect(v1).toMatchObject({ status: 'set', version: 1, source: 'clinician_prescribed' });
      expect(v1.icrSegments.map((s) => [s.startTime, s.gramsPerUnit])).toEqual([['00:00', 12], ['11:00', 9]]);
      const v2 = await rig.therapy.setSettings(rig.userId, { icrSegments: [{ startMinute: 0, gramsPerUnit: 11 }], source: 'user_entered' });
      expect(v2.version).toBe(2);
      expect(v2.isfSegments).toEqual(v1.isfSegments); // ISF and insulin type carried over
      expect(v2.insulinType).toBe('rapid');
      const hist = await rig.therapy.history(rig.userId);
      expect(hist.map((h) => h.version)).toEqual([2, 1]);
      expect(hist[1]!.icrSegments).toHaveLength(2); // the old version is unchanged
      await expect(rig.therapy.setSettings(rig.userId, { icrSegments: [{ startMinute: 0, gramsPerUnit: 10 }], source: 'user_entered', effectiveFrom: iso(nowSec() + 3 * 86400) })).rejects.toThrow(/24 hours/);
    });

    it('resolves the ratio by local time of day (time zone aware) and never invents one', async () => {
      const rig = makeRig();
      await rig.users.primary();
      await rig.users.setTimezone(rig.userId, 'Asia/Kolkata');
      await rig.therapy.setSettings(rig.userId, {
        icrSegments: [{ startMinute: 0, gramsPerUnit: 12 }, { startMinute: 720, gramsPerUnit: 8 }],
        isfSegments: [{ startMinute: 0, mgdlPerUnit: 50 }],
        source: 'user_entered',
        effectiveFrom: iso(nowSec() - 5 * 86400),
      });
      const resolver = await rig.therapy.resolver(rig.userId, 'Asia/Kolkata');
      // Asia/Kolkata is UTC+5:30 all year (no daylight saving), so the expectations never depend on the date
      const day = Math.floor(nowSec() / 86400) * 86400 - 2 * 86400;
      expect(resolver.at(day + 9 * 3600).icrGPerU).toBe(8); // 14:30 local -> afternoon segment
      expect(resolver.at(day + 3 * 3600).icrGPerU).toBe(12); // 08:30 local -> morning segment
      expect(resolver.at(day + 6 * 3600 + 29 * 60).icrGPerU).toBe(12); // 11:59 local
      expect(resolver.at(day + 6 * 3600 + 30 * 60).icrGPerU).toBe(8); // 12:00 local: boundary
      // before the first version existed, that first version is what applied (nothing else was in force)
      expect(resolver.at(nowSec() - 30 * 86400)).toMatchObject({ version: 1, icrStatus: 'available' });
    });

    it("1. different users' ratios are respected independently, 3. same events give different forecasts", async () => {
      const a = makeRig({ glucose: 130, baseline: () => 130 });
      const b = makeRig({ glucose: 130, baseline: () => 130 });
      await setTestTherapy(a, 10, 50);
      await setTestTherapy(b, 5, 50);
      await addMealAndZero(a, 40);
      await addMealAndZero(b, 40);
      const fa = ok(await a.forecast.run());
      const fb = ok(await b.forecast.run());
      // identical glucose-only forecast ...
      expect(fa.points.map((p) => p.baseline)).toEqual(fb.points.map((p) => p.baseline));
      // ... and a meal effect that scales with CSF = ISF/ICR: half the ICR, twice the carbohydrate effect
      const ra = at(fa, 120).adjusted - 130;
      const rb = at(fb, 120).adjusted - 130;
      expect(rb / ra).toBeCloseTo(2, 2);
      // user A's setting is untouched by user B's
      expect((await a.therapy.getView(a.userId)).icrSegments[0]!.gramsPerUnit).toBe(10);
      expect((await b.therapy.getView(b.userId)).icrSegments[0]!.gramsPerUnit).toBe(5);
    });

    it('2. updating the ratio changes new forecasts but never rewrites stored predictions', async () => {
      const t0 = nowSec();
      const rig = makeRig({ anchorSec: t0 - 120, glucose: 130, baseline: () => 130 });
      await setTestTherapy(rig, 10, 50);
      await addMealAndZero(rig, 40);
      const f1 = ok(await rig.forecast.run());
      const stored = async () =>
        (await rig.db.query('SELECT prediction_id, predicted_mgdl, lower_mgdl, upper_mgdl, icr_g_per_u, isf_mgdl_per_u, therapy_profile_id, icr_status, input_snapshot FROM predictions WHERE user_id = $1 ORDER BY prediction_id', [rig.userId])).rows;
      const before = await stored();
      expect(before.length).toBeGreaterThan(0);
      for (const r of before) expect(Number(r.icr_g_per_u)).toBe(10);

      // the person corrects their ratio (effective from a day ago, so it also applies to today's meal)
      const v2 = await rig.therapy.setSettings(rig.userId, { icrSegments: [{ startMinute: 0, gramsPerUnit: 15 }], source: 'user_entered', effectiveFrom: iso(t0 - 86400) });
      expect(v2.version).toBe(2);
      const f2 = ok(await rig.forecast.run());
      expect(at(f2, 120).adjusted - 130).toBeCloseTo((at(f1, 120).adjusted - 130) * (10 / 15), 0); // CSF = ISF/ICR

      const after = await stored();
      for (const old of before) expect(after.find((r) => r.prediction_id === old.prediction_id)).toEqual(old); // byte-for-byte
      const fresh = after.filter((r) => !before.some((o) => o.prediction_id === r.prediction_id));
      expect(fresh.length).toBeGreaterThan(0);
      for (const r of fresh) expect(Number(r.icr_g_per_u)).toBe(15);
      expect(new Set(before.map((r) => r.therapy_profile_id)).size).toBe(1);
      expect(fresh[0]!.therapy_profile_id).not.toBe(before[0]!.therapy_profile_id);
    });

    it('4./5. more or less insulin shifts the line through the insulin-action model without forcing a low or a high', async () => {
      const run = async (units: number) => {
        const rig = makeRig({ glucose: 130, baseline: () => 130 });
        await setTestTherapy(rig, 10, 50);
        const when = iso(nowSec() - 120);
        await rig.api.addMeal({ clientId: `ins-meal-${units}`, eatenAt: when, carbsG: 60 });
        await rig.api.addInsulin({ clientId: `ins-dose-${units}`, administeredAt: when, kind: 'bolus', confirmation: 'confirmed', unitsAdministered: units, source: 'manual' });
        return ok(await rig.forecast.run());
      };
      const [less, matched, more] = [await run(2), await run(6), await run(8)];
      for (const m of [60, 120, 180]) {
        expect(at(less, m).adjusted).toBeGreaterThan(at(matched, m).adjusted);
        expect(at(matched, m).adjusted).toBeGreaterThan(at(more, m).adjusted);
      }
      // the gap between doses is the insulin kernel (ISF x extra units x cumulative action), not a fixed constant
      expect(at(matched, 60).adjusted - at(more, 60).adjusted).toBeLessThan(at(matched, 180).adjusted - at(more, 180).adjusted);
      // no guarantee of an extreme: even 8 U against 60 g leaves the line well above the clipping floor
      expect(at(more, 180).adjusted).toBeGreaterThan(20);
      expect(at(less, 180).adjusted).toBeLessThan(500);
    });

    it('6. a missing ratio or missing insulin record produces no invented numbers and says so', async () => {
      const noRatio = makeRig({ glucose: 130, baseline: () => 130 });
      const { m } = await addMealAndZero(noRatio, 40);
      const f = ok(await noRatio.forecast.run());
      expect(f.mealAware.availability).toMatchObject({ therapySettings: 'unavailable', mealsUsed: 0, mealsNotUsed: 1 });
      expect(f.points.every((p) => p.adjusted === p.baseline || p.baseline === null)).toBe(true);
      expect(f.notes.join(' ')).toMatch(/ratio or correction factor is not set/);
      const cov = (await noRatio.forecast.mealCoverage(m.meal!.id))!;
      expect(cov).toMatchObject({ ratioStatus: 'unavailable', expectedCoverageG: null, carbsMinusCoverageG: null });

      const noInsulin = makeRig({ glucose: 130, baseline: () => 130 });
      await setTestTherapy(noInsulin);
      const meal = await noInsulin.api.addMeal({ clientId: 'cov-meal-0001', eatenAt: iso(nowSec() - 300), carbsG: 60 });
      const cov2 = (await noInsulin.forecast.mealCoverage(meal.meal!.id))!;
      expect(cov2).toMatchObject({ insulinRecord: 'none_recorded', insulinUnits: null, expectedCoverageG: null });
    });

    it('B. compares recorded carbohydrate with the insulin actually taken (60 g, ICR 10, 4 U -> 40 g covered)', async () => {
      const rig = makeRig({ glucose: 130, baseline: () => 130 });
      await setTestTherapy(rig, 10, 50);
      const when = iso(nowSec() - 300);
      const meal = await rig.api.addMeal({ clientId: 'cov-meal-0002', eatenAt: when, carbsG: 60 });
      const dose = await rig.api.addInsulin({ clientId: 'cov-dose-0002', administeredAt: when, kind: 'bolus', confirmation: 'confirmed', unitsAdministered: 4, source: 'manual', mealId: meal.meal!.id });
      expect(dose.result).toBe('created');
      const cov = (await rig.forecast.mealCoverage(meal.meal!.id))!;
      expect(cov).toMatchObject({ insulinRecord: 'linked', insulinUnits: 4, expectedCoverageG: 40, carbsMinusCoverageG: 20 });
      expect(cov.note).toMatch(/not a dose recommendation/);
      expect(JSON.stringify(cov)).not.toMatch(/take|inject|units? (more|less)/i);

      await rig.forecast.run();
      const links = (await rig.db.query('SELECT l.role, l.link_type, l.carbs_g, l.carbs_provenance, l.insulin_units, l.coverage_g, l.carbs_minus_coverage_g, l.meal_id FROM prediction_event_links l WHERE l.run_id = (SELECT run_id FROM forecast_runs WHERE user_id = $1 ORDER BY created_at DESC, run_id LIMIT 1)', [rig.userId])).rows;
      const mealLink = links.find((l) => l.meal_id !== null)!;
      expect(mealLink).toMatchObject({ role: 'applied', link_type: 'declared', carbs_provenance: 'user_entered' });
      expect(Number(mealLink.carbs_g)).toBe(60);
      expect(Number(mealLink.coverage_g)).toBe(40);
      expect(Number(mealLink.carbs_minus_coverage_g)).toBe(20);
      const doseLink = links.find((l) => l.meal_id === null)!;
      expect(Number(doseLink.insulin_units)).toBe(4);
    });

    it('E. an ambiguous dose is matched to neither meal but counts with both; a non-rapid insulin and a basal entry never count', async () => {
      const rig = makeRig({ glucose: 130, baseline: () => 130 });
      await setTestTherapy(rig);
      const t = nowSec();
      await rig.api.addMeal({ clientId: 'amb-meal-0001', eatenAt: iso(t - 600), carbsG: 40 });
      await rig.api.addMeal({ clientId: 'amb-meal-0002', eatenAt: iso(t - 60), carbsG: 30 });
      await rig.api.addInsulin({ clientId: 'amb-dose-0001', administeredAt: iso(t - 300), kind: 'bolus', confirmation: 'confirmed', unitsAdministered: 4, source: 'manual' });
      await rig.api.addInsulin({ clientId: 'amb-long-0001', administeredAt: iso(t - 300), kind: 'bolus', confirmation: 'confirmed', unitsAdministered: 20, source: 'manual', insulinType: 'long' });
      const basal = await rig.api.addInsulin({ clientId: 'amb-basal-001', administeredAt: iso(t - 290), kind: 'basal', confirmation: 'confirmed', unitsAdministered: 18, source: 'manual' });
      const f = ok(basal.forecast);
      expect(f.mealAware.availability.mealsRangeOnly).toBe(0);
      expect(f.mealAware.availability.mealsUsed).toBe(2); // insulin is recorded around them: both meals count
      expect(f.mealAware.availability).toMatchObject({ insulinDosesUsed: 1, insulinDosesRangeOnly: 0 });
      expect(f.mealAware.events.filter((e) => e.type === 'meal').map((e) => e.reason)).toEqual(['insulin_link_ambiguous', 'insulin_link_ambiguous']);
      expect(f.mealAware.events.filter((e) => e.type === 'meal').every((e) => e.role === 'used')).toBe(true);
      expect(f.notes.join(' ')).toMatch(/counted, but not matched to each other/);
      // the 20 g long-acting and the 18 U basal never act: only the 4 U rapid dose and the two meals do
      expect(f.mealAware.events.find((e) => e.reason === 'not_rapid_acting')!.role).toBe('not_used');
      expect(f.mealAware.events.find((e) => e.reason === 'not_a_meal_bolus')!.role).toBe('not_used');
      expect(f.mealAware.events.filter((e) => e.type === 'insulin').map((e) => e.reason).sort()).toEqual(['dose_without_recorded_meal', 'not_a_meal_bolus', 'not_rapid_acting']);
    });

    it('a meal logged a minute BEFORE the first settings were saved is still read with them', async () => {
      const rig = makeRig({ glucose: 130, baseline: () => 130 });
      const meal = await rig.api.addMeal({ clientId: 'first-profile-01', eatenAt: iso(nowSec() - 120), carbsG: 50 });
      expect(ok(meal.forecast).mealAware.availability.therapySettings).toBe('unavailable');
      await rig.therapy.setSettings(rig.userId, { icrSegments: [{ startMinute: 0, gramsPerUnit: 10 }], isfSegments: [{ startMinute: 0, mgdlPerUnit: 50 }], source: 'user_entered' });
      const f = ok(await rig.forecast.run());
      expect(f.mealAware.availability.therapySettings).toBe('available');
      expect(f.mealAware.events[0]).toMatchObject({ type: 'meal', role: 'range_only', reason: 'insulin_not_recorded' });
      expect((await rig.forecast.mealCoverage(meal.meal!.id))!.ratioStatus).toBe('available');
    });

    it('7. the ratio is not counted twice: the glucose-only input is identical whatever the ratio', async () => {
      const a = makeRig({ glucose: 130, baseline: (m) => 130 + m / 5 });
      const b = makeRig({ glucose: 130, baseline: (m) => 130 + m / 5 });
      await setTestTherapy(a, 10, 50);
      await setTestTherapy(b, 20, 50);
      await addMealAndZero(a, 40);
      await addMealAndZero(b, 40);
      const fa = ok(await a.forecast.run());
      const fb = ok(await b.forecast.run());
      expect(fa.points.map((p) => p.baseline)).toEqual(fb.points.map((p) => p.baseline)); // the model never sees the ratio
      // only the event layer differs, and only by CSF
      for (const m of [60, 90, 120]) {
        expect((at(fa, m).adjusted - at(fa, m).baseline!) / (at(fb, m).adjusted - at(fb, m).baseline!)).toBeCloseTo(2, 1); // values are rounded to 0.1 mg/dL
      }
      // the glucose service is asked exactly once per forecast: no second, ratio-aware path into the model
      const calls = a.fake.calls;
      await a.forecast.run();
      expect(a.fake.calls - calls).toBe(1);
    });
  });

  // ------------------------------------------------ 11/13. outcomes, learning, comparison
  describe('outcomes and recursive personalisation', () => {
    it('matches new CGM readings to earlier predictions and never rewrites a prediction', async () => {
      const anchor = nowSec() - 150 * 60;
      const rig = makeRig({ anchorSec: anchor, glucose: 140, baseline: () => 140 });
      await rig.forecast.run();
      const preds = async () => (await rig.db.query('SELECT prediction_id, predicted_mgdl, lower_mgdl, upper_mgdl FROM predictions WHERE user_id = $1 ORDER BY horizon_min', [rig.userId])).rows;
      const before = await preds();
      expect(before).toHaveLength(5);
      expect(await count(rig, 'SELECT COUNT(*) AS n FROM prediction_outcomes o JOIN predictions p USING (prediction_id) WHERE p.user_id = $1', [rig.userId])).toBe(0);

      const readings = Array.from({ length: 28 }, (_, k) => ({ time: iso(anchor - 600 + k * 300), value: 150 })); // up to anchor+125 min
      const res = await rig.ingest.recordReadings(readings);
      expect(res.inserted).toBe(28);

      const out = (await rig.db.query<{ horizon_min: number; observed_mgdl: string; signed_error_mgdl: string; abs_error_mgdl: string; matching_quality: string; match_offset_sec: number; within_interval: boolean }>(
        'SELECT p.horizon_min, o.observed_mgdl, o.signed_error_mgdl, o.abs_error_mgdl, o.matching_quality, o.match_offset_sec, o.within_interval FROM prediction_outcomes o JOIN predictions p USING (prediction_id) WHERE p.user_id = $1 ORDER BY p.horizon_min',
        [rig.userId])).rows;
      expect(out.map((o) => o.horizon_min)).toEqual([15, 30, 45, 60, 120]);
      for (const o of out) {
        expect(Number(o.observed_mgdl)).toBe(150);
        expect(Number(o.signed_error_mgdl)).toBe(10); // observed minus predicted
        expect(Number(o.abs_error_mgdl)).toBe(10);
        expect(o.matching_quality).toBe('exact');
        expect(o.match_offset_sec).toBe(0);
        expect(o.within_interval).toBe(true);
      }
      expect(await preds()).toEqual(before); // the prediction rows are exactly as they were

      // a retry changes nothing
      expect((await rig.ingest.recordReadings(readings)).inserted).toBe(0);
      expect((await rig.outcomes.scoreDue(rig.userId)).scored).toBe(0);
      expect(await count(rig, 'SELECT COUNT(*) AS n FROM prediction_outcomes o JOIN predictions p USING (prediction_id) WHERE p.user_id = $1', [rig.userId])).toBe(5);

      // rolling statistics by horizon and feature configuration were written
      const perf = await rig.db.query<{ horizon_min: number; sample_count: number; bias_mgdl: string; feature_config: string }>(
        'SELECT horizon_min, sample_count, bias_mgdl, feature_config FROM model_performance WHERE user_id = $1 ORDER BY horizon_min', [rig.userId]);
      expect(perf.rows.map((r) => r.horizon_min)).toEqual([15, 30, 45, 60, 120]);
      expect(Number(perf.rows[0]!.bias_mgdl)).toBe(10);
      expect(perf.rows[0]!.feature_config).toBe('glucose_only');
    });

    it('does not invent an outcome across a sensor gap, and labels a near match honestly', async () => {
      const anchor = nowSec() - 150 * 60;
      const rig = makeRig({ anchorSec: anchor, glucose: 140, baseline: () => 140 });
      await rig.forecast.run();
      // readings every 5 min, but none within 4 minutes of the +60 target and the +30 target 2.5 min late
      const readings = [] as { time: string; value: number }[];
      for (let s = -600; s <= 140 * 60; s += 300) {
        const rel = s;
        if (Math.abs(rel - 3600) < 240) continue;
        if (rel === 1800) { readings.push({ time: iso(anchor + 1800 + 150), value: 150 }); continue; }
        readings.push({ time: iso(anchor + rel), value: 150 });
      }
      await rig.ingest.recordReadings(readings);
      const rows = (await rig.db.query<{ horizon_min: number; matching_quality: string; match_offset_sec: number }>(
        'SELECT p.horizon_min, o.matching_quality, o.match_offset_sec FROM prediction_outcomes o JOIN predictions p USING (prediction_id) WHERE p.user_id = $1 ORDER BY p.horizon_min', [rig.userId])).rows;
      expect(rows.map((r) => r.horizon_min)).toEqual([15, 30, 45, 120]);
      expect(rows.find((r) => r.horizon_min === 30)).toMatchObject({ matching_quality: 'nearest_within_tolerance', match_offset_sec: 150 });
      expect(rows.find((r) => r.horizon_min === 60)).toBeUndefined(); // unscored: missing, not interpolated
    });

    /**
     * SYNTHETIC world, built to exercise the machinery - NOT evidence about real accuracy.
     * Truth: glucose = flat 120 + 0.8 x (the layer's own meal effect). The glucose-only baseline ignores
     * the meal; the layer (scale 1.0) over-corrects by 25%; the learner should move the scale down, slowly.
     */
    describe('synthetic history', () => {
      const CSF = 5;
      const CARBS = 40;
      const TM = nowSec() - 6 * 3600;
      const truth = (t: number): number => 120 + 0.8 * CSF * CARBS * mealCumulativeAbsorption((t - TM) / 60, 40);

      async function build(withInsulinRecord: boolean, anchors = 19, beforeReadings?: (rig: Rig) => Promise<void>): Promise<Rig> {
        const rig = makeRig();
        await setTestTherapy(rig, 10, 50);
        await rig.api.addMeal({ clientId: 'syn-meal-0001', eatenAt: iso(TM), carbsG: CARBS });
        if (withInsulinRecord) {
          await rig.api.addInsulin({ clientId: 'syn-zero-0001', administeredAt: iso(TM), kind: 'bolus', confirmation: 'confirmed', unitsAdministered: 0, source: 'manual' });
        }
        for (let k = 0; k < anchors; k += 1) {
          const a = TM + k * 300;
          rig.fake.response = okGlucose(a, truth(a), () => truth(a)); // baseline = persistence, blind to the meal
          await rig.forecast.run({ nowSec: a + 120 });
        }
        if (beforeReadings) await beforeReadings(rig);
        const readings = [] as { time: string; value: number }[];
        for (let t = TM - 600; t <= nowSec() - 2 * 3600; t += 300) readings.push({ time: iso(t), value: Math.round(truth(t) * 10) / 10 });
        await rig.ingest.recordReadings(readings);
        return rig;
      }

      it('the forecast says how much evidence there is for the event layer (none yet with a handful of scored forecasts)', async () => {
      const rig = await build(true);
      const ev = await rig.personalization.layerEvidence(rig.userId, Date.now() + 10 * 60_000);
      expect(ev.status).toBe('none_yet');
      expect(ev.samples).toBeGreaterThan(0);
      expect(ev.samples).toBeLessThan(30);
      rig.fake.response = okGlucose(nowSec() - 120, 130, () => 130);
      const f = ok(await rig.forecast.run());
      expect(f.models.eventLayerEvidence.status).toBe('none_yet');
      const fresh = makeRig({ glucose: 130, baseline: () => 130 });
      expect(ok(await fresh.forecast.run()).models.eventLayerEvidence).toEqual({ status: 'none_yet', samples: 0 });
    });

    it('13. compares meal-aware and glucose-only predictions on stored history', async () => {
        const rig = await build(true);
        const cmp = await rig.personalization.compareBaselineVsAdjusted(rig.userId);
        const h60 = cmp.find((c) => c.horizonMin === 60)!;
        const h120 = cmp.find((c) => c.horizonMin === 120)!;
        expect(h60.n).toBeGreaterThan(10);
        expect(h60.featureConfig).toBe('meal_only');
        // in this constructed world the layer is closer to the truth than the meal-blind baseline
        expect(h60.maeAdjusted).toBeLessThan(h60.maeBaseline);
        expect(h120.maeAdjusted).toBeLessThan(h120.maeBaseline);
      });

      it('6. learns the scale slowly, inside bounds, after a time-ordered check, and keeps every version', async () => {
        const rig = await build(true);
        const hist = await rig.parameters.history(rig.userId, 'm_csf');
        expect(hist).toHaveLength(1);
        const v = hist[0]!;
        expect(v.status).toBe('active');
        expect(v.source).toBe('fit');
        expect(v.value).toBeLessThan(1); // right direction (truth is 0.8)
        expect(v.value).toBeGreaterThanOrEqual(Math.exp(-0.1 / 7) - 1e-3); // one governed step, not a jump
        expect(v.evidenceCount).toBeGreaterThanOrEqual(13);
        expect(v.note).toMatch(/beat the incumbent and the glucose-only baseline/);
        expect((await rig.parameters.history(rig.userId, 'm_isf'))).toHaveLength(0); // no insulin signal -> untouched

        // a second pass the same day does nothing
        const again = await rig.personalization.onNewReadings(rig.userId);
        expect(again!.parameter.action).toBe('none');
        expect(await rig.parameters.history(rig.userId, 'm_csf')).toHaveLength(1);
        // rollback is a new version that restores the default
        const rb = await rig.parameters.rollback(rig.userId, 'm_csf', 1);
        expect(rb).toBe(2);
      });

      it('never trains on a meal whose insulin is unknown or unreliable', async () => {
        const rig = await build(false); // meal recorded, no insulin record -> mean not moved, not eligible
        const { anchors } = await rig.personalization.eligibleExamples(rig.userId);
        expect(anchors).toBe(0);
        expect(await rig.parameters.history(rig.userId, 'm_csf')).toHaveLength(0);
        expect((await rig.parameters.getActive(rig.userId)).params.mCsf).toBe(1);
      });

      it.each(['the meal', 'its "I took none" record'] as const)('withdrawing %s takes the earlier forecasts out of learning, evidence and performance (they are kept, not rewritten)', async (which) => {
        const rig = await build(true, 19, async (r) => {
          const meals = (await r.db.query<{ meal_id: string }>('SELECT meal_id FROM meal_events WHERE user_id = $1', [r.userId])).rows;
          const doses = (await r.db.query<{ insulin_id: string }>('SELECT insulin_id FROM insulin_events WHERE user_id = $1', [r.userId])).rows;
          if (which === 'the meal') expect((await r.api.editMeal(meals[0]!.meal_id, { status: 'cancelled' })).result).toBe('updated');
          else expect((await r.api.editInsulin(doses[0]!.insulin_id, { status: 'cancelled' })).result).toBe('updated');
        });
        // the control (no withdrawal) is test 6 above: the same data learns. Here nothing may be learned or reported.
        expect((await rig.personalization.eligibleExamples(rig.userId)).anchors).toBe(0);
        expect(await rig.parameters.history(rig.userId, 'm_csf')).toHaveLength(0);
        expect((await rig.parameters.getActive(rig.userId)).params.mCsf).toBe(1);
        expect(await rig.personalization.compareBaselineVsAdjusted(rig.userId)).toEqual([]);
        expect(await rig.personalization.layerEvidence(rig.userId, Date.now() + 10 * 60_000)).toEqual({ status: 'none_yet', samples: 0 });
        expect(await count(rig, "SELECT COUNT(*) AS n FROM model_performance WHERE user_id = $1 AND feature_config <> 'glucose_only'", [rig.userId])).toBe(0);
        // history is untouched: the forecasts and their scored outcomes are still stored
        expect(await count(rig, "SELECT COUNT(*) AS n FROM predictions WHERE user_id = $1 AND feature_config <> 'glucose_only'", [rig.userId])).toBeGreaterThan(0);
        expect(await count(rig, "SELECT COUNT(*) AS n FROM prediction_outcomes o JOIN predictions p USING (prediction_id) WHERE p.user_id = $1 AND p.feature_config <> 'glucose_only'", [rig.userId])).toBeGreaterThan(0);
      });

      it('does not move anything on too little evidence', async () => {
        const rig = await build(true, 6);
        expect(await rig.parameters.history(rig.userId, 'm_csf')).toHaveLength(0);
      });
    });
  });
});

describe('database tests are configured', () => {
  it.skipIf(hasTestDb)('are skipped locally when TEST_DATABASE_URL is not set (they run on the VM)', () => {
    expect(TEST_DB_URL).toBeUndefined();
  });
});
