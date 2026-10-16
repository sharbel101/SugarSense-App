import { Module } from '@nestjs/common';
import { ForecastingModule } from '../forecasting/forecasting.module.js';
import { MealsController } from './meals.controller.js';
import { MealsService, MEAL_ANALYSIS_SLEEP_FN, realSleep } from './meals.service.js';
import { GeminiMealVisionProvider } from './providers/gemini-meal-vision.provider.js';
import { MEAL_VISION_PROVIDER } from './providers/meal-vision.provider.js';

@Module({
  imports: [ForecastingModule],
  controllers: [MealsController],
  providers: [
    MealsService,
    { provide: MEAL_VISION_PROVIDER, useClass: GeminiMealVisionProvider },
    { provide: MEAL_ANALYSIS_SLEEP_FN, useValue: realSleep },
  ],
})
export class MealsModule {}
