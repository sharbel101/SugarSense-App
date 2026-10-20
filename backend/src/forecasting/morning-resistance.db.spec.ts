import { BadRequestException } from '@nestjs/common';
import { afterAll, describe, expect, it } from 'vitest';
import { closeAll, hasTestDb, iso, makeRig, nowSec, type Rig } from '../../test/forecasting-rig.js';
import type { ForecastOkDisplay } from './forecast-response.js';
import { localDayKey, localDayStartSec } from './time.js';
import { therapySettingsSchema } from './therapy.schema.js';

const base = { icrSegments: [{ startMinute: 0, gramsPerUnit: 10 }], isfSegments: [{ startMinute: 0, mgdlPerUnit: 50 }], source: 'user_entered' as const };

describe('therapy schema: morning insulin resistance', () => {
  it('accepts yes / no / yes with a percent, and nothing else', () => {
    expect(therapySettingsSchema.safeParse({ ...base, morningInsulinResistance: true }).success).toBe(true);
    expect(therapySettingsSchema.safeParse({ ...base, morningInsulinResistance: false }).success).toBe(true);
    expect(therapySettingsSchema.safeParse({ ...base, morningInsulinResistance: true, morningResistancePercent: 30 }).success).toBe(true);
    expect(therapySettingsSchema.safeParse({ ...base, morningInsulinResistance: true, morningResistancePercent: 50 }).success).toBe(true);
    expect(therapySettingsSchema.safeParse({ ...base }).success).toBe(true); // omitted = keep the previous answer
  });

  it('rejects a percent with "no", a percent above 50, a negative percent, more than one decimal and a non-boolean answer', () => {
    expect(therapySettingsSchema.safeParse({ ...base, morningInsulinResistance: false, morningResistancePercent: 20 }).success).toBe(false);
    expect(therapySettingsSchema.safeParse({ ...base, morningInsulinResistance: true, morningResistancePercent: 51 }).success).toBe(false);
    expect(therapySettingsSchema.safeParse({ ...base, morningInsulinResistance: true, morningResistancePercent: -1 }).success).toBe(false);
    expect(therapySettingsSchema.safeParse({ ...base, morningInsulinResistance: true, morningResistancePercent: 12.34 }).success).toBe(false);
    expect(therapySettingsSchema.safeParse({ ...base, morningInsulinResistance: 'yes' }).success).toBe(false);
  });
});

type Snapshot = { inputs: { insulin: { units: number; morningResistanceRel?: number }[] } };

