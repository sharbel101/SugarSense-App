import { Module } from '@nestjs/common';
import { GlucoseModule } from '../glucose/glucose.module.js';
import { EventsApiService } from './events-api.service.js';
import { EventsController, ForecastController, TherapyController } from './forecasting.controllers.js';
import { ForecastService } from './forecast.service.js';
import { MealForecastFlow } from './meal-forecast-flow.js';
import { PersistenceModule } from './persistence.module.js';

@Module({
  imports: [PersistenceModule, GlucoseModule],
  controllers: [ForecastController, EventsController, TherapyController],
  providers: [ForecastService, EventsApiService, MealForecastFlow],
  exports: [ForecastService, EventsApiService, MealForecastFlow],
})
export class ForecastingModule {}
