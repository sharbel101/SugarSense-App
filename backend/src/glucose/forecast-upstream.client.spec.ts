import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { ForecastUpstreamClient } from './forecast-upstream.client.js';

const TOKEN = 'secret-token-value';

function client(env: Record<string, string | undefined> = { FORECAST_API_TOKEN: TOKEN }) {
  return new ForecastUpstreamClient({ get: (k: string) => env[k] } as unknown as ConfigService);
}

function stubFetch(impl: (...args: any[]) => Promise<unknown>) {
  const fn = vi.fn(impl);
  vi.stubGlobal('fetch', fn);
  return fn;
}

const json = (status: number, body: unknown) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('ForecastUpstreamClient', () => {
  it('sends the token only in the Authorization header', async () => {
    const fetchFn = stubFetch(async () => json(200, { glucose: 100 }));
    const res = await client().fetchGlucose();
    expect(res).toEqual({ kind: 'ok', body: { glucose: 100 } });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).not.toContain(TOKEN);
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.redirect).toBe('error');
  });

  it('missing token -> not_configured and fetch is never called', async () => {
    const fetchFn = stubFetch(async () => json(200, {}));
    const res = await client({}).fetchGlucose();
    expect(res).toEqual({ kind: 'failed', cause: 'not_configured' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('401 -> unauthorized', async () => {
    stubFetch(async () => json(401, { detail: 'nope' }));
    expect(await client().fetchGlucose()).toEqual({ kind: 'failed', cause: 'unauthorized' });
  });

  it('503 stale detail -> upstream_stale; other 503 -> bad_status', async () => {
    stubFetch(async () => json(503, { detail: 'glucose data is stale' }));
    expect(await client().fetchGlucose()).toEqual({ kind: 'upstream_stale' });
    stubFetch(async () => json(503, { detail: 'model loading' }));
    expect(await client().fetchGlucose()).toEqual({ kind: 'failed', cause: 'bad_status' });
  });

  it('500 -> bad_status', async () => {
    stubFetch(async () => json(500, 'boom'));
    expect(await client().fetchGlucose()).toEqual({ kind: 'failed', cause: 'bad_status' });
  });

  it('non-JSON 200 -> invalid_json', async () => {
    stubFetch(async () => json(200, 'not json'));
    expect(await client().fetchGlucose()).toEqual({ kind: 'failed', cause: 'invalid_json' });
  });

  it('network error (e.g. redirect refused) -> network', async () => {
    stubFetch(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await client().fetchGlucose()).toEqual({ kind: 'failed', cause: 'network' });
  });

  it('aborts after 8 s -> timeout', async () => {
    vi.useFakeTimers();
    stubFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const pending = client().fetchGlucose();
    await vi.advanceTimersByTimeAsync(8001);
    expect(await pending).toEqual({ kind: 'failed', cause: 'timeout' });
  });
});
