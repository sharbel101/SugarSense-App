import { describe, expect, it } from 'vitest';
import { linkMealsToInsulin } from '../engine/coverage.js';
import { DEFAULT_ENGINE_PARAMS } from '../engine/params.js';
import { editInsulinSchema, editMealSchema } from './events.schema.js';
import type { InsulinRow } from './events.service.js';
import { buildEngineInputs, toLinkable } from './forecast.service.js';
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
  mealNotCounted: false,
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

describe('withdrawing entries - a dose named against a withdrawn meal is read as if no meal had been named', () => {
  it('the engine input and the linking input drop the named meal, and only when it was withdrawn', () => {
    const gone = buildEngineInputs({ mealRows: [], insulinRows: [doseRow({ mealNotCounted: true })], resolver: null, params: DEFAULT_ENGINE_PARAMS, anchorSec: 1_792_000_000 });
    expect(gone.insulin).toHaveLength(1);
    expect(gone.insulin[0]).toMatchObject({ declaredMealId: null });
    const live = buildEngineInputs({ mealRows: [], insulinRows: [doseRow()], resolver: null, params: DEFAULT_ENGINE_PARAMS, anchorSec: 1_792_000_000 });
    expect(live.insulin[0]).toMatchObject({ declaredMealId: 'm-gone' });
    expect(toLinkable(doseRow({ mealNotCounted: true })).declaredMealId).toBeNull();
    expect(toLinkable(doseRow()).declaredMealId).toBe('m-gone');
  });

  it('so a re-scanned photo works: the dose pairs with the replacement meal logged around it', () => {
    const t = 1_792_000_000;
    const links = linkMealsToInsulin([{ id: 'replacement', tSec: t }], [toLinkable(doseRow({ mealNotCounted: true, administeredAtSec: t + 30 }))]);
    expect(links[0]).toMatchObject({ mealId: 'replacement', status: 'linked_auto', insulinIds: ['i1'], unitsTotal: 4 });
    // while a dose that names a live meal is not borrowed by another one
    const live = linkMealsToInsulin([{ id: 'other', tSec: t }], [toLinkable(doseRow({ administeredAtSec: t + 30 }))]);
    expect(live[0]).toMatchObject({ mealId: 'other', status: 'none_recorded' });
  });
});

describe('withdrawing entries - learning and evidence skip forecasts that relied on them', () => {
  it('the shared SQL condition looks at meals, doses and the dose linked to a meal, by run', () => {
    const sql = NO_WITHDRAWN_EVENTS('p');
    expect(sql).toMatch(/NOT EXISTS/);
    expect(sql).toMatch(/l\.run_id = p\.run_id/);
    expect(sql).toMatch(/me\.status IN \('cancelled', 'draft'\)/);
    expect(sql).toMatch(/ie\.status = 'cancelled'/);
    expect(sql).toMatch(/li\.status = 'cancelled'/);
  });
});
