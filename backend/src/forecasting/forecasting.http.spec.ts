import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DbService } from '../db/db.service.js';
import { closeAll, hasTestDb, iso, makeRig, nowSec, setTestTherapy, type Rig } from '../../test/forecasting-rig.js';
import { EventsApiService } from './events-api.service.js';
import { EventsController, ForecastController, TherapyController } from './forecasting.controllers.js';
import { ForecastService } from './forecast.service.js';
import { PersonalizationService } from './personalization.service.js';
import { TherapyService } from './therapy.service.js';
import { UsersService } from './users.service.js';

async function appFor(rig: Rig): Promise<INestApplication<Server>> {
  // Nest would call onModuleDestroy on the shared pool when the app closes; the tests close it once at the end.
  const db = Object.create(rig.db, { onModuleDestroy: { value: async () => undefined } }) as DbService;
  const moduleRef = await Test.createTestingModule({
    controllers: [ForecastController, EventsController, TherapyController],
    providers: [
      { provide: ForecastService, useValue: rig.forecast },
      { provide: EventsApiService, useValue: rig.api },
      { provide: TherapyService, useValue: rig.therapy },
      { provide: UsersService, useValue: rig.users },
      { provide: PersonalizationService, useValue: rig.personalization },
      { provide: DbService, useValue: db },
    ],
  }).compile();
  const app = moduleRef.createNestApplication<INestApplication<Server>>();
  await app.init();
  return app;
}

