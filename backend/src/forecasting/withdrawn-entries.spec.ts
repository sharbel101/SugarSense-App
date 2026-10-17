import { describe, expect, it } from 'vitest';
import { DEFAULT_ENGINE_PARAMS } from '../engine/params.js';
import { editInsulinSchema, editMealSchema } from './events.schema.js';
import type { InsulinRow } from './events.service.js';
import { buildEngineInputs } from './forecast.service.js';
import { NO_WITHDRAWN_EVENTS } from './personalization.service.js';

const doseRow = (over: Partial<InsulinRow> = {}): InsulinRow => ({
  insulinId: 'i1',
  clientUuid: 'c1',
  administeredAtSec: 1_792_000_000 - 600,
  kind: 'bolus',
  insulinType: 'rapid',
  unitsAdministered: 4,
  unitsPlanned: null,
  confirmation: 'confirmed',
  mealId: 'm-gone',
  timingUncertain: false,
  revision: 1,
  status: 'active',
  mealCancelled: false,
  ...over,
});

describe('withdrawing entries - what the API accepts', () => {
  it('both edit routes accept status "cancelled" with the revision the app sends', () => {
    expect(editMealSchema.safeParse({ status: 'cancelled', expectedRevision: 3 }).success).toBe(true);
    expect(editInsulinSchema.safeParse({ status: 'cancelled', expectedRevision: 3 }).success).toBe(true);
  });

  it('an insulin entry can only be withdrawn, never re-activated or given another status', () => {
    for (const status of ['active', 'confirmed', 'deleted', 'CANCELLED', '']) {
      expect(editInsulinSchema.safeParse({ status }).success, status).toBe(false);
    }
    expect(editMealSchema.safeParse({ status: 'deleted' }).success).toBe(false);
  });
});

describe('withdrawing entries - how a dose is read when its meal was withdrawn', () => {
  it('the engine input says so, and only then', () => {
    const gone = buildEngineInputs({ mealRows: [], insulinRows: [doseRow({ mealCancelled: true })], resolver: null, params: DEFAULT_ENGINE_PARAMS, anchorSec: 1_792_000_000 });
    expect(gone.insulin).toHaveLength(1);
    expect(gone.insulin[0]).toMatchObject({ declaredMealId: 'm-gone', declaredMealCancelled: true });
    const live = buildEngineInputs({ mealRows: [], insulinRows: [doseRow()], resolver: null, params: DEFAULT_ENGINE_PARAMS, anchorSec: 1_792_000_000 });
    expect(live.insulin[0]).not.toHaveProperty('declaredMealCancelled'); // field absent: stored run inputs of normal runs are unchanged
  });
});

describe('withdrawing entries - learning and evidence skip forecasts that relied on them', () => {
  it('the shared SQL condition looks at meals, doses and the dose linked to a meal, by run', () => {
    const sql = NO_WITHDRAWN_EVENTS('p');
    expect(sql).toMatch(/NOT EXISTS/);
    expect(sql).toMatch(/l\.run_id = p\.run_id/);
    expect(sql).toMatch(/me\.status = 'cancelled'/);
    expect(sql).toMatch(/ie\.status = 'cancelled'/);
    expect(sql).toMatch(/li\.status = 'cancelled'/);
  });
});
