import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DbService } from '../db/db.service.js';
import type { MealAnalysisOkResponse } from '../meals/meal-analysis-response.js';
import type { CarbProvenance, InsulinConfirmation, TimeClass } from '../engine/types.js';
import type { CreateInsulinInput, CreateMealInput, EditInsulinInput, EditMealInput } from './events.schema.js';
import { clientIdToUuid } from './client-id.js';
import { toIso, toSec } from './time.js';

/** Late entries are welcome (the window is replayed), but not unboundedly old ones. */
export const MAX_BACKDATE_SEC = 48 * 3600;
export const FUTURE_TOLERANCE_SEC = 5 * 60;
/** Two entries this close in time with the same amount are treated as a probable double entry. */
export const DUPLICATE_WINDOW_SEC = 120;
/** A photo's timestamp is a proxy for when eating started; engineering default for how far off it may be. */
export const PHOTO_TIME_UNCERTAINTY_MIN = 10;

export interface MealRow {
  mealId: string;
  clientUuid: string;
  eatenAtSec: number;
  status: 'draft' | 'confirmed' | 'manual_entry' | 'cancelled';
  carbsG: number | null;
  carbsProvenance: CarbProvenance | null;
  fatG: number | null;
  proteinG: number | null;
  fiberG: number | null;
  glycemicIndex: number | null;
  aiCarbsG: number | null;
  aiCarbsLowG: number | null;
  aiCarbsHighG: number | null;
  eatenAtSource: 'user_entered' | 'photo_time' | 'assumed';
  timingUncertaintyMin: number;
  absorptionClass: TimeClass;
  revision: number;
  userEdited: boolean;
  note: string | null;
  label: string | null;
}

export interface InsulinRow {
  insulinId: string;
  clientUuid: string;
  administeredAtSec: number;
  kind: 'bolus' | 'correction' | 'basal' | 'other';
  insulinType: string | null;
  unitsAdministered: number | null;
  unitsPlanned: number | null;
  confirmation: InsulinConfirmation;
  mealId: string | null;
  timingUncertain: boolean;
  revision: number;
  status: 'active' | 'cancelled';
  /** true when the meal this dose was declared against was withdrawn (cancelled). Only filled by `insulinBetween`. */
  mealCancelled: boolean;
}

type DbMeal = {
  meal_id: string;
  client_uuid: string;
  eaten_at: Date;
  status: MealRow['status'];
  carbs_g: string | null;
  carbs_provenance: CarbProvenance | null;
  fat_g: string | null;
  protein_g: string | null;
  fiber_g: string | null;
  glycemic_index: number | null;
  ai_carbs_g: string | null;
  ai_carbs_low_g: string | null;
  ai_carbs_high_g: string | null;
  eaten_at_source: MealRow['eatenAtSource'];
  timing_uncertainty_min: number;
  absorption_class: TimeClass;
  revision: number;
  user_edited: boolean;
  note: string | null;
  label: string | null;
};

type DbInsulin = {
  insulin_id: string;
  client_uuid: string;
  administered_at: Date;
  kind: InsulinRow['kind'];
  insulin_type: string | null;
  units_administered: string | null;
  units_suggested: string | null;
  confirmation: InsulinConfirmation;
  meal_id: string | null;
  timing_uncertain: boolean;
  revision: number;
  status: 'active' | 'cancelled';
  meal_cancelled?: boolean | null;
};

const num = (v: string | null): number | null => (v === null ? null : Number(v));

const MEAL_COLUMNS = `meal_id, client_uuid, eaten_at, status, carbs_g, carbs_provenance, fat_g, protein_g, fiber_g,
  glycemic_index, ai_carbs_g, ai_carbs_low_g, ai_carbs_high_g, eaten_at_source, timing_uncertainty_min,
  absorption_class, revision, user_edited, note, label`;
const INSULIN_COLUMNS = `insulin_id, client_uuid, administered_at, kind, insulin_type, units_administered,
  units_suggested, confirmation, meal_id, timing_uncertain, revision, status`;

