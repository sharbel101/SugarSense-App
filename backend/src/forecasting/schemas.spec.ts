import { describe, expect, it } from 'vitest';
import { clientIdToUuid, uuidFromSha256 } from './client-id.js';
import { createInsulinSchema, createMealSchema, editInsulinSchema, editMealSchema } from './events.schema.js';
import { therapySettingsSchema } from './therapy.schema.js';
import { isValidTimeZone, localMinuteOfDay } from './time.js';
import { TherapyResolver, type TherapyProfile } from './therapy.service.js';

const base = { source: 'user_entered' as const };

describe('therapy settings schema (ICR is grams per unit of rapid-acting insulin)', () => {
  it('accepts a day-long set of segments', () => {
    const r = therapySettingsSchema.safeParse({
      ...base,
      icrSegments: [{ startMinute: 0, gramsPerUnit: 12 }, { startMinute: 660, gramsPerUnit: 9.5 }],
      isfSegments: [{ startMinute: 0, mgdlPerUnit: 45 }],
    });
    expect(r.success).toBe(true);
  });

  it.each([
    ['zero ratio', [{ startMinute: 0, gramsPerUnit: 0 }]],
    ['negative ratio', [{ startMinute: 0, gramsPerUnit: -4 }]],
    ['absurdly large ratio', [{ startMinute: 0, gramsPerUnit: 500 }]],
    ['three decimals', [{ startMinute: 0, gramsPerUnit: 10.123 }]],
    ['does not start at midnight', [{ startMinute: 60, gramsPerUnit: 10 }]],
    ['segments out of order', [{ startMinute: 0, gramsPerUnit: 10 }, { startMinute: 600, gramsPerUnit: 9 }, { startMinute: 300, gramsPerUnit: 8 }]],
    ['duplicate start', [{ startMinute: 0, gramsPerUnit: 10 }, { startMinute: 0, gramsPerUnit: 9 }]],
    ['minute out of range', [{ startMinute: 0, gramsPerUnit: 10 }, { startMinute: 1500, gramsPerUnit: 9 }]],
    ['empty', []],
  ])('rejects %s', (_label, icrSegments) => {
    expect(therapySettingsSchema.safeParse({ ...base, icrSegments }).success).toBe(false);
  });

  it('accepts an IANA time zone and rejects anything else', () => {
    const ok = { ...base, icrSegments: [{ startMinute: 0, gramsPerUnit: 10 }] };
    expect(therapySettingsSchema.safeParse({ ...ok, timezone: 'Asia/Beirut' }).success).toBe(true);
    expect(therapySettingsSchema.safeParse({ ...ok, timezone: 'Mars/Olympus' }).success).toBe(false);
    expect(therapySettingsSchema.safeParse({ ...ok, timezone: '' }).success).toBe(false);
  });

  it('rejects unknown fields, a missing source and an impossible insulin curve', () => {
    const icrSegments = [{ startMinute: 0, gramsPerUnit: 10 }];
    expect(therapySettingsSchema.safeParse({ icrSegments, source: 'user_entered', autoAdjust: true }).success).toBe(false);
    expect(therapySettingsSchema.safeParse({ icrSegments }).success).toBe(false);
    expect(therapySettingsSchema.safeParse({ ...base, icrSegments, insulinPeakMin: 200, insulinDurationMin: 300 }).success).toBe(false);
  });
});

