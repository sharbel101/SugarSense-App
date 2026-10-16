import { Inject, Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service.js';
import type { ForecastPoint } from '../engine/compose.js';
import { INTERVAL_LEVEL, TRACKED_HORIZONS_MIN, Z80 } from '../engine/params.js';
import type { RunInputs } from '../engine/run.js';
import type { EventDisposition, EventLayerResult, LinkStatus } from '../engine/types.js';
import type { CarbCoverage } from '../engine/coverage.js';
import type { ResolvedTherapy } from './therapy.service.js';
import { toIso } from './time.js';

export interface EventLinkRecord {
  disposition: EventDisposition;
  eventTimeSec: number;
  revision: number;
  carbsG: number | null;
  carbsProvenance: 'estimated' | 'user_corrected' | 'user_entered' | null;
  insulinUnits: number | null;
  insulinConfirmation: 'confirmed' | 'uncertain' | 'planned' | null;
  linkStatus: LinkStatus | null;
  linkedInsulinId: string | null;
  coverage: CarbCoverage | null;
}

export interface PersistArgs {
  userId: string;
  inputs: RunInputs;
  inputsHash: string;
  baselineModel: string;
  layerModel: string;
  parameterLabel: string;
  therapy: ResolvedTherapy;
  layer: EventLayerResult;
  points: ForecastPoint[];
  eligible: boolean;
  eventLinks: EventLinkRecord[];
  /** The complete normalised inputs and a few derived values, for replay and audit. */
  snapshot: Record<string, unknown>;
}

const LINK_TYPE: Record<LinkStatus, string> = {
  linked_declared: 'declared',
  linked_auto: 'auto_time_window',
  confirmed_none: 'confirmed_none',
  none_recorded: 'none_recorded',
  ambiguous: 'ambiguous',
};

const r1 = (v: number): number => Math.round(v * 10) / 10;

/**
 * Writes a forecast BEFORE its outcome is known, once, immutably. The ICR, ISF and therapy version used
 * are copied into the rows, so changing the ratio later cannot alter what a historical prediction says it
 * used. Identical inputs hash to the same run, so polling and retries are idempotent.
 */
@Injectable()
export class PredictionStore {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  async persist(a: PersistArgs): Promise<{ runId: string; created: boolean }> {
    return this.db.tx(async (c) => {
      const run = await c.query<{ run_id: string }>(
        `INSERT INTO forecast_runs (user_id, anchor_at, inputs_hash, baseline_model, layer_version, parameter_version,
                                    feature_config, therapy_profile_id, icr_status, trajectory, input_snapshot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (user_id, anchor_at, inputs_hash) DO NOTHING
         RETURNING run_id`,
        [
          a.userId,
          toIso(a.inputs.anchorSec),
          a.inputsHash,
          a.baselineModel,
          a.inputs.layerVersion,
          a.parameterLabel,
          a.layer.featureConfig,
          a.therapy.profileId,
          a.therapy.icrStatus,
          JSON.stringify(a.points),
          JSON.stringify(a.snapshot),
        ],
      );
      if (!run.rows[0]) {
        const existing = await c.query<{ run_id: string }>(
          'SELECT run_id FROM forecast_runs WHERE user_id = $1 AND anchor_at = $2 AND inputs_hash = $3',
          [a.userId, toIso(a.inputs.anchorSec), a.inputsHash],
        );
        return { runId: (existing.rows[0] as { run_id: string }).run_id, created: false };
      }
      const runId = run.rows[0].run_id;

      for (const l of a.eventLinks) {
        const d = l.disposition;
        await c.query(
          `INSERT INTO prediction_event_links (run_id, meal_id, insulin_id, role, role_reason, event_time, event_revision,
                                               carbs_g, carbs_provenance, insulin_units, insulin_confirmation, link_type,
                                               linked_insulin_id, coverage_g, carbs_minus_coverage_g)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [
            runId,
            d.eventType === 'meal' ? d.id : null,
            d.eventType === 'insulin' ? d.id : null,
            d.role,
            d.reason,
            toIso(l.eventTimeSec),
            l.revision,
            l.carbsG,
            l.carbsProvenance,
            l.insulinUnits,
            l.insulinConfirmation,
            l.linkStatus === null ? null : LINK_TYPE[l.linkStatus],
            l.linkedInsulinId,
            l.coverage ? r1(l.coverage.coverageG) : null,
            l.coverage ? r1(l.coverage.carbsMinusCoverageG) : null,
          ],
        );
      }

      const heldBaseline = a.inputs.baseline.length > 0 ? (a.inputs.baseline[a.inputs.baseline.length - 1] as { value: number }).value : null;
      const sigma = (minutes: number): number => {
        const k = a.inputs.baselineSigmaKnots;
        for (let i = 1; i < k.length; i += 1) {
          const [x1, y1] = k[i] as [number, number];
          const [x0, y0] = k[i - 1] as [number, number];
          if (minutes <= x1) return y0 + ((y1 - y0) * (minutes - x0)) / (x1 - x0);
        }
        return (k[k.length - 1] as [number, number])[1];
      };
      const hasEvents = a.layer.dispositions.some((d) => d.role === 'applied' || d.role === 'scenario_only');
      const series = a.layer.series;

      const insertPrediction = (row: {
        horizon: number;
        predicted: number;
        low: number;
        high: number;
        model: string;
        parameterVersion: string;
        featureConfig: string;
        snapshot: Record<string, unknown>;
      }) =>
        c.query(
          `INSERT INTO predictions (user_id, run_id, anchor_at, target_at, horizon_min, predicted_mgdl, lower_mgdl, upper_mgdl,
                                    interval_level, model_version, parameter_version, input_snapshot, feature_config, inputs_hash,
                                    therapy_profile_id, icr_status, icr_g_per_u, isf_mgdl_per_u)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
           ON CONFLICT ON CONSTRAINT predictions_dedupe DO NOTHING`,
          [
            a.userId,
            runId,
            toIso(a.inputs.anchorSec),
            toIso(a.inputs.anchorSec + row.horizon * 60),
            row.horizon,
            row.predicted,
            row.low,
            row.high,
            INTERVAL_LEVEL,
            row.model,
            row.parameterVersion,
            JSON.stringify(row.snapshot),
            row.featureConfig,
            a.inputsHash,
            a.therapy.profileId,
            a.therapy.icrStatus,
            a.therapy.icrGPerU,
            a.therapy.isfMgdlPerU,
          ],
        );

      for (const h of TRACKED_HORIZONS_MIN) {
        const p = a.points.find((x) => x.minutes === h);
        if (!p) continue;
        const j = h / 5 - 1;
        if (p.baseline !== null) {
          const s = sigma(h);
          await insertPrediction({
            horizon: h,
            predicted: p.baseline,
            low: r1(p.baseline - Z80 * s),
            high: r1(p.baseline + Z80 * s),
            model: a.baselineModel,
            parameterVersion: 'none',
            featureConfig: 'glucose_only',
            snapshot: { role: 'glucose_only_baseline', sigmaBaseline: r1(s) },
          });
        }
        if (hasEvents) {
          await insertPrediction({
            horizon: h,
            predicted: p.adjusted,
            low: p.low,
            high: p.high,
            model: a.layerModel,
            parameterVersion: a.parameterLabel,
            featureConfig: a.layer.featureConfig,
            snapshot: {
              role: 'meal_aware',
              baselinePredMgdl: p.baseline ?? heldBaseline,
              mealEffectUnscaled: series.mealEffect[j],
              insulinEffectUnscaled: series.insulinEffect[j],
              mCsf: a.inputs.params.mCsf,
              mIsf: a.inputs.params.mIsf,
              scenarioUp: series.scenarioUp[j],
              scenarioDown: series.scenarioDown[j],
              sigma: {
                baseline: r1(sigma(h)),
                carb: r1(series.sigmaCarb[j] as number),
                insulin: r1(series.sigmaInsulin[j] as number),
                timing: r1(series.sigmaTiming[j] as number),
                fatProtein: r1(series.sigmaFatProtein[j] as number),
              },
              extension: p.extension,
              eligible: a.eligible && !p.extension,
              clipped: p.clipped,
            },
          });
        }
      }
      return { runId, created: true };
    });
  }
}
