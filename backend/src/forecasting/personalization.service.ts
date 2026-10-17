import { Inject, Injectable, Logger } from '@nestjs/common';
import { DbService, describeDbError } from '../db/db.service.js';
import { governedStep, validateCandidate, type FitExample } from '../engine/fit.js';
import { ENGINE_LAYER_VERSION } from '../engine/params.js';
import { OutcomeService } from './outcome.service.js';
import { ParametersService } from './parameters.service.js';

/** Horizons used to learn the scales: those inside the glucose-only model's measured range. */
const FIT_HORIZONS_MIN = [60, 120];
/** At most one parameter update per this many hours (spec: daily, rate-limited). */
export const MIN_HOURS_BETWEEN_UPDATES = 20;
/** Distinct forecast anchors needed before any update is considered (information gate n/(n+30) >= 0.3). */
export const MIN_EVIDENCE_ANCHORS = 13;
export const ROLLING_WINDOW_DAYS = 14;

export interface UpdateReport {
  outcomesScored: number;
  performanceRowsWritten: number;
  parameter:
    | { action: 'none'; reason: string }
    | { action: 'proposed' | 'promoted'; reason: string; mCsf: number; mIsf: number; testN: number; maeBaseline: number; maeCurrent: number; maeCandidate: number };
}

/** How the stored outcomes judge the event layer against the glucose-only baseline (shown, never claimed). */
export interface LayerEvidence {
  /**
   * none_yet = too few scored forecasts with logged events to say anything;
   * supports = lower error than the baseline at 30, 60 and 120 min; against = higher at all three; mixed = otherwise.
   */
  status: 'none_yet' | 'supports' | 'against' | 'mixed';
  /** Smallest number of scored forecasts behind any of the three horizons. */
  samples: number;
}

/** Scored forecasts needed at EACH of 30, 60 and 120 min before any verdict other than none_yet. */
export const EVIDENCE_MIN_SAMPLES = 30;
const EVIDENCE_TTL_MS = 5 * 60_000;

export interface HorizonComparison {
  horizonMin: number;
  featureConfig: string;
  n: number;
  maeBaseline: number;
  maeAdjusted: number;
  rmseBaseline: number;
  rmseAdjusted: number;
  /** Fraction of observed values inside the adjusted 80% interval. */
  coverageAdjusted: number;
  coverageBaseline: number;
}

/**
 * The recursive part: every time new CGM readings arrive, (1) match them to earlier predictions,
 * (2) roll the per-horizon error statistics forward, (3) at most daily, consider a small governed move
 * of the two personal scales. Nothing here rewrites a prediction or an equation; parameter changes are
 * new versions that are only activated after a time-ordered check against the glucose-only baseline.
 */
