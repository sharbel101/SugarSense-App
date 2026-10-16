import { Module } from '@nestjs/common';
import { PersistenceModule } from '../forecasting/persistence.module.js';
import { ForecastUpstreamClient } from './forecast-upstream.client.js';
import { GlucoseController } from './glucose.controller.js';
import { GLUCOSE_NOW_FN, GlucoseService, realNow } from './glucose.service.js';

@Module({
  imports: [PersistenceModule],
  exports: [GlucoseService],
  controllers: [GlucoseController],
  providers: [GlucoseService, ForecastUpstreamClient, { provide: GLUCOSE_NOW_FN, useValue: realNow }],
})
export class GlucoseModule {}
