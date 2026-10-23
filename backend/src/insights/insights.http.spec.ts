import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DbService } from '../db/db.service.js';
import { UsersService } from '../forecasting/users.service.js';
import { InsightsController } from './insights.controller.js';
import { InsightsService } from './insights.service.js';

const T0 = new Date('2026-10-21T18:00:00.000Z');

function row(over: Record<string, unknown> = {}) {
  return {
    insight_id: '11111111-1111-4111-8111-111111111111',
    category: 'episode_digest',
    trigger: 'evening',
    priority: '6.120',
    created_at: T0,
    expires_at: new Date(T0.getTime() + 30 * 3600_000),
    observation_start: new Date(T0.getTime() - 21 * 3600_000),
    observation_end: T0,
    validation_status: 'valid',
    content_version: 1,
    evidence: { facts: [{ ref: 'E1', name: 'coverage', value: 100, unit: '%', kind: 'computed' }], coverage: 1, method: 'stays outside the reporting range', quality_flags: [], level: 'repeated', pattern_id: 'p1', detail: { status: 'new', days: [{ date: '2026-10-20', affected: true }], title: 'Glucose is often high between 15:00 and 18:00' } },
    content: {
      headline: 'Time outside your range',
      facts_text: ['Today so far: 3 stay(s) above 180 mg/dL [E2].'],
      explanation: 'Glucose stayed above range three times.',
      limitations: ['Time without readings is unknown, not assumed in range.'],
      evidence_refs: ['E2'],
      validation_status: 'valid',
    },
    ...over,
  };
}

async function appWith(db: { available: boolean; query: ReturnType<typeof vi.fn> }): Promise<INestApplication<Server>> {
  const moduleRef = await Test.createTestingModule({
    controllers: [InsightsController],
    providers: [
      InsightsService,
      { provide: DbService, useValue: db },
      { provide: UsersService, useValue: { primary: async () => ({ userId: 'u-1', timezone: 'Asia/Beirut' }) } },
    ],
  }).compile();
  const app = moduleRef.createNestApplication<INestApplication<Server>>();
  await app.init();
  return app;
}