const mapMeal = (r: DbMeal): MealRow => ({
  mealId: r.meal_id,
  clientUuid: r.client_uuid,
  eatenAtSec: Math.floor(r.eaten_at.getTime() / 1000),
  status: r.status,
  carbsG: num(r.carbs_g),
  carbsProvenance: r.carbs_provenance,
  fatG: num(r.fat_g),
  proteinG: num(r.protein_g),
  fiberG: num(r.fiber_g),
  glycemicIndex: r.glycemic_index,
  aiCarbsG: num(r.ai_carbs_g),
  aiCarbsLowG: num(r.ai_carbs_low_g),
  aiCarbsHighG: num(r.ai_carbs_high_g),
  eatenAtSource: r.eaten_at_source,
  timingUncertaintyMin: r.timing_uncertainty_min,
  absorptionClass: r.absorption_class,
  revision: r.revision,
  userEdited: r.user_edited,
  note: r.note,
  label: r.label,
});

const mapInsulin = (r: DbInsulin): InsulinRow => ({
  insulinId: r.insulin_id,
  clientUuid: r.client_uuid,
  administeredAtSec: Math.floor(r.administered_at.getTime() / 1000),
  kind: r.kind,
  insulinType: r.insulin_type,
  unitsAdministered: num(r.units_administered),
  unitsPlanned: num(r.units_suggested),
  confirmation: r.confirmation,
  mealId: r.meal_id,
  timingUncertain: r.timing_uncertain,
  revision: r.revision,
  status: r.status,
  mealCancelled: r.meal_cancelled === true,
});

export type WriteStatus = 'created' | 'exists' | 'duplicate' | 'updated' | 'unchanged' | 'not_found' | 'conflict' | 'invalid';

export interface MealWriteResult {
  status: WriteStatus;
  meal: MealRow | null;
  /** Set for 'duplicate': the entry this one probably repeats. */
  duplicateOf?: string;
  reason?: string;
}
export interface InsulinWriteResult {
  status: WriteStatus;
  insulin: InsulinRow | null;
  duplicateOf?: string;
  reason?: string;
}

/** Validates an event time against the clock; returns an error string or null. */
export function checkEventTime(tSec: number, nowSec: number): string | null {
  if (!Number.isFinite(tSec)) return 'time is not valid';
  if (tSec > nowSec + FUTURE_TOLERANCE_SEC) return 'an event cannot be dated in the future';
  if (tSec < nowSec - MAX_BACKDATE_SEC) return 'event is older than 48 hours';
  return null;
}

