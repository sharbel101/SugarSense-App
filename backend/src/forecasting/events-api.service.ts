import { Inject, Injectable, Logger } from '@nestjs/common';
import { DbService, describeDbError } from '../db/db.service.js';
import type { CreateInsulinInput, CreateMealInput, EditInsulinInput, EditMealInput } from './events.schema.js';
import {
  EventsService,
  type InsulinRow,
  type InsulinWriteResult,
  type MealRow,
  type MealWriteResult,
  type WriteStatus,
} from './events.service.js';
import { ForecastService, type MealCoverageView } from './forecast.service.js';
import type { ForecastDisplay } from './forecast-response.js';
import { UsersService } from './users.service.js';
import { toIso } from './time.js';

/** What a UI sees of a meal: display and edit fields only. The raw model response stays on the server. */
export interface MealView {
  id: string;
  /** Short name for lists; null when none was given. */
  label: string | null;
  eatenAt: string;
  status: MealRow['status'];
  carbs: {
    grams: number | null;
    kind: 'estimated' | 'user_corrected' | 'user_entered' | 'missing';
    /** Photo estimate range; present only while the value is still the unedited estimate. */
    estimateRangeG: { low: number; high: number } | null;
  };
  fatG: number | null;
  proteinG: number | null;
  fiberG: number | null;
  glycemicIndex: number | null;
  absorptionClass: MealRow['absorptionClass'];
  /** Minutes the stated time may be off; 0 = trusted. */
  timeApproximateMin: number;
  edited: boolean;
  revision: number;
}

export interface InsulinView {
  id: string;
  administeredAt: string;
  kind: InsulinRow['kind'];
  insulinType: string | null;
  /** Units actually taken; null while unknown or planned. */
  unitsTaken: number | null;
  /** Units the user said they intended to take; kept after the dose is recorded as taken (intent is not a dose). */
  unitsPlanned: number | null;
  confirmation: InsulinRow['confirmation'];
  mealId: string | null;
  /** 'cancelled' = withdrawn as a mistake; kept in the history, ignored by the forecast. */
  status: InsulinRow['status'];
  revision: number;
}

export function toMealView(m: MealRow): MealView {
  const untouchedEstimate = m.carbsProvenance === 'estimated' && m.carbsG === m.aiCarbsG;
  return {
    id: m.mealId,
    label: m.label,
    eatenAt: toIso(m.eatenAtSec),
    status: m.status,
    carbs: {
      grams: m.carbsG,
      kind: m.carbsProvenance ?? 'missing',
      estimateRangeG:
        untouchedEstimate && m.aiCarbsLowG !== null && m.aiCarbsHighG !== null ? { low: m.aiCarbsLowG, high: m.aiCarbsHighG } : null,
    },
    fatG: m.fatG,
    proteinG: m.proteinG,
    fiberG: m.fiberG,
    glycemicIndex: m.glycemicIndex,
    absorptionClass: m.absorptionClass,
    timeApproximateMin: m.timingUncertaintyMin,
    edited: m.userEdited,
    revision: m.revision,
  };
}

export function toInsulinView(i: InsulinRow): InsulinView {
  return {
    id: i.insulinId,
    administeredAt: toIso(i.administeredAtSec),
    kind: i.kind,
    insulinType: i.insulinType,
    unitsTaken: i.confirmation === 'planned' ? null : i.unitsAdministered,
    unitsPlanned: i.unitsPlanned,
    confirmation: i.confirmation,
    mealId: i.mealId,
    status: i.status,
    revision: i.revision,
  };
}

export interface MealWriteResponse {
  result: WriteStatus;
  meal: MealView | null;
  duplicateOf?: string;
  reason?: string;
  /** Refreshed forecast; null when the write did not change anything or could not be refreshed. */
  forecast: ForecastDisplay | null;
}
export interface InsulinWriteResponse {
  result: WriteStatus;
  insulin: InsulinView | null;
  duplicateOf?: string;
  reason?: string;
  forecast: ForecastDisplay | null;
}

