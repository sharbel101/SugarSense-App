import { Controller, Get, HttpException, Inject, Query, ServiceUnavailableException, UseGuards, UseInterceptors } from '@nestjs/common';
import { AppTokenGuard } from '../common/app-token.guard.js';
import { NoStoreInterceptor } from '../common/no-store.interceptor.js';
import { createRateLimitGuard, envInt } from '../common/rate-limit.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { DbService, describeDbError } from '../db/db.service.js';
import { insightsQuerySchema, type InsightsQuery } from './insights.schema.js';
import { InsightsService } from './insights.service.js';

const InsightsRateLimit = createRateLimitGuard({
  perIpMax: envInt('RATE_LIMIT_INSIGHTS_PER_IP', 60),
  globalMax: envInt('RATE_LIMIT_INSIGHTS_GLOBAL', 180),
  windowMs: 60_000,
});

const UNAVAILABLE_BODY = { status: 'unavailable', reason: 'Insights are not available right now.' } as const;

/**
 * GET /insights : the current insights (morning briefing, evening recap, event-triggered), already ranked by the engine.
 * Always HTTP 200 with a `status` of 'ok' or 'empty'; 503 {status:'unavailable'} if storage cannot be read. No-store: it is health data.
 * Authentication follows the other routes (optional X-App-Token via APP_API_TOKEN, rate limited).
 */
@Controller('insights')
@UseGuards(AppTokenGuard, InsightsRateLimit)
@UseInterceptors(NoStoreInterceptor)
export class InsightsController {
  constructor(
    @Inject(InsightsService) private readonly insights: InsightsService,
    @Inject(DbService) private readonly db: DbService,
  ) {}

  @Get()
  async list(@Query(new ZodValidationPipe(insightsQuerySchema)) q: InsightsQuery) {
    if (!this.db.available) throw new ServiceUnavailableException(UNAVAILABLE_BODY);
    try {
      return await this.insights.list(q.limit);
    } catch (err) {
      if (err instanceof HttpException) throw err;
      void describeDbError(err); // fixed SQLSTATE-only summary; never the driver text
      throw new ServiceUnavailableException(UNAVAILABLE_BODY);
    }
  }
}