@Injectable()
export class EventsService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  // ---------------------------------------------------------------- meals

  async createMeal(userId: string, input: CreateMealInput, nowSec: number = Math.floor(Date.now() / 1000)): Promise<MealWriteResult> {
    const eatenSec = toSec(input.eatenAt);
    const bad = checkEventTime(eatenSec, nowSec);
    if (bad) return { status: 'invalid', meal: null, reason: bad };

    return this.db.tx(async (c) => {
      const existing = await this.mealByClientUuid(c, userId, clientIdToUuid(input.clientId));
      if (existing) return { status: 'exists', meal: existing };

      if (!input.allowDuplicate) {
        const dup = await c.query<{ meal_id: string }>(
          `SELECT meal_id FROM meal_events
            WHERE user_id = $1 AND status <> 'cancelled'
              AND abs(extract(epoch FROM eaten_at - $2::timestamptz)) <= $3
              AND carbs_g IS NOT DISTINCT FROM $4::numeric
              AND client_uuid <> $5
            LIMIT 1`,
          [userId, input.eatenAt, DUPLICATE_WINDOW_SEC, input.carbsG ?? null, clientIdToUuid(input.clientId)],
        );
        if (dup.rows[0]) return { status: 'duplicate', meal: null, duplicateOf: dup.rows[0].meal_id };
      }

      const row = await c.query<DbMeal>(
        `INSERT INTO meal_events (user_id, client_uuid, eaten_at, status, carbs_g, carbs_provenance, fat_g, protein_g,
                                  fiber_g, glycemic_index, eaten_at_source, timing_uncertainty_min, absorption_class, note, label)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'user_entered',$11,$12,$13,$14)
         ON CONFLICT (user_id, client_uuid) DO NOTHING
         RETURNING ${MEAL_COLUMNS}`,
        [
          userId,
          clientIdToUuid(input.clientId),
          input.eatenAt,
          input.carbsG === undefined ? 'draft' : 'manual_entry',
          input.carbsG ?? null,
          input.carbsG === undefined ? null : 'user_entered',
          input.fatG ?? null,
          input.proteinG ?? null,
          input.fiberG ?? null,
          input.glycemicIndex ?? null,
          input.timingUncertaintyMin ?? 0,
          input.absorptionClass ?? 'medium',
          input.note ?? null,
          input.label ?? null,
        ],
      );
      if (!row.rows[0]) {
        // a concurrent request with the same client id won the insert: this one is a repeat of it
        const twin = await this.mealByClientUuid(c, userId, clientIdToUuid(input.clientId));
        return { status: 'exists', meal: twin };
      }
      return { status: 'created', meal: mapMeal(row.rows[0]) };
    });
  }

  /** A validated photo analysis becomes a draft meal event. The full analysis is kept server-side. */
  async createPhotoMeal(
    userId: string,
    args: { clientUuid: string; eatenAtSec: number; analysis: MealAnalysisOkResponse; userNote?: string },
    nowSec: number = Math.floor(Date.now() / 1000),
  ): Promise<MealWriteResult> {
    const bad = checkEventTime(args.eatenAtSec, nowSec);
    if (bad) return { status: 'invalid', meal: null, reason: bad };
    const a = args.analysis;
    return this.db.tx(async (c) => {
      const existing = await this.mealByClientUuid(c, userId, args.clientUuid);
      if (existing) return { status: 'exists', meal: existing };
      const row = await c.query<DbMeal>(
        `INSERT INTO meal_events (user_id, client_uuid, eaten_at, status, carbs_g, carbs_provenance, carbs_sigma_g, fat_g,
                                  protein_g, fiber_g, glycemic_index, gi_confidence, analysis_status, ai_carbs_g,
                                  ai_carbs_low_g, ai_carbs_high_g, ai_confidence, model_version, prompt_version,
                                  analysis_raw, eaten_at_source, timing_uncertainty_min, note, label)
         VALUES ($1,$2,$3,'draft',$4,'estimated',NULL,$5,$6,$7,$8,$9,'ok',$4,$10,$11,$12,$13,$14,$15,'photo_time',$16,$17,$18)
         ON CONFLICT (user_id, client_uuid) DO NOTHING
         RETURNING ${MEAL_COLUMNS}`,
        [
          userId,
          args.clientUuid,
          toIso(args.eatenAtSec),
          a.totalNetCarbsG,
          a.totalFatG,
          a.totalProteinG,
          a.totalFiberG,
          a.estimatedGlycemicIndex === null ? null : Math.round(a.estimatedGlycemicIndex),
          a.glycemicIndexConfidence,
          a.totalCarbsRangeLowG,
          a.totalCarbsRangeHighG,
          overallConfidence(a),
          a.modelVersion,
          a.promptVersion,
          JSON.stringify(a),
          PHOTO_TIME_UNCERTAINTY_MIN,
          args.userNote ?? null,
          photoMealLabel(a.items.map((i) => i.name)),
        ],
      );
      if (!row.rows[0]) {
        const twin = await this.mealByClientUuid(c, userId, args.clientUuid);
        return { status: 'exists', meal: twin };
      }
      const meal = mapMeal(row.rows[0]);
      for (const [i, item] of a.items.entries()) {
        await c.query(
          `INSERT INTO meal_items (meal_id, position, name, portion_description, estimated_grams, carbs_g, calories_kcal, confidence, from_ai)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)`,
          [meal.mealId, i, item.name, item.portionDescription, item.estimatedGrams, item.netCarbsG, item.caloriesKcal, item.confidence],
        );
      }
      return { status: 'created', meal };
    });
  }

  async editMeal(
    userId: string,
    mealId: string,
    patch: EditMealInput,
    nowSec: number = Math.floor(Date.now() / 1000),
  ): Promise<MealWriteResult> {
    if (patch.eatenAt !== undefined) {
      const bad = checkEventTime(toSec(patch.eatenAt), nowSec);
      if (bad) return { status: 'invalid', meal: null, reason: bad };
    }
    return this.db.tx(async (c) => {
      const cur = await c.query<DbMeal>(
        `SELECT ${MEAL_COLUMNS} FROM meal_events WHERE meal_id = $1 AND user_id = $2 FOR UPDATE`,
        [mealId, userId],
      );
      const before = cur.rows[0] ? mapMeal(cur.rows[0]) : null;
      if (!before) return { status: 'not_found', meal: null };
      if (before.status === 'cancelled') {
        // Withdrawing twice is not an error (an offline retry may repeat it, with an old revision); nothing else may be done to it.
        if (patch.status === 'cancelled') return { status: 'unchanged', meal: before };
        return { status: 'invalid', meal: before, reason: 'a cancelled entry cannot be edited' };
      }
      if (patch.expectedRevision !== undefined && patch.expectedRevision !== before.revision) {
        return { status: 'conflict', meal: before, reason: 'the meal was changed since you loaded it' };
      }

      const next: MealRow = { ...before };
      if (patch.carbsG !== undefined) next.carbsG = patch.carbsG;
      if (patch.fatG !== undefined) next.fatG = patch.fatG;
      if (patch.proteinG !== undefined) next.proteinG = patch.proteinG;
      if (patch.fiberG !== undefined) next.fiberG = patch.fiberG;
      if (patch.glycemicIndex !== undefined) next.glycemicIndex = patch.glycemicIndex;
      if (patch.absorptionClass !== undefined) next.absorptionClass = patch.absorptionClass;
      if (patch.timingUncertaintyMin !== undefined) next.timingUncertaintyMin = patch.timingUncertaintyMin;
      if (patch.note !== undefined) next.note = patch.note;
      if (patch.label !== undefined) next.label = patch.label;
      if (patch.eatenAt !== undefined) {
        next.eatenAtSec = toSec(patch.eatenAt);
        next.eatenAtSource = 'user_entered';
        // the user stated the time: the photo-time uncertainty no longer applies unless they set one
        if (patch.timingUncertaintyMin === undefined) next.timingUncertaintyMin = 0;
      }
      const carbsChanged = patch.carbsG !== undefined && patch.carbsG !== before.carbsG;
      if (carbsChanged) {
        // A number a person typed over an AI estimate is user-corrected; over nothing, user-entered.
        next.carbsProvenance = before.carbsProvenance === 'estimated' || before.carbsProvenance === 'user_corrected' ? 'user_corrected' : 'user_entered';
        next.userEdited = before.carbsProvenance === 'estimated' || before.carbsProvenance === 'user_corrected' || before.userEdited;
      }
      if (patch.status !== undefined) {
        if (patch.status === 'confirmed' && next.carbsG === null) {
          return { status: 'invalid', meal: before, reason: 'carbohydrates must be known to confirm a meal' };
        }
        next.status = patch.status;
      }

      const changed = JSON.stringify(stripRevision(before)) !== JSON.stringify(stripRevision(next));
      if (!changed) return { status: 'unchanged', meal: before };

      const updated = await c.query<DbMeal>(
        `UPDATE meal_events SET eaten_at = $3, status = $4, carbs_g = $5, carbs_provenance = $6, fat_g = $7, protein_g = $8,
                fiber_g = $9, glycemic_index = $10, absorption_class = $11, timing_uncertainty_min = $12,
                eaten_at_source = $13, user_edited = $14, note = $15, label = $16, revision = revision + 1
          WHERE meal_id = $1 AND user_id = $2 RETURNING ${MEAL_COLUMNS}`,
        [
          mealId,
          userId,
          toIso(next.eatenAtSec),
          next.status,
          next.carbsG,
          next.carbsProvenance,
          next.fatG,
          next.proteinG,
          next.fiberG,
          next.glycemicIndex,
          next.absorptionClass,
          next.timingUncertaintyMin,
          next.eatenAtSource,
          next.userEdited,
          next.note,
          next.label,
        ],
      );
      const after = mapMeal(updated.rows[0] as DbMeal);
      await c.query(
        `INSERT INTO event_revisions (entity_type, entity_id, revision, reason, before_state, after_state)
         VALUES ('meal', $1, $2, $3, $4, $5)`,
        [mealId, after.revision, 'user_edit', JSON.stringify(before), JSON.stringify(after)],
      );
      // Every correction of a number is kept as a labelled pair (CLAUDE.md section 9: capture from day one).
      for (const [field, oldV, newV] of [
        ['carbs_g', before.carbsG, after.carbsG],
        ['fat_g', before.fatG, after.fatG],
        ['protein_g', before.proteinG, after.proteinG],
        ['fiber_g', before.fiberG, after.fiberG],
      ] as const) {
        if (oldV !== newV) {
          await c.query(
            'INSERT INTO meal_corrections (meal_id, field, old_value, new_value) VALUES ($1,$2,$3,$4)',
            [mealId, field, oldV, newV],
          );
        }
      }
      return { status: 'updated', meal: after };
    });
  }

  // -------------------------------------------------------------- insulin

  async createInsulin(userId: string, input: CreateInsulinInput, nowSec: number = Math.floor(Date.now() / 1000)): Promise<InsulinWriteResult> {
    const tSec = toSec(input.administeredAt);
    // A planned dose may be dated now; a delivered one may not be in the future.
    const bad = checkEventTime(tSec, nowSec);
    if (bad) return { status: 'invalid', insulin: null, reason: bad };

    return this.db.tx(async (c) => {
      const existing = await c.query<DbInsulin>(
        `SELECT ${INSULIN_COLUMNS} FROM insulin_events WHERE user_id = $1 AND client_uuid = $2`,
        [userId, clientIdToUuid(input.clientId)],
      );
      if (existing.rows[0]) return { status: 'exists', insulin: mapInsulin(existing.rows[0]) };

      if (input.mealId) {
        const m = await c.query('SELECT 1 FROM meal_events WHERE meal_id = $1 AND user_id = $2', [input.mealId, userId]);
        if (m.rowCount === 0) return { status: 'invalid', insulin: null, reason: 'mealId does not belong to this user' };
      }
      if (!input.allowDuplicate && input.confirmation !== 'planned') {
        const dup = await c.query<{ insulin_id: string }>(
          `SELECT insulin_id FROM insulin_events
            WHERE user_id = $1 AND kind = $2 AND confirmation <> 'planned' AND status = 'active'
              AND abs(extract(epoch FROM administered_at - $3::timestamptz)) <= $4
              AND units_administered IS NOT DISTINCT FROM $5::numeric
              AND client_uuid <> $6
            LIMIT 1`,
          [userId, input.kind, input.administeredAt, DUPLICATE_WINDOW_SEC, input.unitsAdministered ?? null, clientIdToUuid(input.clientId)],
        );
        if (dup.rows[0]) return { status: 'duplicate', insulin: null, duplicateOf: dup.rows[0].insulin_id };
      }
      const row = await c.query<DbInsulin>(
        `INSERT INTO insulin_events (user_id, client_uuid, administered_at, kind, insulin_type, units_administered,
                                     units_suggested, confirmation, source, meal_id, timing_uncertain)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (user_id, client_uuid) DO NOTHING
         RETURNING ${INSULIN_COLUMNS}`,
        [
          userId,
          clientIdToUuid(input.clientId),
          input.administeredAt,
          input.kind,
          input.insulinType ?? null,
          input.confirmation === 'planned' ? null : (input.unitsAdministered ?? null),
          input.confirmation === 'planned' ? (input.plannedUnits ?? null) : null,
          input.confirmation,
          input.source,
          input.mealId ?? null,
          input.timingUncertain ?? false,
        ],
      );
      if (!row.rows[0]) {
        const twin = await c.query<DbInsulin>(
          `SELECT ${INSULIN_COLUMNS} FROM insulin_events WHERE user_id = $1 AND client_uuid = $2`,
          [userId, clientIdToUuid(input.clientId)],
        );
        return { status: 'exists', insulin: twin.rows[0] ? mapInsulin(twin.rows[0]) : null };
      }
      return { status: 'created', insulin: mapInsulin(row.rows[0]) };
    });
  }

  async editInsulin(
    userId: string,
    insulinId: string,
    patch: EditInsulinInput,
    nowSec: number = Math.floor(Date.now() / 1000),
  ): Promise<InsulinWriteResult> {
    if (patch.administeredAt !== undefined) {
      const bad = checkEventTime(toSec(patch.administeredAt), nowSec);
      if (bad) return { status: 'invalid', insulin: null, reason: bad };
    }
    return this.db.tx(async (c) => {
      const cur = await c.query<DbInsulin>(
        `SELECT ${INSULIN_COLUMNS} FROM insulin_events WHERE insulin_id = $1 AND user_id = $2 FOR UPDATE`,
        [insulinId, userId],
      );
      const before = cur.rows[0] ? mapInsulin(cur.rows[0]) : null;
      if (!before) return { status: 'not_found', insulin: null };
      if (before.status === 'cancelled') {
        // Withdrawing twice is not an error (an offline retry may repeat it, with an old revision); nothing else may be done to it.
        if (patch.status === 'cancelled') return { status: 'unchanged', insulin: before };
        return { status: 'invalid', insulin: before, reason: 'a cancelled entry cannot be edited' };
      }
      if (patch.expectedRevision !== undefined && patch.expectedRevision !== before.revision) {
        return { status: 'conflict', insulin: before, reason: 'the entry was changed since you loaded it' };
      }
      if (patch.mealId) {
        const m = await c.query('SELECT 1 FROM meal_events WHERE meal_id = $1 AND user_id = $2', [patch.mealId, userId]);
        if (m.rowCount === 0) return { status: 'invalid', insulin: before, reason: 'mealId does not belong to this user' };
      }
      const next: InsulinRow = { ...before };
      if (patch.status === 'cancelled') next.status = 'cancelled';
      if (patch.unitsAdministered !== undefined) next.unitsAdministered = patch.unitsAdministered;
      if (patch.administeredAt !== undefined) next.administeredAtSec = toSec(patch.administeredAt);
      if (patch.mealId !== undefined) next.mealId = patch.mealId;
      if (patch.timingUncertain !== undefined) next.timingUncertain = patch.timingUncertain;
      if (patch.confirmation !== undefined) next.confirmation = patch.confirmation;
      // Confirming a planned dose means it was taken: it then needs the amount actually taken.
      if (before.confirmation === 'planned' && patch.confirmation !== undefined && next.unitsAdministered === null) {
        return { status: 'invalid', insulin: before, reason: 'give unitsAdministered to record that the planned dose was taken' };
      }
      if (before.confirmation === 'planned' && patch.confirmation === undefined && patch.unitsAdministered !== undefined) {
        return { status: 'invalid', insulin: before, reason: 'a planned dose has not been administered; set confirmation as well' };
      }
      if (next.confirmation === 'confirmed' && next.unitsAdministered === null) {
        return { status: 'invalid', insulin: before, reason: 'a confirmed dose needs unitsAdministered' };
      }
      if (JSON.stringify(stripRevision(before)) === JSON.stringify(stripRevision(next))) {
        return { status: 'unchanged', insulin: before };
      }
      const updated = await c.query<DbInsulin>(
        `UPDATE insulin_events SET administered_at = $3, units_administered = $4, units_suggested = $5, confirmation = $6,
                meal_id = $7, timing_uncertain = $8, status = $9, revision = revision + 1
          WHERE insulin_id = $1 AND user_id = $2 RETURNING ${INSULIN_COLUMNS}`,
        [
          insulinId,
          userId,
          toIso(next.administeredAtSec),
          next.confirmation === 'planned' ? null : next.unitsAdministered,
          next.unitsPlanned,
          next.confirmation,
          next.mealId,
          next.timingUncertain,
          next.status,
        ],
      );
      const after = mapInsulin(updated.rows[0] as DbInsulin);
      await c.query(
        `INSERT INTO event_revisions (entity_type, entity_id, revision, reason, before_state, after_state)
         VALUES ('insulin', $1, $2, $3, $4, $5)`,
        [insulinId, after.revision, 'user_edit', JSON.stringify(before), JSON.stringify(after)],
      );
      return { status: 'updated', insulin: after };
    });
  }

  // ---------------------------------------------------------------- reads

  async mealById(userId: string, mealId: string): Promise<MealRow | null> {
    const r = await this.db.query<DbMeal>(`SELECT ${MEAL_COLUMNS} FROM meal_events WHERE meal_id = $1 AND user_id = $2`, [mealId, userId]);
    return r.rows[0] ? mapMeal(r.rows[0]) : null;
  }

  /** Non-cancelled meals in [fromSec, toSec], oldest first. */
  async mealsBetween(userId: string, fromSec: number, toSec_: number): Promise<MealRow[]> {
    const r = await this.db.query<DbMeal>(
      `SELECT ${MEAL_COLUMNS} FROM meal_events
        WHERE user_id = $1 AND status <> 'cancelled' AND eaten_at BETWEEN $2 AND $3
        ORDER BY eaten_at, meal_id`,
      [userId, toIso(fromSec), toIso(toSec_)],
    );
    return r.rows.map(mapMeal);
  }

  async insulinBetween(userId: string, fromSec: number, toSec_: number): Promise<InsulinRow[]> {
    const r = await this.db.query<DbInsulin>(
      `SELECT ${INSULIN_COLUMNS},
              (SELECT m.status = 'cancelled' FROM meal_events m WHERE m.meal_id = insulin_events.meal_id) AS meal_cancelled
         FROM insulin_events
        WHERE user_id = $1 AND status = 'active' AND administered_at BETWEEN $2 AND $3
        ORDER BY administered_at, insulin_id`,
      [userId, toIso(fromSec), toIso(toSec_)],
    );
    return r.rows.map(mapInsulin);
  }

  private async mealByClientUuid(c: PoolClient, userId: string, clientUuid: string): Promise<MealRow | null> {
    const r = await c.query<DbMeal>(`SELECT ${MEAL_COLUMNS} FROM meal_events WHERE user_id = $1 AND client_uuid = $2`, [userId, clientUuid]);
    return r.rows[0] ? mapMeal(r.rows[0]) : null;
  }
}

