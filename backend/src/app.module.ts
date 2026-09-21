import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthController } from './health.controller.js';

@Module({
  imports: [
    // Loads .env / .env.local into process.env and exposes ConfigService app-wide.
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env.local', '.env'] }),
  ],
  controllers: [HealthController],
})
export class AppModule {}
