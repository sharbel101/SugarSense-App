import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import pg from 'pg';

export class DbUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'DbUnavailableError';
  }
}

/** Fixed, value-free summary of a database failure for logs and API notes (pg messages can echo data). */
export function describeDbError(err: unknown): string {
  if (err instanceof DbUnavailableError) return 'database_not_configured';
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? `database_error_${code}` : 'database_error';
}

export type Queryable = Pick<pg.PoolClient, 'query'>;

/**
 * Thin wrapper over a pg Pool using the least-privilege application role (DATABASE_URL).
 * Optional by design: with no DATABASE_URL the service reports `available === false` and every caller
 * degrades to "glucose-only, not saved" instead of failing. Credentials are read from configuration
 * only and never logged; error logging is limited to the SQLSTATE code.
 */
@Injectable()
export class DbService implements OnModuleDestroy {
  private readonly logger = new Logger(DbService.name);
  private readonly pool: pg.Pool | null;

  constructor(@Inject(ConfigService) config: ConfigService) {
    const url = config.get<string>('DATABASE_URL')?.trim();
    if (!url) {
      this.pool = null;
      this.logger.warn('DATABASE_URL is not set: persistence is disabled');
      return;
    }
    this.pool = new pg.Pool({
      connectionString: url,
      max: 8, // the role is limited to 15 connections; leave headroom for tools
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 3_000,
      statement_timeout: 8_000,
      application_name: 'sugarsense-backend',
    });
    this.pool.on('error', (err) => this.logger.warn(`idle client error ${describeDbError(err)}`));
  }

  get available(): boolean {
    return this.pool !== null;
  }

  async query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<pg.QueryResult<R>> {
    if (!this.pool) throw new DbUnavailableError('no pool');
    return this.pool.query<R>(text, params);
  }

  /** Runs fn inside one transaction; rolls back on any error. */
  async tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    if (!this.pool) throw new DbUnavailableError('no pool');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.query('SELECT 1');
      return true;
    } catch (err) {
      this.logger.warn(`ping failed ${describeDbError(err)}`);
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end().catch(() => undefined);
  }
}