const stripRevision = <T extends { revision: number }>(row: T): Omit<T, 'revision'> => {
  const { revision: _revision, ...rest } = row;
  return rest;
};

/** Coarse overall confidence of a photo estimate: the weakest item decides, then the width of the range. */
export function overallConfidence(a: MealAnalysisOkResponse): 'low' | 'medium' | 'high' {
  const order = { low: 0, medium: 1, high: 2 } as const;
  const weakest = a.items.reduce<'low' | 'medium' | 'high'>((acc, i) => (order[i.confidence] < order[acc] ? i.confidence : acc), 'high');
  const width = a.totalNetCarbsG > 0 ? (a.totalCarbsRangeHighG - a.totalCarbsRangeLowG) / a.totalNetCarbsG : 0;
  if (width > 0.6) return 'low';
  if (width > 0.3 && weakest === 'high') return 'medium';
  return weakest;
}

/** A short name for a photo meal from its items, in the existing "A + B" style (max 80 characters). */
export function photoMealLabel(itemNames: readonly string[]): string | null {
  const names = itemNames.map((n) => n.trim()).filter((n) => n.length > 0);
  if (names.length === 0) return null;
  const shown = names.slice(0, 2).join(' + ');
  const label = names.length > 2 ? `${shown} + more` : shown;
  return label.length > 80 ? `${label.slice(0, 77)}...` : label;
}
