import { Controller, Get } from '@nestjs/common';

// Liveness probe only - lets clients (and deploy tooling) confirm the server is up.
@Controller('health')
export class HealthController {
  @Get()
  check() {
    return { status: 'ok' };
  }
}