describe.skipIf(!hasTestDb)('morning insulin resistance on PostgreSQL', () => {
  afterAll(closeAll);

  async function setup(morning: boolean): Promise<Rig> {
    const rig = makeRig({ glucose: 150, baseline: () => 150 });
    await rig.users.primary();
    await rig.therapy.setSettings(rig.userId, { ...base, ...(morning ? { morningInsulinResistance: true } : {}), effectiveFrom: iso(nowSec() - 3 * 24 * 3600) });
    return rig;
  }
  const dose = (rig: Rig, id: string, agoMin: number, units: number) =>
    rig.api.addInsulin({ clientId: id, administeredAt: iso(nowSec() - agoMin * 60), kind: 'correction', confirmation: 'confirmed', unitsAdministered: units, source: 'manual' });
  const at = (f: ForecastOkDisplay, m: number) => f.points.find((p) => p.minutes === m)!;
  const lastSnapshot = async (rig: Rig): Promise<Snapshot> =>
    (await rig.db.query<{ snap: Snapshot }>('SELECT input_snapshot AS snap FROM forecast_runs WHERE user_id = $1 ORDER BY run_id DESC LIMIT 1', [rig.userId])).rows[0]!.snap;

  it('stores the answer with each version, carries it over, and drops the percent when the answer is no', async () => {
    const rig = makeRig();
    await rig.users.primary();
    const v0 = await rig.therapy.setSettings(rig.userId, { ...base });
    expect(v0).toMatchObject({ morningInsulinResistance: false, morningResistancePercent: null, morningResistanceUsedPercent: null, morningResistanceDefaultPercent: 25 });
    const yes = await rig.therapy.setSettings(rig.userId, { ...base, morningInsulinResistance: true });
    expect(yes).toMatchObject({ morningInsulinResistance: true, morningResistancePercent: null, morningResistanceUsedPercent: 25 }); // the default applies
    expect(yes.morningResistanceExplanation).toMatch(/never changes a dose/);
    const thirty = await rig.therapy.setSettings(rig.userId, { ...base, morningInsulinResistance: true, morningResistancePercent: 30 });
    expect(thirty).toMatchObject({ morningResistancePercent: 30, morningResistanceUsedPercent: 30 });
    const kept = await rig.therapy.setSettings(rig.userId, { ...base, icrSegments: [{ startMinute: 0, gramsPerUnit: 9 }] }); // an ICR-only edit keeps the answer
    expect(kept).toMatchObject({ morningInsulinResistance: true, morningResistancePercent: 30, morningResistanceUsedPercent: 30 });
    const no = await rig.therapy.setSettings(rig.userId, { ...base, morningInsulinResistance: false });
    expect(no).toMatchObject({ morningInsulinResistance: false, morningResistancePercent: null, morningResistanceUsedPercent: null });
    const stillNo = await rig.therapy.setSettings(rig.userId, { ...base });
    expect(stillNo.morningInsulinResistance).toBe(false);
    await expect(rig.therapy.setSettings(rig.userId, { ...base, morningResistancePercent: 20 })).rejects.toBeInstanceOf(BadRequestException); // a percent needs "yes"
    const history = await rig.therapy.history(rig.userId);
    expect(history.map((h) => h.morningInsulinResistance).reverse()).toEqual([false, true, true, true, false, false]); // every change is a new immutable version
  });

  it('the first dose of the day acts with less effect when the answer is yes, and the forecast says so', async () => {
    const withMorning = await setup(true);
    const without = await setup(false);
    for (const rig of [withMorning, without]) await dose(rig, 'first-dose-001', 10, 4);
    const a = (await withMorning.forecast.run()) as ForecastOkDisplay;
    const b = (await without.forecast.run()) as ForecastOkDisplay;
    expect(a.status).toBe('ok');
    // 4 U x 50 mg/dL per U: the same dose leaves glucose higher when it works at 1/1.25 of its usual strength
    expect(at(a, 120).adjusted - at(b, 120).adjusted).toBeGreaterThan(5);
    expect(a.notes.join(' ')).toMatch(/Morning insulin resistance is on: .*25%/);
    expect(b.notes.join(' ')).not.toMatch(/Morning insulin resistance/);
    expect(at(a, 30).insulinOnBoardUnits).toBe(at(b, 30).insulinOnBoardUnits); // the dose and the units on board are not changed
    expect((await lastSnapshot(withMorning)).inputs.insulin[0]).toMatchObject({ units: 4, morningResistanceRel: 0.25 }); // reproducible from the stored inputs
  });

  it('only the first dose of the local day is affected; a later dose the same day acts normally', async () => {
    const now = nowSec();
    if (localDayKey(now - 4000, 'UTC') !== localDayKey(now, 'UTC')) return; // within ~1 h after 03:00 UTC the two doses would fall on different days
    const rig = await setup(true);
    await dose(rig, 'first-dose-002', 70, 3);
    await dose(rig, 'second-dose-02', 10, 2);
    await rig.forecast.run();
    const ins = (await lastSnapshot(rig)).inputs.insulin;
    expect(ins.find((i) => i.units === 3)).toMatchObject({ morningResistanceRel: 0.25 });
    expect(ins.find((i) => i.units === 2)?.morningResistanceRel).toBeUndefined();
  });

  it('a dose from earlier today, beyond the 8 h look-back, still makes a later dose "not the first"', async () => {
    const now = nowSec();
    const dayStart = localDayStartSec(now, 'UTC');
    if (now - dayStart < 10 * 3600) return; // needs the day to be at least 10 h old
    const rig = await setup(true);
    await rig.api.addInsulin({ clientId: 'early-dose-0001', administeredAt: iso(dayStart + 600), kind: 'correction', confirmation: 'confirmed', unitsAdministered: 2, source: 'manual' });
    await dose(rig, 'later-dose-0001', 20, 3);
    await rig.forecast.run();
    const ins = (await lastSnapshot(rig)).inputs.insulin;
    expect(ins.length).toBe(1); // the early dose is outside the engine's window
    expect(ins[0]?.morningResistanceRel).toBeUndefined();
  });

  it('a what-if dose entered before anything else today is treated as the first dose', async () => {
    const rig = await setup(true);
    const f = (await rig.forecast.preview({ insulinUnits: 4 } as never)) as ForecastOkDisplay;
    expect(f.status).toBe('ok');
    expect(f.notes.join(' ')).toMatch(/Morning insulin resistance is on/);
  });
});
