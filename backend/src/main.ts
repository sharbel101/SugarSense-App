import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Dev CORS for browser clients: the Expo web dev server (Metro) runs on http://localhost:8081.
  // Native builds are not subject to CORS. Override with CORS_ORIGINS=origin1,origin2.
  const origins = (process.env.CORS_ORIGINS ?? 'http://localhost:8081')
    .split(',')
    .map((origin) => origin.trim());
  app.enableCors({ origin: origins });
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