describe('GET /insights', () => {
  let app: INestApplication<Server>;
  afterEach(async () => {
    await app?.close();
    delete process.env.APP_API_TOKEN;
  });

  it('returns the active insights in the engine order, camelCase, with notice and no-store', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [row(), row({ insight_id: '22222222-2222-4222-8222-222222222222', category: 'episode_time_pattern', priority: '3.5', created_at: new Date(T0.getTime() - 3600_000) })] });
    app = await appWith({ available: true, query });
    const res = await request(app.getHttpServer()).get('/insights').expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.status).toBe('ok');
    expect(res.body.count).toBe(2);
    expect(res.body.generatedAt).toBe(T0.toISOString());
    expect(res.body.notice).toMatch(/not medical advice/);
    const first = res.body.insights[0];
    expect(first).toMatchObject({ id: '11111111-1111-4111-8111-111111111111', category: 'episode_digest', headline: 'Time outside your range', trigger: 'evening', priority: 6.12, validation: 'valid', contentVersion: 1 });
    expect(first.factsText).toEqual(['Today so far: 3 stay(s) above 180 mg/dL [E2].']);
    expect(first.explanation).toBe('Glucose stayed above range three times.');
    expect(first.limitations).toHaveLength(1);
    // a row written before v2 has no paragraph: the validated explanation is shown on the front, and the new back-of-card fields still exist
    expect(first.paragraph).toBe('Glucose stayed above range three times.');
    expect(first).toMatchObject({ source: 'rules', reasoning: 'Glucose stayed above range three times.', safety: null });
    expect(first.evidence).toMatchObject({ coverage: 1, method: 'stays outside the reporting range', qualityFlags: [], level: 'repeated', patternId: 'p1', detail: { status: 'new', days: [{ date: '2026-10-20', affected: true }] } });
    expect(res.body.insights.map((i: { category: string }) => i.category)).toEqual(['episode_digest', 'episode_time_pattern']);
    // asked for the right user and limit, and only for active, unexpired rows
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(['u-1', 5]);
    expect(sql).toMatch(/status = 'active'/);
    expect(sql).toMatch(/expires_at > now\(\)/);
  });

  it('a v2 row returns the paragraph, source, reasoning and safety, with explanation mirroring the reasoning', async () => {
    const content = { headline: 'Early morning high', paragraph: 'A front paragraph.', source: 'ai', reasoning: 'How it was reasoned.', safety: 'It cannot show a cause.', explanation: 'How it was reasoned.', facts_text: ['Fact [E1].'], limitations: ['It cannot show a cause.', 'No sleep record.'], evidence_refs: ['E1'] };
    const query = vi.fn().mockResolvedValueOnce({ rows: [row({ content })] });
    app = await appWith({ available: true, query });
    const it0 = (await request(app.getHttpServer()).get('/insights').expect(200)).body.insights[0];
    expect(it0).toMatchObject({ paragraph: 'A front paragraph.', source: 'ai', reasoning: 'How it was reasoned.', safety: 'It cannot show a cause.', explanation: 'How it was reasoned.' });
    expect(it0.limitations[0]).toBe('It cannot show a cause.');
  });

  it('a fallback insight has no explanation but keeps its facts', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [row({ validation_status: 'fallback', content: { headline: 'Last night', facts_text: ['Last night: no stay outside 70-180 mg/dL.'], explanation: null, limitations: [] } })] });
    app = await appWith({ available: true, query });
    const body = (await request(app.getHttpServer()).get('/insights').expect(200)).body;
    expect(body.insights[0]).toMatchObject({ validation: 'fallback', explanation: null, evidenceRefs: [], paragraph: 'Last night: no stay outside 70-180 mg/dL.' });
    expect(body.insights[0].factsText).toHaveLength(1);
  });

  it('skips a stored row whose content does not match the schema instead of failing', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [row({ content: { nope: true } }), row({ insight_id: '33333333-3333-4333-8333-333333333333' })] });
    app = await appWith({ available: true, query });
    const body = (await request(app.getHttpServer()).get('/insights').expect(200)).body;
    expect(body.count).toBe(1);
    expect(body.insights[0].id).toBe('33333333-3333-4333-8333-333333333333');
  });

  it('empty: not_generated_yet when no run has completed, none_active after one', async () => {
    const q1 = vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ finished_at: null }] });
    app = await appWith({ available: true, query: q1 });
    expect((await request(app.getHttpServer()).get('/insights').expect(200)).body).toMatchObject({ status: 'empty', reason: 'not_generated_yet', lastRunAt: null, insights: [] });
    await app.close();
    const q2 = vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ finished_at: T0 }] });
    app = await appWith({ available: true, query: q2 });
    expect((await request(app.getHttpServer()).get('/insights').expect(200)).body).toMatchObject({ status: 'empty', reason: 'none_active', lastRunAt: T0.toISOString() });
  });

  it('503 unavailable (fixed body) when the database is not configured', async () => {
    app = await appWith({ available: false, query: vi.fn() });
    const res = await request(app.getHttpServer()).get('/insights').expect(503);
    expect(res.body).toMatchObject({ status: 'unavailable' });
  });

  it('503 with a fixed body and no driver text when the query fails (for example the table does not exist yet)', async () => {
    const err = Object.assign(new Error('relation "insights" does not exist at character 123 user=secret'), { code: '42P01' });
    app = await appWith({ available: true, query: vi.fn().mockRejectedValue(err) });
    const res = await request(app.getHttpServer()).get('/insights').expect(503);
    expect(JSON.stringify(res.body)).not.toMatch(/relation|secret|42P01|character/);
    expect(res.body.status).toBe('unavailable');
  });

  it('validates limit and passes it through', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [row()] });
    app = await appWith({ available: true, query });
    const http = request(app.getHttpServer());
    for (const bad of ['0', '11', 'abc', '-1', '2.5']) {
      const r = await http.get(`/insights?limit=${bad}`);
      expect([400, 422]).toContain(r.status);
    }
    expect(query).not.toHaveBeenCalled();
    await http.get('/insights?limit=3').expect(200);
    expect((query.mock.calls[0] as [string, unknown[]])[1]).toEqual(['u-1', 3]);
  });

  it('follows the optional app token like the other routes', async () => {
    process.env.APP_API_TOKEN = 'secret-token';
    app = await appWith({ available: true, query: vi.fn().mockResolvedValue({ rows: [row()] }) });
    const http = request(app.getHttpServer());
    await http.get('/insights').expect(401);
    await http.get('/insights').set('X-App-Token', 'wrong').expect(401);
    await http.get('/insights').set('X-App-Token', 'secret-token').expect(200);
  });

  it('only reads: no write statements are ever issued', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [row()] });
    app = await appWith({ available: true, query });
    await request(app.getHttpServer()).get('/insights').expect(200);
    for (const [sql] of query.mock.calls as [string][]) expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER)\b/i);
  });
});

beforeEach(() => undefined);
