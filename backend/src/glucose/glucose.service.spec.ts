import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { ForecastFetchResult, ForecastUpstreamClient } from './forecast-upstream.client.js';
import type { GlucoseOkResponse } from './glucose-response.js';
import {
  GlucoseService,
  REASON_BY_CAUSE,
  STALE_REASON,
  UNEXPECTED_REASON,
  UNVERIFIED_REASON,
} from './glucose.service.js';

const fixture = JSON.parse(
  readFileSync(new URL('../../test/fixtures/glucose/upstream-ok.json', import.meta.url), 'utf8'),
) as Record<string, any>;

const MEASURED = Date.parse(fixture.timestamp as string);

function build(result: ForecastFetchResult, nowMs: number, env: Record<string, string> = {}) {
  const client = { fetchGlucose: vi.fn().mockResolvedValue(result) } as unknown as ForecastUpstreamClient;
  const config = { get: (k: string) => env[k] } as unknown as ConfigService;
  return new GlucoseService(client, config, () => nowMs);
}

const body = (patch: Record<string, unknown> = {}): ForecastFetchResult => ({
  kind: 'ok',
  body: { ...structuredClone(fixture), ...patch },
});

describe('GlucoseService', () => {
  it('maps an ok body and rounds ageMinutes up (4 min 10 s -> 5)', async () => {
    const res = await build(body(), MEASURED + 4 * 60_000 + 10_000).getGlucose();
    expect(res.status).toBe('ok');
    const ok = res as GlucoseOkResponse;
    expect(ok.glucoseMgdl).toBe(230);
    expect(ok.ageMinutes).toBe(5);
    expect(ok.forecastAvailable).toBe(true);
    expect(ok.modelVersion).toBe('direct_120');
  });

  it('upstream 503 stale -> stale with no lastMeasuredAt and no glucose key', async () => {
    const res = await build({ kind: 'upstream_stale' }, MEASURED).getGlucose();
    expect(res).toEqual({ status: 'stale', reason: STALE_REASON, lastMeasuredAt: null });
    expect('glucoseMgdl' in res).toBe(false);
  });

  it('cached upstream 200 older than 20 min on our clock -> stale with lastMeasuredAt', async () => {
    const res = await build(body(), MEASURED + 21 * 60_000).getGlucose();
    expect(res).toEqual({ status: 'stale', reason: STALE_REASON, lastMeasuredAt: fixture.timestamp });
  });

  it('exactly 20 minutes is still ok', async () => {
    const res = await build(body(), MEASURED + 20 * 60_000).getGlucose();
    expect(res.status).toBe('ok');
  });

  it.each(Object.entries(REASON_BY_CAUSE))('failed cause %s -> unavailable with mapped reason', async (cause, reason) => {
    const res = await build(
      { kind: 'failed', cause: cause as keyof typeof REASON_BY_CAUSE },
      MEASURED,
    ).getGlucose();
    expect(res).toEqual({ status: 'unavailable', reason });
    expect('glucoseMgdl' in res).toBe(false);
  });

  it.each([
    ['missing history', { history: undefined }],
    ['mmol/L unit', { unit: 'mmol/L' }],
    ['non-ISO timestamp', { timestamp: 'yesterday' }],
    ['probability 1.5', { hypoglycemia: { '15m_probability': 1.5 } }],
  ])('schema drift (%s) -> unavailable', async (_name, patch) => {
    const res = await build(body(patch), MEASURED).getGlucose();
    expect(res).toEqual({ status: 'unavailable', reason: UNEXPECTED_REASON });
  });

  it.each([15, 700])('implausible glucose %i -> unavailable', async (glucose) => {
    const res = await build(body({ glucose }), MEASURED).getGlucose();
    expect(res).toEqual({ status: 'unavailable', reason: UNVERIFIED_REASON });
  });

  it('timestamp 10 min in the future -> unavailable', async () => {
    const res = await build(body(), MEASURED - 10 * 60_000).getGlucose();
    expect(res).toEqual({ status: 'unavailable', reason: UNVERIFIED_REASON });
  });

  it('forecast_available false -> no predictions, reason passed, glucose and risk kept', async () => {
    const b = body({
      forecast_available: false,
      predictions: [],
      meta: { ...fixture.meta, forecast_unavailable_reason: 'not enough history' },
    });
    const ok = (await build(b, MEASURED + 60_000).getGlucose()) as GlucoseOkResponse;
    expect(ok.status).toBe('ok');
    expect(ok.predictions).toEqual([]);
    expect(ok.forecastAvailable).toBe(false);
    expect(ok.forecastUnavailableReason).toBe('not enough history');
    expect(ok.glucoseMgdl).toBe(230);
    expect(ok.low.alert).toBe(false);
  });

  it('forecast_available true but predictions empty -> reported unavailable', async () => {
    const ok = (await build(body({ predictions: [] }), MEASURED + 60_000).getGlucose()) as GlucoseOkResponse;
    expect(ok.forecastAvailable).toBe(false);
    expect(ok.forecastUnavailableReason).toBeTruthy();
  });

  it('absent hypo/hyper -> all null, alert is null not false', async () => {
    const ok = (await build(
      body({ hypoglycemia: null, hyperglycemia: undefined }),
      MEASURED + 60_000,
    ).getGlucose()) as GlucoseOkResponse;
    expect(ok.low.alert).toBeNull();
    expect(ok.high.alert).toBeNull();
    expect(Object.values(ok.low).every((v) => v === null)).toBe(true);
    expect(Object.values(ok.high).every((v) => v === null)).toBe(true);
    expect(ok.ranges).toBeNull();
  });

  it('shadow excursion -> rangesAreShadow; inverted/missing ranges dropped', async () => {
    const hyper = structuredClone(fixture.hyperglycemia);
    hyper.excursion.horizon_ranges['30'] = { forecast: 230, low: 260, high: 200 };
    hyper.excursion.horizon_ranges['45'] = { forecast: 228, low: null, high: 265 };
    const ok = (await build(body({ hyperglycemia: hyper }), MEASURED + 60_000).getGlucose()) as GlucoseOkResponse;
    expect(ok.rangesAreShadow).toBe(true);
    expect(ok.ranges).toEqual([{ minutes: 15, low: 207, high: 253, forecast: 237 }]);
  });

  it('does not leak experimental or internal upstream fields', async () => {
    const res = await build(body(), MEASURED + 60_000).getGlucose();
    const json = JSON.stringify(res);
    for (const key of ['hazard_low_risk', 'normalization', 'inference_ms', 'estimated_range']) {
      expect(json).not.toContain(key);
    }
    // The upstream minutes-relative `forecast[]` array must not appear at the top level
    // (`ranges[].forecast` is a legitimate per-horizon number).
    expect(Object.keys(res)).not.toContain('forecast');
  });

  it('passes history/predictions timestamps through unchanged and never emits another unit', async () => {
    const ok = (await build(body(), MEASURED + 60_000).getGlucose()) as GlucoseOkResponse;
    expect(ok.history.map((p) => p.time)).toEqual(fixture.history.map((p: { time: string }) => p.time));
    expect(ok.predictions.map((p) => p.time)).toEqual(fixture.predictions.map((p: { time: string }) => p.time));
    expect(JSON.stringify(ok)).not.toMatch(/mmol|unit/i);
  });

  it('honours GLUCOSE_STALE_MINUTES', async () => {
    const res = await build(body(), MEASURED + 6 * 60_000, { GLUCOSE_STALE_MINUTES: '5' }).getGlucose();
    expect(res.status).toBe('stale');
  });
});
