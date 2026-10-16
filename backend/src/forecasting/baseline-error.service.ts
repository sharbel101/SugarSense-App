import { Inject, Injectable } from '@nestjs/common';
import { DbService, describeDbError } from '../db/db.service.js';
import { priorBaselineSigma, type BaselineSigmaFn } from '../engine/compose.js';
import { TRACKED_HORIZONS_MIN } from '../engine/params.js';

/** Shrinkage constant (CLAUDE.md section 7: k ~ 30): empirical weight = n / (n + k). */
export const SIGMA_SHRINKAGE_K = 30;
const WINDOW_DAYS = 60;

/**
 * 1-sigma of the glucose-only baseline error per horizon. Starts from the measured prior curve and
 * moves toward this system's own stored outcomes as they accumulate (only baseline predictions made
 * with no events in play, scored against real CGM values). Pure function of what is in the database.
 */
@Injectable()
export class BaselineErrorService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  async sigmaFn(userId: string, baselineModel: string): Promise<BaselineSigmaFn> {
    let rows: { horizon_min: number; n: string; rmse: string }[] = [];
    try {
      const r = await this.db.query<{ horizon_min: number; n: string; rmse: string }>(
        `SELECT p.horizon_min, COUNT(*) AS n, SQRT(AVG(o.signed_error_mgdl * o.signed_error_mgdl)) AS rmse
           FROM predictions p JOIN prediction_outcomes o USING (prediction_id)
          WHERE p.user_id = $1 AND p.model_version = $2 AND p.feature_config = 'glucose_only'
            AND p.target_at > now() - make_interval(days => $3)
          GROUP BY p.horizon_min`,
        [userId, baselineModel, WINDOW_DAYS],
      );
      rows = r.rows;
    } catch (err) {
      // Statistics are an improvement, never a requirement: fall back to the measured prior.
      void describeDbError(err);
    }
    const byH = new Map(rows.map((x) => [x.horizon_min, { n: Number(x.n), rmse: Number(x.rmse) }]));
    const knots: [number, number][] = [[0, 0]];
    for (const h of TRACKED_HORIZONS_MIN) {
      const prior = priorBaselineSigma(h);
      const e = byH.get(h);
      const w = e ? e.n / (e.n + SIGMA_SHRINKAGE_K) : 0;
      knots.push([h, e ? w * e.rmse + (1 - w) * prior : prior]);
    }
    return (minutes: number): number => {
      if (byH.size === 0) return priorBaselineSigma(minutes);
      const last = knots[knots.length - 1] as [number, number];
      if (minutes >= last[0]) return last[1];
      for (let i = 1; i < knots.length; i += 1) {
        const [x1, y1] = knots[i] as [number, number];
        const [x0, y0] = knots[i - 1] as [number, number];
        if (minutes <= x1) return y0 + ((y1 - y0) * (minutes - x0)) / (x1 - x0);
      }
      return last[1];
    };
  }
}
