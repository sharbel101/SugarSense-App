import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { ForecastUpstreamClient, type ForecastFetchResult } from '../src/glucose/forecast-upstream.client.js';
import { GLUCOSE_NOW_FN } from '../src/glucose/glucose.service.js';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/glucose/upstream-ok.json', import.meta.url), 'utf8'),
) as { timestamp: string };
const MEASURED = Date.parse(fixture.timestamp);

let app: INestApplication<Server>;

async function boot(result: ForecastFetchResult) {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ForecastUpstreamClient)
    .useValue({ fetchGlucose: async () => result })
    .overrideProvider(GLUCOSE_NOW_FN)
    .useValue(() => MEASURED + 2 * 60_000)
    .compile();
  app = moduleRef.createNestApplication();
  await app.init();
}

afterEach(async () => {
  await app?.close();
});

describe('GET /glucose (e2e)', () => {
  it('ok -> 200, no-store, no auth header needed', async () => {
    await boot({ kind: 'ok', body: fixture });
    const res = await request(app.getHttpServer()).get('/glucose').expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.status).toBe('ok');
    expect(res.body.glucoseMgdl).toBe(230);
    expect(res.body.ageMinutes).toBe(2);
  });

  it('stale -> 200 with no glucose', async () => {
    await boot({ kind: 'upstream_stale' });
    const res = await request(app.getHttpServer()).get('/glucose').expect(200);
    expect(res.body.status).toBe('stale');
    expect(res.body.glucoseMgdl).toBeUndefined();
  });

  it('unavailable -> 200 with no glucose', async () => {
    await boot({ kind: 'failed', cause: 'network' });
    const res = await request(app.getHttpServer()).get('/glucose').expect(200);
    expect(res.body.status).toBe('unavailable');
    expect(res.body.glucoseMgdl).toBeUndefined();
  });
});