describe.skipIf(!hasTestDb)('forecasting HTTP routes on PostgreSQL', () => {
  let rig: Rig;
  let app: INestApplication<Server>;

  beforeEach(async () => {
    rig = makeRig({ glucose: 130, baseline: () => 130 });
    app = await appFor(rig);
  });
  afterEach(async () => {
    await app.close();
    delete process.env.APP_API_TOKEN;
  });
  afterAll(closeAll);

  it('therapy settings: validates, saves a new version, reads it back, never accepts bad ratios', async () => {
    const http = request(app.getHttpServer());
    await http.get('/therapy/settings').expect(200).expect((r) => {
      expect(r.body.status).toBe('not_set');
      expect(r.body.whenMissing).toMatch(/No default ratio is assumed/);
    });
    await http.put('/therapy/settings').send({ source: 'user_entered', icrSegments: [{ startMinute: 0, gramsPerUnit: 0 }] }).expect(400);
    await http.put('/therapy/settings').send({ source: 'user_entered', icrSegments: [{ startMinute: 0, gramsPerUnit: 11 }], autoAdjust: true }).expect(400);
    const saved = await http
      .put('/therapy/settings')
      .send({ source: 'clinician_prescribed', icrSegments: [{ startMinute: 0, gramsPerUnit: 11 }], isfSegments: [{ startMinute: 0, mgdlPerUnit: 48 }] })
      .expect(200);
    expect(saved.body).toMatchObject({ status: 'set', version: 1, source: 'clinician_prescribed' });
    expect(saved.body.icrSegments).toEqual([{ startMinute: 0, startTime: '00:00', gramsPerUnit: 11 }]);
    await http.put('/therapy/settings').send({ source: 'user_entered', icrSegments: [{ startMinute: 0, gramsPerUnit: 12 }] }).expect(200);
    const hist = await http.get('/therapy/settings/history').expect(200);
    expect(hist.body.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
  });

  it('meal and insulin entry: 201 then 200 on retry, 409 for a probable double entry, forecast refreshed', async () => {
    await setTestTherapy(rig);
    const http = request(app.getHttpServer());
    const meal = { clientId: 'http-meal-0001', eatenAt: iso(nowSec() - 300), carbsG: 40 };
    const a = await http.post('/events/meals').send(meal).expect(201);
    expect(a.body).toMatchObject({ result: 'created', meal: { carbs: { grams: 40, kind: 'user_entered' } } });
    expect(a.body.forecast.status).toBe('ok');
    await http.post('/events/meals').send(meal).expect(200).expect((r) => expect(r.body.result).toBe('exists'));
    await http.post('/events/meals').send({ ...meal, clientId: 'http-meal-0002' }).expect(409).expect((r) => expect(r.body.result).toBe('duplicate'));
    await http.post('/events/meals').send({ ...meal, clientId: 'http-meal-0003', eatenAt: iso(nowSec() + 3600) }).expect(422);
    await http.post('/events/meals').send({ clientId: 'x', eatenAt: 'soon' }).expect(400);

    const dose = await http
      .post('/events/insulin')
      .send({ clientId: 'http-dose-0001', administeredAt: meal.eatenAt, kind: 'bolus', confirmation: 'confirmed', unitsAdministered: 4, source: 'manual', mealId: a.body.meal.id })
      .expect(201);
    expect(dose.body.forecast.mealAware.availability).toMatchObject({ mealsUsed: 1, insulinDosesUsed: 1 });

    const edited = await http.patch(`/events/meals/${a.body.meal.id}`).send({ carbsG: 55 }).expect(200);
    expect(edited.body.meal).toMatchObject({ revision: 2, carbs: { grams: 55 } });
    await http.patch(`/events/meals/${a.body.meal.id}`).send({ carbsG: 55 }).expect(200).expect((r) => expect(r.body.result).toBe('unchanged'));
    await http.patch('/events/meals/not-a-uuid').send({ carbsG: 5 }).expect(400);
    await http.patch(`/events/meals/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`).send({ carbsG: 5 }).expect(404);

    const cov = await http.get(`/events/meals/${a.body.meal.id}/coverage`).expect(200);
    expect(cov.body).toMatchObject({ insulinRecord: 'linked', insulinUnits: 4, expectedCoverageG: 40, carbsMinusCoverageG: 15 }); // 55 g (edited) vs 4 U x ICR 10
    const recent = await http.get('/events/recent?hours=3').expect(200);
    expect(recent.body.meals).toHaveLength(1);
    expect(recent.body.insulin).toHaveLength(1);
  });

  it('label on a meal, cancelling an insulin entry, and on-board values on every point', async () => {
    await setTestTherapy(rig);
    const http = request(app.getHttpServer());
    const m = await http.post('/events/meals').send({ clientId: 'http-label-0001', eatenAt: iso(nowSec() - 300), carbsG: 30, label: 'Pasta' }).expect(201);
    expect(m.body.meal.label).toBe('Pasta');
    await http.post('/events/meals').send({ clientId: 'http-label-0002', eatenAt: iso(nowSec() - 4000), carbsG: 10, label: '' }).expect(400);
    const d = await http.post('/events/insulin').send({ clientId: 'http-cancel-0001', administeredAt: iso(nowSec() - 300), kind: 'bolus', confirmation: 'confirmed', unitsAdministered: 3, source: 'manual', mealId: m.body.meal.id }).expect(201);
    expect(d.body.forecast.points[0]).toEqual(expect.objectContaining({ insulinOnBoardUnits: expect.any(Number), carbsOnBoardGrams: expect.any(Number) }));
    await http.patch(`/events/insulin/${d.body.insulin.id}`).send({ status: 'active' }).expect(400);
    const c = await http.patch(`/events/insulin/${d.body.insulin.id}`).send({ status: 'cancelled' }).expect(200);
    expect(c.body.insulin.status).toBe('cancelled');
    expect(c.body.forecast.mealAware.availability.insulin).toBe('none_recorded');
    await http.patch(`/events/insulin/${d.body.insulin.id}`).send({ unitsAdministered: 2 }).expect(422);
  });

  it('withdrawing entries over HTTP: both routes, repeat = 200 unchanged, refreshed forecast, status in the list', async () => {
    await setTestTherapy(rig);
    const http = request(app.getHttpServer());
    const when = iso(nowSec() - 300);
    const m = await http.post('/events/meals').send({ clientId: 'wd-http-meal-01', eatenAt: when, carbsG: 50 }).expect(201);
    const d = await http.post('/events/insulin').send({ clientId: 'wd-http-dose-01', administeredAt: when, kind: 'bolus', confirmation: 'confirmed', unitsAdministered: 5, source: 'manual', mealId: m.body.meal.id }).expect(201);
    const keepM = await http.post('/events/meals').send({ clientId: 'wd-http-meal-02', eatenAt: iso(nowSec() - 3000), carbsG: 20 }).expect(201);
    const keepD = await http.post('/events/insulin').send({ clientId: 'wd-http-dose-02', administeredAt: iso(nowSec() - 3000), kind: 'correction', confirmation: 'confirmed', unitsAdministered: 1, source: 'manual' }).expect(201);

    // 1. a status that is not "cancelled" is rejected; "cancelled" is accepted on both routes, and an unknown id is a 404 (not a 400)
    await http.patch(`/events/meals/${m.body.meal.id}`).send({ status: 'deleted' }).expect(400);
    await http.patch(`/events/insulin/${d.body.insulin.id}`).send({ status: 'deleted' }).expect(400);
    const nobody = `${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`;
    await http.patch(`/events/meals/${nobody}`).send({ status: 'cancelled' }).expect(404);
    await http.patch(`/events/insulin/${nobody}`).send({ status: 'cancelled' }).expect(404);
    // a stale revision on an ACTIVE entry is still a conflict (and changes nothing)
    await http.patch(`/events/meals/${m.body.meal.id}`).send({ status: 'cancelled', expectedRevision: 9 }).expect(409);
    await http.patch(`/events/insulin/${d.body.insulin.id}`).send({ status: 'cancelled', expectedRevision: 9 }).expect(409);

    // 3. the answer carries the refreshed forecast, without the withdrawn entries
    const cm = await http.patch(`/events/meals/${m.body.meal.id}`).send({ status: 'cancelled', expectedRevision: 1 }).expect(200);
    expect(cm.body).toMatchObject({ result: 'updated', meal: { status: 'cancelled', revision: 2 } });
    expect(cm.body.forecast.status).toBe('ok');
    expect(cm.body.forecast.mealAware.events.map((e: { id: string }) => e.id)).not.toContain(m.body.meal.id);
    const cd = await http.patch(`/events/insulin/${d.body.insulin.id}`).send({ status: 'cancelled', expectedRevision: 1 }).expect(200);
    expect(cd.body).toMatchObject({ result: 'updated', insulin: { status: 'cancelled', revision: 2 } });
    expect(cd.body.forecast.status).toBe('ok');
    expect(cd.body.forecast.mealAware.events.map((e: { id: string }) => e.id)).not.toContain(d.body.insulin.id);

    // 4. withdrawing again - even with the old revision, as an offline retry would - is 200 "unchanged", with a forecast
    for (const [route, id, body] of [['meals', m.body.meal.id, cm.body], ['insulin', d.body.insulin.id, cd.body]] as const) {
      for (const send of [{ status: 'cancelled', expectedRevision: 1 }, { status: 'cancelled', expectedRevision: 2 }, { status: 'cancelled' }]) {
        const again = await http.patch(`/events/${route}/${id}`).send(send).expect(200);
        expect(again.body.result).toBe('unchanged');
        expect((again.body.meal ?? again.body.insulin).status).toBe('cancelled');
        expect((again.body.meal ?? again.body.insulin).revision).toBe(2);
        expect(again.body.forecast.status).toBe('ok');
      }
      expect(body.result).toBe('updated');
    }
    // nothing else may be done to a withdrawn entry (no silent revival)
    await http.patch(`/events/meals/${m.body.meal.id}`).send({ carbsG: 99 }).expect(422);
    await http.patch(`/events/meals/${m.body.meal.id}`).send({ status: 'confirmed' }).expect(422);
    await http.patch(`/events/insulin/${d.body.insulin.id}`).send({ unitsAdministered: 9 }).expect(422);

    // 3. the list shows only live entries and carries "status" on both kinds
    const recent = await http.get('/events/recent?hours=3').expect(200);
    expect(recent.body.meals).toHaveLength(1);
    expect(recent.body.insulin).toHaveLength(1);
    expect(recent.body.meals[0]).toMatchObject({ id: keepM.body.meal.id, status: 'manual_entry' });
    expect(recent.body.insulin[0]).toMatchObject({ id: keepD.body.insulin.id, status: 'active' });
  });

  it('time zone: saved with the settings, validated, returned, and used to read the time-of-day ratios', async () => {
    const http = request(app.getHttpServer());
    await http.put('/therapy/settings').send({ source: 'user_entered', icrSegments: [{ startMinute: 0, gramsPerUnit: 10 }], timezone: 'Mars/Olympus' }).expect(400);
    const saved = await http
      .put('/therapy/settings')
      .send({ source: 'user_entered', icrSegments: [{ startMinute: 0, gramsPerUnit: 12 }, { startMinute: 720, gramsPerUnit: 8 }], isfSegments: [{ startMinute: 0, mgdlPerUnit: 50 }], timezone: 'Asia/Kolkata', effectiveFrom: iso(nowSec() - 3 * 86400) })
      .expect(200);
    expect(saved.body.timezone).toBe('Asia/Kolkata');
    const got = await http.get('/therapy/settings').expect(200);
    expect(got.body.timezone).toBe('Asia/Kolkata');
    // a meal logged at 14:30 India time (09:00 UTC) must be read with the afternoon ratio (8 g/U), not the morning one
    const day = Math.floor(nowSec() / 86400) * 86400 - 86400;
    const m = await http.post('/events/meals').send({ clientId: 'tz-meal-000001', eatenAt: iso(day + 9 * 3600), carbsG: 40 }).expect(201);
    await http.post('/events/insulin').send({ clientId: 'tz-dose-000001', administeredAt: iso(day + 9 * 3600), kind: 'bolus', confirmation: 'confirmed', unitsAdministered: 2, source: 'manual', mealId: m.body.meal.id }).expect(201);
    const cov = await http.get(`/events/meals/${m.body.meal.id}/coverage`).expect(200);
    expect(cov.body.expectedCoverageG).toBe(16); // 2 U x 8 g/U
  });

  it('responses are never cacheable and a cancelled meal has no coverage to show', async () => {
    await setTestTherapy(rig);
    const http = request(app.getHttpServer());
    for (const path of ['/forecast', '/events/recent', '/therapy/settings']) {
      const r = await http.get(path).expect(200);
      expect(r.headers['cache-control']).toContain('no-store');
    }
    const m = await http.post('/events/meals').send({ clientId: 'cc-meal-000001', eatenAt: iso(nowSec() - 600), carbsG: 20 }).expect(201);
    await http.patch(`/events/meals/${m.body.meal.id}`).send({ status: 'cancelled' }).expect(200);
    await http.get(`/events/meals/${m.body.meal.id}/coverage`).expect(404);
  });

  it('GET /forecast and the what-if route', async () => {
    await setTestTherapy(rig);
    const http = request(app.getHttpServer());
    const m = await http.post('/events/meals').send({ clientId: 'http-meal-1001', eatenAt: iso(nowSec() - 300), carbsG: 60 }).expect(201);
    await http.post('/events/insulin').send({ clientId: 'http-dose-1001', administeredAt: iso(nowSec() - 300), kind: 'bolus', confirmation: 'confirmed', unitsAdministered: 6, source: 'manual' }).expect(201);

    const normal = await http.get('/forecast?horizonMin=120').expect(200);
    expect(normal.body.status).toBe('ok');
    expect(normal.body.points).toHaveLength(24);
    const cf = await http.post('/forecast/counterfactual').send({ excludeMealIds: [m.body.meal.id] }).expect(200);
    expect(cf.body.mealAware).toMatchObject({ counterfactual: true, excludedMealIds: [m.body.meal.id] });
    expect(cf.body.saved).toBe(false);
    await http.post('/forecast/counterfactual').send({ excludeMealIds: [] }).expect(400);
    await http.post('/forecast/counterfactual').send({ excludeMealIds: ['nope'] }).expect(400);
    await http.get('/forecast?horizonMin=9999').expect(400);

    const ev = await http.get('/forecast/evaluation').expect(200);
    expect(ev.body.comparison).toEqual([]);
    expect(ev.body.note).toMatch(/Nothing can be said about accuracy/);
  });

  it('the shared app token, when configured, protects every route', async () => {
    process.env.APP_API_TOKEN = 'test-token-123';
    const http = request(app.getHttpServer());
    await http.get('/forecast').expect(401);
    await http.get('/therapy/settings').expect(401);
    await http.post('/events/meals').send({}).expect(401);
    await http.get('/forecast').set('x-app-token', 'test-token-123').expect(200);
  });

  it('database failure answers 503 with a fixed message and leaks nothing', async () => {
    const bad = makeRig({ url: 'postgresql://nobody:secretpw@127.0.0.1:1/none' });
    const badApp = await appFor(bad);
    try {
      const http = request(badApp.getHttpServer());
      for (const res of [
        await http.get('/therapy/settings').expect(503),
        await http.post('/events/meals').send({ clientId: 'bad-db-00001', eatenAt: iso(nowSec() - 60), carbsG: 20 }).expect(503),
        await http.get('/events/recent').expect(503),
      ]) {
        expect(res.body).toEqual({ status: 'unavailable', reason: 'Saving and reading your history is not available right now.' });
        expect(JSON.stringify(res.body)).not.toMatch(/127\.0\.0\.1|ECONN|secretpw|nobody|postgres/i);
      }
      // the forecast itself still answers (glucose-only) rather than failing
      const f = await http.get('/forecast').expect(200);
      expect(f.body.status).toBe('ok');
      expect(f.body.saved).toBe(false);
      expect(JSON.stringify(f.body)).not.toMatch(/127\.0\.0\.1|ECONN|secretpw|nobody/i);
    } finally {
      await badApp.close();
    }
  });
});
