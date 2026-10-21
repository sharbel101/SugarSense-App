import { Module } from '@nestjs/common';
import { PersistenceModule } from '../forecasting/persistence.module.js';
import { InsightsController } from './insights.controller.js';
import { InsightsService } from './insights.service.js';

@Module({ imports: [PersistenceModule], controllers: [InsightsController], providers: [InsightsService] })
export class InsightsModule {}
