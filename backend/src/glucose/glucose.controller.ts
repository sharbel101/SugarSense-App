import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { AppTokenGuard } from '../common/app-token.guard.js';
import { createRateLimitGuard, envInt } from '../common/rate-limit.guard.js';
import type { GlucoseResponse } from './glucose-response.js';
import { GlucoseService } from './glucose.service.js';

/**
 * Data read only: no notifications, no insulin arithmetic. Always HTTP 200 for ok/stale/unavailable.
 * Gated by the optional shared app token and a rate limit (default 120 per address, 240 in total per
 * minute). Neither is user authentication - add real auth before any other person's data is served.
 */
const GlucoseRateLimitGuard = createRateLimitGuard({
  perIpMax: envInt('RATE_LIMIT_GLUCOSE_PER_IP', 120),
  globalMax: envInt('RATE_LIMIT_GLUCOSE_GLOBAL', 240),
  windowMs: 60_000,
});

@Controller('glucose')
@UseGuards(AppTokenGuard, GlucoseRateLimitGuard)
export class GlucoseController {
  constructor(private readonly glucose: GlucoseService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  get(): Promise<GlucoseResponse> {
    return this.glucose.getGlucose();
  }
}
