import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DbService } from '../db/db.service.js';
import { DEFAULT_ENGINE_PARAMS, PARAM_BOUNDS } from '../engine/params.js';
import type { EngineParams } from '../engine/types.js';

export type ScaleName = 'm_csf' | 'm_isf';
export const SCALE_NAMES: readonly ScaleName[] = ['m_csf', 'm_isf'];

export interface ActiveParameters {
  params: EngineParams;
  /** e.g. "m_csf=v3,m_isf=default" - stored on every prediction so it can be reproduced. */
  label: string;
  versions: Record<ScaleName, number | null>;
}

export interface ParameterRow {
  name: ScaleName;
  version: number;
  value: number;
  status: 'proposed' | 'active' | 'retired';
  source: 'prior' | 'fit' | 'rollback' | 'manual';
  evidenceCount: number;
  note: string | null;
}

/**
 * Versioned storage for the two bounded personal scales (spec section 8: s_CSF, s_ISF). A new fit is
 * always a NEW row; history is never edited. Only `status` may change afterwards (the database grants
 * the application role UPDATE on that one column).
 */
@Injectable()
export class ParametersService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  async getActive(userId: string): Promise<ActiveParameters> {
    const r = await this.db.query<{ name: ScaleName; version: number; value: string }>(
      `SELECT DISTINCT ON (name) name, version, value
         FROM model_parameters
        WHERE (user_id = $1 OR user_id IS NULL) AND name = ANY($2::text[]) AND status = 'active'
        ORDER BY name, (user_id IS NULL), version DESC`,
      [userId, SCALE_NAMES],
    );
    const versions: Record<ScaleName, number | null> = { m_csf: null, m_isf: null };
    const params: EngineParams = { ...DEFAULT_ENGINE_PARAMS };
    for (const row of r.rows) {
      versions[row.name] = row.version;
      if (row.name === 'm_csf') params.mCsf = Number(row.value);
      else params.mIsf = Number(row.value);
    }
    const label = SCALE_NAMES.map((n) => `${n}=${versions[n] === null ? 'default' : `v${versions[n]}`}`).join(',');
    return { params, label, versions };
  }

  async history(userId: string, name: ScaleName): Promise<ParameterRow[]> {
    const r = await this.db.query<{
      version: number;
      value: string;
      status: ParameterRow['status'];
      source: ParameterRow['source'];
      evidence_count: number;
      note: string | null;
    }>(
      'SELECT version, value, status, source, evidence_count, note FROM model_parameters WHERE user_id = $1 AND name = $2 ORDER BY version',
      [userId, name],
    );
    return r.rows.map((x) => ({
      name,
      version: x.version,
      value: Number(x.value),
      status: x.status,
      source: x.source,
      evidenceCount: x.evidence_count,
      note: x.note,
    }));
  }

  /** Inserts the next version. When it is created active, the previously active version is retired. */
  async insertVersion(
    client: PoolClient | null,
    userId: string,
    args: {
      name: ScaleName;
      value: number;
      status: 'proposed' | 'active';
      source: 'fit' | 'rollback' | 'manual';
      evidenceCount: number;
      uncertaintySd: number | null;
      note: string | null;
    },
  ): Promise<number> {
    const run = async (c: Pick<PoolClient, 'query'>): Promise<number> => {
      await c.query('SELECT pg_advisory_xact_lock(727004)');
      const bounds = args.name === 'm_csf' ? PARAM_BOUNDS.mCsf : PARAM_BOUNDS.mIsf;
      const value = Math.min(bounds.max, Math.max(bounds.min, args.value));
      const next = await c.query<{ v: number }>(
        'SELECT COALESCE(MAX(version), 0) + 1 AS v FROM model_parameters WHERE user_id = $1 AND name = $2',
        [userId, args.name],
      );
      const version = (next.rows[0] as { v: number }).v;
      if (args.status === 'active') {
        await c.query(
          "UPDATE model_parameters SET status = 'retired' WHERE user_id = $1 AND name = $2 AND status = 'active'",
          [userId, args.name],
        );
      }
      await c.query(
        `INSERT INTO model_parameters (user_id, name, version, value, lower_bound, upper_bound, uncertainty_sd,
                                       evidence_count, status, source, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [userId, args.name, version, value, bounds.min, bounds.max, args.uncertaintySd, args.evidenceCount, args.status, args.source, args.note],
      );
      return version;
    };
    return client ? run(client) : this.db.tx(run);
  }

  /** Re-activates an earlier value as a NEW version (history stays intact). Returns the new version. */
  async rollback(userId: string, name: ScaleName, toVersion: number): Promise<number | null> {
    return this.db.tx(async (c) => {
      const t = await c.query<{ value: string; evidence_count: number }>(
        'SELECT value, evidence_count FROM model_parameters WHERE user_id = $1 AND name = $2 AND version = $3',
        [userId, name, toVersion],
      );
      const target = t.rows[0];
      if (!target) return null;
      return this.insertVersion(c, userId, {
        name,
        value: Number(target.value),
        status: 'active',
        source: 'rollback',
        evidenceCount: target.evidence_count,
        uncertaintySd: null,
        note: `rollback to v${toVersion}`,
      });
    });
  }
}
