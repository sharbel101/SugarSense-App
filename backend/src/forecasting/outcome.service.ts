import { Inject, Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service.js';

/** A stored prediction is matched to the CGM reading nearest its target time, within this many seconds. */
export const MATCH_TOLERANCE_SEC = 180;
/** Offsets up to this are labelled 'exact'; larger ones within tolerance are 'nearest_within_tolerance'. */
export const EXACT_MATCH_SEC = 60;

/**
 * Retrospective scoring (CLAUDE.md section 11.4): when real CGM readings exist around a stored
 * prediction's target time, write a prediction_outcomes row. Predictions themselves are never touched.
 *
 * A prediction is scored only once the newest reading is at least one tolerance AFTER its target, so a
 * later-arriving closer reading cannot exist inside the window; a target with no reading inside the
 * tolerance (sensor gap) simply stays unscored - missing, not invented or interpolated. The insert is
 * idempotent (one outcome per prediction), so retries and concurrent scorers cannot double-count.
 */
@Injectable()
export class OutcomeService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  async scoreDue(userId: string): Promise<{ scored: number }> {
    const r = await this.db.query<{ prediction_id: string }>(
      `INSERT INTO prediction_outcomes (prediction_id, reading_id, observed_mgdl, observed_at, signed_error_mgdl,
                                        abs_error_mgdl, within_interval, match_offset_sec, matching_quality)
       SELECT p.prediction_id, g.reading_id, g.glucose_mgdl, g.measured_at,
              g.glucose_mgdl - p.predicted_mgdl,
              abs(g.glucose_mgdl - p.predicted_mgdl),
              g.glucose_mgdl BETWEEN p.lower_mgdl AND p.upper_mgdl,
              round(extract(epoch FROM g.measured_at - p.target_at))::int,
              CASE WHEN abs(extract(epoch FROM g.measured_at - p.target_at)) <= $2 THEN 'exact'
                   ELSE 'nearest_within_tolerance' END
         FROM predictions p
        CROSS JOIN LATERAL (
              SELECT r.reading_id, r.glucose_mgdl, r.measured_at
                FROM glucose_readings r
               WHERE r.user_id = p.user_id
                 AND r.measured_at BETWEEN p.target_at - make_interval(secs => $3) AND p.target_at + make_interval(secs => $3)
               ORDER BY abs(extract(epoch FROM r.measured_at - p.target_at)), r.measured_at
               LIMIT 1) g
        WHERE p.user_id = $1
          AND p.target_at <= (SELECT max(measured_at) FROM glucose_readings WHERE user_id = $1) - make_interval(secs => $3)
          AND NOT EXISTS (SELECT 1 FROM prediction_outcomes o WHERE o.prediction_id = p.prediction_id)
       ON CONFLICT (prediction_id) DO NOTHING
       RETURNING prediction_id`,
      [userId, EXACT_MATCH_SEC, MATCH_TOLERANCE_SEC],
    );
    return { scored: r.rowCount ?? 0 };
  }
}
