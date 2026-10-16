import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DbService } from '../db/db.service.js';
import { isValidTimeZone } from './time.js';

export interface UserContext {
  userId: string;
  timezone: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * There is no authentication yet: this prototype serves one person. `PRIMARY_USER_ID` (optional) pins
 * that person's row; otherwise the oldest user row is used, or one is created. When real auth arrives,
 * this is the single place that changes - every other service takes a userId argument.
 */
@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);
  private cached: UserContext | null = null;

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  async primary(): Promise<UserContext> {
    if (this.cached) return this.cached;
    const pinned = this.config.get<string>('PRIMARY_USER_ID')?.trim();
    const ctx = await this.db.tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(727002)');
      if (pinned && UUID_RE.test(pinned)) {
        await c.query('INSERT INTO users (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [pinned]);
        const r = await c.query<{ user_id: string; timezone: string }>(
          'SELECT user_id, timezone FROM users WHERE user_id = $1',
          [pinned],
        );
        return r.rows[0] as { user_id: string; timezone: string };
      }
      const existing = await c.query<{ user_id: string; timezone: string }>(
        'SELECT user_id, timezone FROM users ORDER BY created_at, user_id LIMIT 1',
      );
      if (existing.rows[0]) return existing.rows[0];
      const created = await c.query<{ user_id: string; timezone: string }>(
        'INSERT INTO users DEFAULT VALUES RETURNING user_id, timezone',
      );
      return created.rows[0] as { user_id: string; timezone: string };
    });
    const timezone = isValidTimeZone(ctx.timezone) ? ctx.timezone : 'UTC';
    this.cached = { userId: ctx.user_id, timezone };
    return this.cached;
  }

  /** Test helper / future settings screen: change the IANA zone (validated). */
  async setTimezone(userId: string, timezone: string): Promise<void> {
    if (!isValidTimeZone(timezone)) throw new RangeError('invalid time zone');
    await this.db.query('UPDATE users SET timezone = $2 WHERE user_id = $1', [userId, timezone]);
    if (this.cached?.userId === userId) this.cached = { userId, timezone };
  }
}