const CHANGED: ReadonlySet<WriteStatus> = new Set(['created', 'updated']);

/**
 * The single entry for manual and photo-derived events: write through the validated event service, then
 * refresh the forecast automatically. A failed refresh never fails the write (the event is the source of
 * truth); the response says the forecast is not available instead.
 */
@Injectable()
export class EventsApiService {
  private readonly logger = new Logger(EventsApiService.name);

  constructor(
    @Inject(EventsService) private readonly events: EventsService,
    @Inject(ForecastService) private readonly forecast: ForecastService,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(DbService) private readonly db: DbService,
  ) {}

  async addMeal(input: CreateMealInput): Promise<MealWriteResponse> {
    const { userId } = await this.users.primary();
    const r = await this.events.createMeal(userId, input);
    return this.finishMeal(r);
  }

  async editMeal(mealId: string, patch: EditMealInput): Promise<MealWriteResponse> {
    const { userId } = await this.users.primary();
    const r = await this.events.editMeal(userId, mealId, patch);
    // Withdrawing an entry that is already withdrawn changes nothing, but the repeat (an offline retry) still gets the current forecast.
    return this.finishMeal(r, r.status === 'unchanged' && r.meal?.status === 'cancelled');
  }

  async addInsulin(input: CreateInsulinInput): Promise<InsulinWriteResponse> {
    const { userId } = await this.users.primary();
    const r = await this.events.createInsulin(userId, input);
    return this.finishInsulin(r);
  }

  async editInsulin(insulinId: string, patch: EditInsulinInput): Promise<InsulinWriteResponse> {
    const { userId } = await this.users.primary();
    const r = await this.events.editInsulin(userId, insulinId, patch);
    return this.finishInsulin(r, r.status === 'unchanged' && r.insulin?.status === 'cancelled');
  }

  /** Recent entries a UI can list, e.g. to let someone choose meals for the what-if view. */
  async recent(hours: number): Promise<{ meals: MealView[]; insulin: InsulinView[] }> {
    const { userId } = await this.users.primary();
    const now = Math.floor(Date.now() / 1000);
    const from = now - Math.min(48, Math.max(1, hours)) * 3600;
    const [meals, insulin] = await Promise.all([
      this.events.mealsBetween(userId, from, now + 300),
      this.events.insulinBetween(userId, from, now + 300),
    ]);
    return { meals: meals.map(toMealView), insulin: insulin.map(toInsulinView) };
  }

  mealCoverage(mealId: string): Promise<MealCoverageView | null> {
    return this.forecast.mealCoverage(mealId);
  }

  private async finishMeal(r: MealWriteResult, alsoRefresh = false): Promise<MealWriteResponse> {
    return {
      result: r.status,
      meal: r.meal ? toMealView(r.meal) : null,
      ...(r.duplicateOf ? { duplicateOf: r.duplicateOf } : {}),
      ...(r.reason ? { reason: r.reason } : {}),
      forecast: CHANGED.has(r.status) || alsoRefresh ? await this.refresh() : null,
    };
  }

  private async finishInsulin(r: InsulinWriteResult, alsoRefresh = false): Promise<InsulinWriteResponse> {
    return {
      result: r.status,
      insulin: r.insulin ? toInsulinView(r.insulin) : null,
      ...(r.duplicateOf ? { duplicateOf: r.duplicateOf } : {}),
      ...(r.reason ? { reason: r.reason } : {}),
      forecast: CHANGED.has(r.status) || alsoRefresh ? await this.refresh() : null,
    };
  }

  private async refresh(): Promise<ForecastDisplay | null> {
    try {
      return await this.forecast.run();
    } catch (err) {
      this.logger.warn(`forecast refresh failed ${describeDbError(err)}`);
      return null;
    }
  }
}
