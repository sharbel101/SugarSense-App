import { Controller, Get, Header } from '@nestjs/common';
import type { GlucoseResponse } from './glucose-response.js';
import { GlucoseService } from './glucose.service.js';

/**
 * Data read only: no notifications, no insulin arithmetic. Always HTTP 200 for ok/stale/unavailable.
 * NOTE: no authentication yet (same as POST /meals/analyze) - add before any real user.
 */
@Controller('glucose')
export class GlucoseController {
  constructor(private readonly glucose: GlucoseService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  get(): Promise<GlucoseResponse> {
    return this.glucose.getGlucose();
  }
}
