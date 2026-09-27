import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // POST /meals/analyze accepts a base64-encoded photo as JSON; Nest's default body-parser limit
  // (~100kb) is too small for that. 15mb comfortably covers a resized 1024px JPEG q80 photo
  // (CLAUDE.md section 9) inflated ~33% by base64, with headroom.
  app.useBodyParser('json', { limit: '15mb' });
  // Dev CORS for browser clients: the Expo web dev server (Metro) runs on http://localhost:8081.
  // Native builds are not subject to CORS. Override with CORS_ORIGINS=origin1,origin2.
  const origins = (process.env.CORS_ORIGINS ?? 'http://localhost:8081')
    .split(',')
    .map((origin) => origin.trim());
  app.enableCors({ origin: origins });
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
