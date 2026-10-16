import { Controller, Get, UseGuards, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppTokenGuard } from './app-token.guard.js';
import { createRateLimitGuard } from './rate-limit.guard.js';

let perIp = 2;
let globalMax = 3;
const TestLimit = createRateLimitGuard({ perIpMax: () => perIp, globalMax: () => globalMax, windowMs: 60_000 });

@Controller('t')
class TestController {
  @Get('token')
  @UseGuards(AppTokenGuard)
  token() {
    return { ok: true };
  }
  @Get('limited')
  @UseGuards(TestLimit)
  limited() {
    return { ok: true };
  }
}

describe('guards', () => {
  let app: INestApplication<Server>;
  beforeEach(async () => {
    perIp = 2;
    globalMax = 3;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-16T00:00:00Z'));
    const m = await Test.createTestingModule({ controllers: [TestController] }).compile();
    app = m.createNestApplication();
    await app.init();
  });
  afterEach(async () => {
    delete process.env.APP_API_TOKEN;
    vi.useRealTimers();
    await app.close();
  });

  it('app token: open when APP_API_TOKEN is unset', async () => {
    await request(app.getHttpServer()).get('/t/token').expect(200);
  });

  it('app token: 401 without or with a wrong token, 200 with the right one', async () => {
    process.env.APP_API_TOKEN = 'secret-123';
    await request(app.getHttpServer()).get('/t/token').expect(401);
    await request(app.getHttpServer()).get('/t/token').set('x-app-token', 'nope').expect(401);
    await request(app.getHttpServer()).get('/t/token').set('x-app-token', 'secret-123').expect(200);
  });

  it('rate limit: per-address cap returns 429 with Retry-After, window resets', async () => {
    const s = () => request(app.getHttpServer()).get('/t/limited');
    await s().expect(200);
    await s().expect(200);
    const res = await s().expect(429);
    expect(res.body).toMatchObject({ status: 'rate_limited' });
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    vi.setSystemTime(new Date('2026-10-16T00:01:01Z'));
    await s().expect(200);
  });

  it('rate limit: global cap applies even when each address is under its own cap', async () => {
    perIp = 100;
    const s = () => request(app.getHttpServer()).get('/t/limited');
    await s().expect(200);
    await s().expect(200);
    await s().expect(200);
    await s().expect(429);
  });
});
