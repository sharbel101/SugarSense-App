import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DbModule } from './db/db.module.js';
import { ForecastingModule } from './forecasting/forecasting.module.js';
import { GlucoseModule } from './glucose/glucose.module.js';
import { HealthController } from './health.controller.js';
import { InsightsModule } from './insights/insights.module.js';
import { MealsModule } from './meals/meals.module.js';

@Module({
  imports: [
    // Loads .env / .env.local into process.env and exposes ConfigService app-wide.
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env.local', '.env'] }),
    DbModule,
    MealsModule,
    GlucoseModule,
    ForecastingModule,
    InsightsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
