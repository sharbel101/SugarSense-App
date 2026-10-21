import { Inject, Injectable, Logger } from '@nestjs/common';
import { DbService, describeDbError } from '../db/db.service.js';
import { UsersService } from '../forecasting/users.service.js';
import {
  INSIGHT_NOTICE,
  storedContentSchema,
  storedEvidenceSchema,
  type InsightItem,
  type InsightTrigger,
  type InsightsResponse,
} from './insights.schema.js';

interface InsightRow {
  insight_id: string;
  category: string;
  trigger: InsightTrigger;
  priority: string; // numeric -> string from pg
  created_at: Date;
  expires_at: Date | null;
  observation_start: Date;
  observation_end: Date;
  validation_status: 'valid' | 'fallback' | 'not_applicable';
  content_version: number;
  evidence: unknown;
  content: unknown;
}

/**
 * Read-only view of the insights the Python engine (backend/insights) stored. The API never generates, edits or ranks insights: it returns
 * the active, unexpired ones in the engine's own order. If the table does not exist yet (migration 0010 not applied) or the database is
 * down, callers get 'unavailable'; no database text is ever returned.
 */
@Injectable()
export class InsightsService {
  private readonly logger = new Logger(InsightsService.name);

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(UsersService) private readonly users: UsersService,
  ) {}

  async list(limit: number): Promise<InsightsResponse> {
    const { userId } = await this.users.primary();
    const rows = await this.db.query<InsightRow>(
      `SELECT insight_id::text, category, trigger, priority::text, created_at, expires_at, observation_start, observation_end,
              validation_status, content_version, evidence, content
         FROM insights
        WHERE user_id = $1 AND status = 'active' AND (expires_at IS NULL OR expires_at > now())
        ORDER BY priority DESC, created_at DESC
        LIMIT $2`,
      [userId, limit],
    );
    const insights: InsightItem[] = [];
    let skipped = 0;
    for (const r of rows.rows) {
      const item = toItem(r);
      if (item) insights.push(item);
      else skipped += 1;
    }
    if (skipped > 0) this.logger.warn(`skipped ${skipped} stored insight(s) that did not match the content schema`);
    if (insights.length > 0) {
      const newest = insights.reduce((a, b) => (a.createdAt > b.createdAt ? a : b)).createdAt;
      return { status: 'ok', generatedAt: newest, count: insights.length, insights, notice: INSIGHT_NOTICE };
    }
    const last = await this.db.query<{ finished_at: Date | null }>(
      `SELECT max(finished_at) AS finished_at FROM insight_runs WHERE user_id = $1 AND status = 'complete'`,
      [userId],
    );
    const lastRunAt = last.rows[0]?.finished_at ?? null;
    return {
      status: 'empty',
      reason: lastRunAt ? 'none_active' : 'not_generated_yet',
      lastRunAt: lastRunAt ? lastRunAt.toISOString() : null,
      insights: [],
      notice: INSIGHT_NOTICE,
    };
  }

  describe(err: unknown): string {
    return describeDbError(err);
  }
}

function toItem(r: InsightRow): InsightItem | null {
  const content = storedContentSchema.safeParse(r.content);
  if (!content.success) return null;
  const evidence = storedEvidenceSchema.safeParse(r.evidence);
  const ev = evidence.success ? evidence.data : { facts: [], quality_flags: [] as string[] };
  const c = content.data;
  const explanation = c.explanation && c.explanation.trim().length > 0 ? c.explanation : null;
  // Rows written before the one-paragraph format have no paragraph: show the validated explanation, else the facts joined.
  const paragraph = c.paragraph && c.paragraph.trim().length > 0 ? c.paragraph : (explanation ?? c.facts_text.join(' '));
  return {
    id: r.insight_id,
    category: r.category,
    headline: c.headline,
    trigger: r.trigger,
    priority: Number(r.priority),
    createdAt: r.created_at.toISOString(),
    expiresAt: r.expires_at ? r.expires_at.toISOString() : null,
    observationStart: r.observation_start.toISOString(),
    observationEnd: r.observation_end.toISOString(),
    factsText: c.facts_text,
    paragraph,
    source: c.source ?? (c.paragraph ? 'ai' : 'rules'),
    reasoning: c.reasoning && c.reasoning.trim().length > 0 ? c.reasoning : explanation,
    safety: c.safety && c.safety.trim().length > 0 ? c.safety : null,
    explanation,
    limitations: c.limitations,
    validation: r.validation_status,
    evidenceRefs: c.evidence_refs,
    evidence: {
      coverage: 'coverage' in ev && typeof ev.coverage === 'number' ? ev.coverage : null,
      method: 'method' in ev && typeof ev.method === 'string' ? ev.method : null,
      level: 'level' in ev && ev.level ? ev.level : null,
      patternId: 'pattern_id' in ev && ev.pattern_id ? ev.pattern_id : null,
      levelCriteria: 'level_criteria' in ev && ev.level_criteria ? ev.level_criteria : null,
      qualityFlags: ev.quality_flags,
      facts: ev.facts,
    },
    contentVersion: r.content_version,
  };
}