@Injectable()
export class PersonalizationService {
  private readonly logger = new Logger(PersonalizationService.name);
  private readonly evidenceCache = new Map<string, { at: number; value: LayerEvidence }>();

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(OutcomeService) private readonly outcomes: OutcomeService,
    @Inject(ParametersService) private readonly parameters: ParametersService,
  ) {}

  /** Entry point called after new readings were stored. Never throws. */
  async onNewReadings(userId: string, nowSec: number = Math.floor(Date.now() / 1000)): Promise<UpdateReport | null> {
    try {
      const { scored } = await this.outcomes.scoreDue(userId);
      const performanceRowsWritten = await this.recordPerformance(userId);
      const parameter = scored > 0 ? await this.considerParameterUpdate(userId, nowSec) : ({ action: 'none', reason: 'no new outcomes' } as const);
      return { outcomesScored: scored, performanceRowsWritten, parameter };
    } catch (err) {
      this.logger.warn(`personalisation pass failed ${describeDbError(err)}`);
      return null;
    }
  }

  /** Rolling error statistics by horizon, model and feature configuration (hourly snapshot per group). */
  async recordPerformance(userId: string): Promise<number> {
    const r = await this.db.query(
      `INSERT INTO model_performance (user_id, model_version, feature_config, horizon_min, window_start, window_end,
                                      sample_count, mae_mgdl, rmse_mgdl, bias_mgdl, interval_coverage, nominal_coverage)
       SELECT p.user_id, p.model_version, p.feature_config, p.horizon_min,
              date_trunc('hour', now()) - make_interval(days => $2), date_trunc('hour', now()),
              COUNT(*), round(AVG(o.abs_error_mgdl)::numeric, 2),
              round(SQRT(AVG(o.signed_error_mgdl * o.signed_error_mgdl))::numeric, 2),
              round(AVG(o.signed_error_mgdl)::numeric, 2),
              round(AVG((o.within_interval)::int)::numeric, 3), 0.80
         FROM predictions p JOIN prediction_outcomes o USING (prediction_id)
        WHERE p.user_id = $1 AND o.observed_at > now() - make_interval(days => $2)
        GROUP BY p.user_id, p.model_version, p.feature_config, p.horizon_min
       ON CONFLICT ON CONSTRAINT model_performance_dedupe DO NOTHING`,
      [userId, ROLLING_WINDOW_DAYS],
    );
    return r.rowCount ?? 0;
  }

  /** Eligible stored examples, oldest first, one per (anchor, horizon): the latest forecast made for it. */
  async eligibleExamples(userId: string): Promise<{ anchors: number; examples: FitExample[] }> {
    const r = await this.db.query<{ anchor_at: Date; base: string; c: string; i: string; obs: string }>(
      `SELECT * FROM (
         SELECT DISTINCT ON (p.anchor_at, p.horizon_min)
                p.anchor_at,
                (p.input_snapshot->>'baselinePredMgdl')::float8 AS base,
                (p.input_snapshot->>'mealEffectUnscaled')::float8 AS c,
                (p.input_snapshot->>'insulinEffectUnscaled')::float8 AS i,
                o.observed_mgdl::float8 AS obs
           FROM predictions p JOIN prediction_outcomes o USING (prediction_id)
          WHERE p.user_id = $1 AND p.model_version LIKE $2 AND p.horizon_min = ANY($3::int[])
            AND p.feature_config <> 'glucose_only'
            AND (p.input_snapshot->>'eligible')::boolean IS TRUE
          ORDER BY p.anchor_at, p.horizon_min, p.created_at DESC) x
       ORDER BY anchor_at`,
      [userId, `${ENGINE_LAYER_VERSION}%`, FIT_HORIZONS_MIN],
    );
    const anchors = new Set(r.rows.map((x) => x.anchor_at.getTime())).size;
    return {
      anchors,
      examples: r.rows.map((x) => ({ base: Number(x.base), c: Number(x.c), i: Number(x.i), obs: Number(x.obs) })),
    };
  }

  async considerParameterUpdate(userId: string, nowSec: number): Promise<UpdateReport['parameter']> {
    const last = await this.db.query<{ t: Date | null }>(
      "SELECT max(updated_at) AS t FROM model_parameters WHERE user_id = $1 AND source = 'fit'",
      [userId],
    );
    const lastT = last.rows[0]?.t;
    if (lastT && nowSec - lastT.getTime() / 1000 < MIN_HOURS_BETWEEN_UPDATES * 3600) {
      return { action: 'none', reason: 'a parameter update was already made in the last 20 hours' };
    }
    const { anchors, examples } = await this.eligibleExamples(userId);
    if (anchors < MIN_EVIDENCE_ANCHORS) {
      return { action: 'none', reason: `not enough reliable examples yet (${anchors} of ${MIN_EVIDENCE_ANCHORS} forecast moments)` };
    }
    const active = await this.parameters.getActive(userId);
    const current = { mCsf: active.params.mCsf, mIsf: active.params.mIsf };
    const decision = validateCandidate(examples, current);
    const step = governedStep(examples, current);
    const unchanged = Math.abs(step.mCsf - current.mCsf) < 1e-4 && Math.abs(step.mIsf - current.mIsf) < 1e-4;
    if (unchanged) return { action: 'none', reason: 'the data do not justify moving either scale' };

    const note = decision.promote ? decision.reason : `kept as proposal: ${decision.reason}`;
    await this.db.tx(async (c) => {
      for (const [name, value, was] of [
        ['m_csf', step.mCsf, current.mCsf],
        ['m_isf', step.mIsf, current.mIsf],
      ] as const) {
        if (Math.abs(value - was) < 1e-4) continue;
        await this.parameters.insertVersion(c, userId, {
          name,
          value,
          status: decision.promote ? 'active' : 'proposed',
          source: 'fit',
          evidenceCount: anchors,
          uncertaintySd: null,
          note,
        });
      }
    });
    return {
      action: decision.promote ? 'promoted' : 'proposed',
      reason: decision.reason,
      mCsf: step.mCsf,
      mIsf: step.mIsf,
      testN: decision.testN,
      maeBaseline: decision.maeBaseline,
      maeCurrent: decision.maeCurrent,
      maeCandidate: decision.maeCandidate,
    };
  }

  /** Verdict of the stored outcomes on the event layer; cached for a few minutes. Never throws. */
  async layerEvidence(userId: string, nowMs: number = Date.now()): Promise<LayerEvidence> {
    const hit = this.evidenceCache.get(userId);
    if (hit && nowMs - hit.at < EVIDENCE_TTL_MS) return hit.value;
    let value: LayerEvidence = { status: 'none_yet', samples: 0 };
    try {
      const rows = await this.compareBaselineVsAdjusted(userId);
      const per = [30, 60, 120].map((h) => {
        const r = rows.filter((x) => x.horizonMin === h);
        const n = r.reduce((a, x) => a + x.n, 0);
        const mae = (key: 'maeBaseline' | 'maeAdjusted') => (n === 0 ? 0 : r.reduce((a, x) => a + x[key] * x.n, 0) / n);
        return { n, base: mae('maeBaseline'), adj: mae('maeAdjusted') };
      });
      const samples = Math.min(...per.map((x) => x.n));
      if (samples >= EVIDENCE_MIN_SAMPLES) {
        const better = per.filter((x) => x.adj < x.base).length;
        value = { status: better === 3 ? 'supports' : better === 0 ? 'against' : 'mixed', samples };
      } else {
        value = { status: 'none_yet', samples };
      }
    } catch (err) {
      this.logger.warn(`evidence not computed ${describeDbError(err)}`);
    }
    this.evidenceCache.set(userId, { at: nowMs, value });
    return value;
  }

  /**
   * Historical comparison of the meal-aware layer against the glucose-only baseline on the same
   * anchors and horizons, from stored outcomes. Reports numbers only; it claims nothing by itself.
   */
  async compareBaselineVsAdjusted(userId: string, sinceIso?: string): Promise<HorizonComparison[]> {
    const r = await this.db.query<{
      horizon_min: number;
      feature_config: string;
      n: string;
      mae_b: string;
      mae_a: string;
      rmse_b: string;
      rmse_a: string;
      cov_a: string;
      cov_b: string;
    }>(
      `SELECT a.horizon_min, a.feature_config, COUNT(*) AS n,
              AVG(ob.abs_error_mgdl) AS mae_b, AVG(oa.abs_error_mgdl) AS mae_a,
              SQRT(AVG(ob.signed_error_mgdl * ob.signed_error_mgdl)) AS rmse_b,
              SQRT(AVG(oa.signed_error_mgdl * oa.signed_error_mgdl)) AS rmse_a,
              AVG((oa.within_interval)::int) AS cov_a, AVG((ob.within_interval)::int) AS cov_b
         FROM predictions a
         JOIN predictions b ON b.run_id = a.run_id AND b.horizon_min = a.horizon_min AND b.feature_config = 'glucose_only'
         JOIN prediction_outcomes oa ON oa.prediction_id = a.prediction_id
         JOIN prediction_outcomes ob ON ob.prediction_id = b.prediction_id
        WHERE a.user_id = $1 AND a.model_version LIKE $2 AND a.feature_config <> 'glucose_only'
          AND ($3::timestamptz IS NULL OR a.anchor_at >= $3::timestamptz)
        GROUP BY a.horizon_min, a.feature_config
        ORDER BY a.horizon_min, a.feature_config`,
      [userId, `${ENGINE_LAYER_VERSION}%`, sinceIso ?? null],
    );
    return r.rows.map((x) => ({
      horizonMin: x.horizon_min,
      featureConfig: x.feature_config,
      n: Number(x.n),
      maeBaseline: Number(x.mae_b),
      maeAdjusted: Number(x.mae_a),
      rmseBaseline: Number(x.rmse_b),
      rmseAdjusted: Number(x.rmse_a),
      coverageAdjusted: Number(x.cov_a),
      coverageBaseline: Number(x.cov_b),
    }));
  }
}