describe('event schemas', () => {
  const when = '2026-10-16T08:00:00Z';

  it('a planned dose has planned units and no administered units; a taken dose the reverse', () => {
    const planned = { clientId: 'dose-12345678', administeredAt: when, kind: 'bolus', confirmation: 'planned', source: 'manual' };
    expect(createInsulinSchema.safeParse({ ...planned, plannedUnits: 4 }).success).toBe(true);
    expect(createInsulinSchema.safeParse({ ...planned, plannedUnits: 4, unitsAdministered: 4 }).success).toBe(false);
    expect(createInsulinSchema.safeParse(planned).success).toBe(false);
    const taken = { ...planned, confirmation: 'confirmed' };
    expect(createInsulinSchema.safeParse({ ...taken, unitsAdministered: 4 }).success).toBe(true);
    expect(createInsulinSchema.safeParse({ ...taken, unitsAdministered: 0 }).success).toBe(true); // confirmed none
    expect(createInsulinSchema.safeParse(taken).success).toBe(false); // amount missing
    expect(createInsulinSchema.safeParse({ ...taken, unitsAdministered: 400 }).success).toBe(false);
    expect(createInsulinSchema.safeParse({ ...taken, unitsAdministered: 1.234 }).success).toBe(false);
  });

  it('meals: unknown carbs may be omitted, never negative or above 400 g', () => {
    const m = { clientId: 'meal-12345678', eatenAt: when };
    expect(createMealSchema.safeParse(m).success).toBe(true);
    expect(createMealSchema.safeParse({ ...m, carbsG: 0 }).success).toBe(true);
    expect(createMealSchema.safeParse({ ...m, carbsG: -1 }).success).toBe(false);
    expect(createMealSchema.safeParse({ ...m, carbsG: 401 }).success).toBe(false);
    expect(createMealSchema.safeParse({ ...m, carbsG: 20, surprise: 1 }).success).toBe(false);
    expect(editMealSchema.safeParse({}).success).toBe(false);
    expect(editMealSchema.safeParse({ expectedRevision: 1 }).success).toBe(false);
    expect(editMealSchema.safeParse({ carbsG: 33, expectedRevision: 1 }).success).toBe(true);
  });

  it('labels are 1-80 characters; only cancelling is allowed as an insulin status change', () => {
    const m = { clientId: 'meal-12345678', eatenAt: when };
    expect(createMealSchema.safeParse({ ...m, label: 'Pasta' }).success).toBe(true);
    expect(createMealSchema.safeParse({ ...m, label: '' }).success).toBe(false);
    expect(createMealSchema.safeParse({ ...m, label: 'x'.repeat(81) }).success).toBe(false);
    expect(editInsulinSchema.safeParse({ status: 'cancelled' }).success).toBe(true);
    expect(editInsulinSchema.safeParse({ status: 'active' }).success).toBe(false);
  });
});

describe('client ids', () => {
  it('keep real UUIDs and map any other id to a stable UUID', () => {
    const real = '3f2b8c1e-6a4d-4e0b-9d7a-1c2b3a4d5e6f';
    expect(clientIdToUuid(real)).toBe(real);
    const a = clientIdToUuid('18f0ab12-9c3d5e7f-a1b2c3d4');
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(clientIdToUuid('18f0ab12-9c3d5e7f-a1b2c3d4')).toBe(a);
    expect(clientIdToUuid('18f0ab12-9c3d5e7f-a1b2c3d5')).not.toBe(a);
    expect(uuidFromSha256('a'.repeat(64))).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('time zones and ratio segments', () => {
  it('computes minutes after local midnight without daylight-saving surprises', () => {
    const noonUtc = Date.UTC(2026, 6, 1, 12, 0, 0) / 1000;
    expect(localMinuteOfDay(noonUtc, 'UTC')).toBe(720);
    expect(localMinuteOfDay(noonUtc, 'Asia/Kolkata')).toBe(17 * 60 + 30);
    expect(localMinuteOfDay(noonUtc, 'Not/AZone')).toBe(720); // invalid zone falls back to UTC
    expect(isValidTimeZone('Asia/Beirut')).toBe(true);
    expect(isValidTimeZone('nope')).toBe(false);
  });

  const profile = (over: Partial<TherapyProfile>): TherapyProfile => ({
    profileId: 1, version: 1, effectiveFromSec: 1000, source: 'user_entered', insulinType: null,
    insulinPeakMin: null, insulinDurationMin: null, note: null, createdAtSec: 1000,
    icr: [{ startMinute: 0, value: 12 }, { startMinute: 720, value: 8 }], isf: [{ startMinute: 0, value: 50 }], ...over,
  });

  it('picks the newest version in force at that instant, never a later one', () => {
    const r = new TherapyResolver(
      [profile({}), profile({ profileId: 2, version: 2, effectiveFromSec: 5000, icr: [{ startMinute: 0, value: 20 }] })],
      'UTC',
    );
    // before any version existed, the first one entered is what applies (nothing else was in force)
    expect(r.at(999)).toMatchObject({ version: 1, icrGPerU: 12 });
    expect(r.at(1000).icrGPerU).toBe(12);
    expect(r.at(4999).version).toBe(1);
    expect(r.at(5000)).toMatchObject({ version: 2, icrGPerU: 20 });
  });

  it('with no profile at all the ratio is unavailable, never a default', () => {
    expect(new TherapyResolver([], 'UTC').at(5000)).toMatchObject({ icrStatus: 'unavailable', icrGPerU: null, isfMgdlPerU: null, version: null });
  });

  it('a profile without ISF resolves the ratio but not the correction factor (null, not a default)', () => {
    const r = new TherapyResolver([profile({ isf: [] })], 'UTC');
    expect(r.at(2000)).toMatchObject({ icrStatus: 'available', icrGPerU: 12, isfMgdlPerU: null });
  });
});
