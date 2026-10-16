import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DbService } from '../src/db/db.service.js';
import { BaselineErrorService } from '../src/forecasting/baseline-error.service.js';
import { EventsApiService } from '../src/forecasting/events-api.service.js';
import { EventsService } from '../src/forecasting/events.service.js';
import { ForecastService } from '../src/forecasting/forecast.service.js';
import { GlucoseIngestService } from '../src/forecasting/glucose-ingest.service.js';
import { MealForecastFlow } from '../src/forecasting/meal-forecast-flow.js';
import { OutcomeService } from '../src/forecasting/outcome.service.js';
import { ParametersService } from '../src/forecasting/parameters.service.js';
import { PersonalizationService } from '../src/forecasting/personalization.service.js';
import { PredictionStore } from '../src/forecasting/prediction-store.service.js';
import { TherapyService } from '../src/forecasting/therapy.service.js';
import { UsersService } from '../src/forecasting/users.service.js';
import type { GlucoseService } from '../src/glucose/glucose.service.js';
import type { GlucoseOkResponse, GlucoseResponse } from '../src/glucose/glucose-response.js';

/** Both URLs point at the scratch database; unset means "skip the database tests". */
export const TEST_DB_URL = process.env.TEST_DATABASE_URL;
export const TEST_DB_MIGRATE_URL = process.env.TEST_DATABASE_MIGRATE_URL;
export const hasTestDb = Boolean(TEST_DB_URL);

export const nowSec = (): number => Math.floor(Date.now() / 1000);
export const iso = (sec: number): string => new Date(sec * 1000).toISOString();

export function configWith(values: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

/** A glucose-service double whose answer the test controls. */
export class FakeGlucose {
  response: GlucoseResponse;
  calls = 0;
  constructor(response: GlucoseResponse) {
    this.response = response;
  }
  async getGlucose(): Promise<GlucoseResponse> {
    this.calls += 1;
    return this.response;
  }
}

/** A well-formed "ok" glucose answer: 24 baseline points at +5..+120 min from the anchor. */
export function okGlucose(
  anchorSec: number,
  glucose: number,
  baselineAt: (minutes: number) => number,
  extra: Partial<GlucoseOkResponse> = {},
): GlucoseOkResponse {
  return {
    status: 'ok',
    glucoseMgdl: glucose,
    measuredAt: iso(anchorSec),
    ageMinutes: 2,
    history: Array.from({ length: 12 }, (_, i) => ({ time: iso(anchorSec - (11 - i) * 300), value: glucose })),
    predictions: Array.from({ length: 24 }, (_, k) => ({ time: iso(anchorSec + (k + 1) * 300), value: baselineAt((k + 1) * 5) })),
    forecastAvailable: true,
    forecastUnavailableReason: null,
    trendMgdlPerMin: null,
    low: emptyRisk(),
    high: emptyRisk(),
    ranges: null,
    rangesAreShadow: false,
    modelVersion: 'direct_120',
    generatedAt: iso(anchorSec),
    servedAt: iso(anchorSec),
    ...extra,
  } as GlucoseOkResponse;
}

function emptyRisk() {
  return {
    alert: null,
    alreadyLow: null,
    alreadyHigh: null,
    headline: null,
    alertSince: null,
    predicted15: null,
    predicted30: null,
    predicted45: null,
    probability15: null,
    probability30: null,
    probability45: null,
  };
}

let sharedDb: DbService | null = null;
const extraDbs: DbService[] = [];
/** Closes every pool a test run opened (the application role is limited to 15 connections). */
export async function closeAll(): Promise<void> {
  await sharedDb?.onModuleDestroy();
  sharedDb = null;
  for (const d of extraDbs.splice(0)) await d.onModuleDestroy();
}

export interface Rig {
  db: DbService;
  userId: string;
  fake: FakeGlucose;
  users: UsersService;
  therapy: TherapyService;
  events: EventsService;
  parameters: ParametersService;
  store: PredictionStore;
  outcomes: OutcomeService;
  personalization: PersonalizationService;
  ingest: GlucoseIngestService;
  forecast: ForecastService;
  api: EventsApiService;
  flow: MealForecastFlow;
  baselineError: BaselineErrorService;
}

/**
 * Real services over the real (scratch) database, application role, with a pinned fresh user so every
 * test is isolated from every other. Only the glucose proxy is faked (it needs the VM's forecast service).
 */
export function makeRig(opts: { url?: string; anchorSec?: number; glucose?: number; baseline?: (m: number) => number } = {}): Rig {
  const userId = randomUUID();
  const config = configWith({ DATABASE_URL: opts.url ?? TEST_DB_URL, PRIMARY_USER_ID: userId });
  let db: DbService;
  if (opts.url === undefined) {
    sharedDb ??= new DbService(configWith({ DATABASE_URL: TEST_DB_URL }));
    db = sharedDb;
  } else {
    db = new DbService(config);
    extraDbs.push(db);
  }
  const users = new UsersService(db, config);
  const therapy = new TherapyService(db);
  const events = new EventsService(db);
  const parameters = new ParametersService(db);
  const baselineError = new BaselineErrorService(db);
  const store = new PredictionStore(db);
  const outcomes = new OutcomeService(db);
  const personalization = new PersonalizationService(db, outcomes, parameters);
  const ingest = new GlucoseIngestService(db, users, personalization);
  const anchor = opts.anchorSec ?? nowSec() - 120;
  const fake = new FakeGlucose(okGlucose(anchor, opts.glucose ?? 120, opts.baseline ?? (() => opts.glucose ?? 120)));
  const forecast = new ForecastService(fake as unknown as GlucoseService, db, users, therapy, events, parameters, baselineError, store);
  const api = new EventsApiService(events, forecast, users, db);
  const flow = new MealForecastFlow(db, users, events, forecast);
  return { db, userId, fake, users, therapy, events, parameters, store, outcomes, personalization, ingest, forecast, api, flow, baselineError };
}

/** ICR/ISF used by the tests: the spec's worked example (ICR 10 g/U, ISF 50 mg/dL/U). Test values only. */
export async function setTestTherapy(rig: Rig, icr = 10, isf = 50): Promise<void> {
  await rig.users.primary();
  await rig.therapy.setSettings(rig.userId, {
    icrSegments: [{ startMinute: 0, gramsPerUnit: icr }],
    isfSegments: [{ startMinute: 0, mgdlPerUnit: isf }],
    source: 'user_entered',
    effectiveFrom: iso(nowSec() - 3 * 24 * 3600),
  });
}
