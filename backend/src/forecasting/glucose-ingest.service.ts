import { Inject, Injectable, Logger } from '@nestjs/common';
import { DbService, describeDbError } from '../db/db.service.js';
import { PersonalizationService } from './personalization.service.js';
import { UsersService } from './users.service.js';

const MIN_PLAUSIBLE = 20;
const MAX_PLAUSIBLE = 600;
const FUTURE_TOLERANCE_SEC = 5 * 60;

export interface IngestResult {
  inserted: number;
  rejected: number;
}

/**
 * Stores CGM readings that reach the backend (CLAUDE.md section 3: mg/dL, UTC, missingness is data).
 * Idempotent: the same reading from the same source cannot be stored twice, so polling and retries are
 * harmless. Implausible or future-dated readings are rejected, never repaired. Nothing is stored that was
 * not measured: no interpolation, no filling.
 */
@Injectable()
export class GlucoseIngestService {
  private readonly logger = new Logger(GlucoseIngestService.name);

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(PersonalizationService) private readonly personalization: PersonalizationService,
  ) {}

  /** Fire-and-forget hook for the glucose proxy: never throws, never delays the response. */
  recordInBackground(points: readonly { time: string; value: number }[]): void {
    if (!this.db.available) return;
    void this.recordReadings(points).catch((err) => this.logger.warn(`ingest failed ${describeDbError(err)}`));
  }

  async recordReadings(
    points: readonly { time: string; value: number }[],
    nowSec: number = Math.floor(Date.now() / 1000),
  ): Promise<IngestResult> {
    const times: string[] = [];
    const values: number[] = [];
    let rejected = 0;
    for (const p of points) {
      const t = Math.floor(Date.parse(p.time) / 1000);
      if (!Number.isFinite(t) || t > nowSec + FUTURE_TOLERANCE_SEC || !(p.value >= MIN_PLAUSIBLE && p.value <= MAX_PLAUSIBLE)) {
        rejected += 1;
        continue;
      }
      times.push(new Date(t * 1000).toISOString());
      values.push(Math.round(p.value * 10) / 10);
    }
    if (times.length === 0) return { inserted: 0, rejected };

    const { userId } = await this.users.primary();
    const r = await this.db.query(
      `INSERT INTO glucose_readings (user_id, measured_at, glucose_mgdl, source)
       SELECT $1, x.t, x.v, 'cgm' FROM unnest($2::timestamptz[], $3::numeric[]) AS x(t, v)
       ON CONFLICT (user_id, source, measured_at) DO NOTHING`,
      [userId, times, values],
    );
    const inserted = r.rowCount ?? 0;
    // New measurements may complete the window of earlier predictions: score them and learn.
    if (inserted > 0) await this.personalization.onNewReadings(userId, nowSec);
    return { inserted, rejected };
  }
}
