import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const DEFAULT_FORECAST_API_URL = 'http://127.0.0.1:8001';

/** One attempt, no retry: the app polls roughly every 60 s, so the next poll is the retry. */
export const FORECAST_REQUEST_TIMEOUT_MS = 8000;

export type ForecastFailureCause =
  | 'not_configured'
  | 'unauthorized'
  | 'bad_status'
  | 'timeout'
  | 'network'
  | 'invalid_json';

export type ForecastFetchResult =
  | { kind: 'ok'; body: unknown }
  /** Upstream answered 503 "glucose data is stale" (newest reading older than its own limit). */
  | { kind: 'upstream_stale' }
  | { kind: 'failed'; cause: ForecastFailureCause };

/**
 * Server-side client for the forecast service's `GET /glucose`. It is the only place that knows the
 * upstream URL or holds the bearer token (`FORECAST_API_TOKEN`, read via `ConfigService` only).
 *
 * SECURITY / PRIVACY:
 * - The token is only ever placed in the `Authorization` header. It is never logged, interpolated into
 *   a message, or returned.
 * - Logging is limited to the HTTP status code, latency, and a fixed `cause` word. No URL, no request
 *   or response body, no `err.message` (undici's network errors embed the target address) - the body is
 *   health data (HANDOFF-BACKEND-AI.md section 8).
 * - `redirect: 'error'` fails closed rather than following a redirect with the credential attached.
 */
@Injectable()
export class ForecastUpstreamClient {
  private readonly logger = new Logger(ForecastUpstreamClient.name);

  constructor(private readonly config: ConfigService) {}

  async fetchGlucose(): Promise<ForecastFetchResult> {
    const token = this.config.get<string>('FORECAST_API_TOKEN')?.trim();
    if (!token) {
      this.logger.warn('GET /glucose upstream not called: FORECAST_API_TOKEN is not configured');
      return { kind: 'failed', cause: 'not_configured' };
    }
    const baseUrl = (this.config.get<string>('FORECAST_API_URL') || DEFAULT_FORECAST_API_URL).replace(
      /\/+$/,
      '',
    );

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, FORECAST_REQUEST_TIMEOUT_MS);
    const startedAt = Date.now();

    try {
      const response = await fetch(`${baseUrl}/glucose`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: controller.signal,
        redirect: 'error',
      });
      const status = response.status;

      if (status === 200) {
        const text = await response.text();
        this.logOutcome(status, startedAt);
        try {
          return { kind: 'ok', body: JSON.parse(text) as unknown };
        } catch {
          return { kind: 'failed', cause: 'invalid_json' };
        }
      }

      if (status === 503) {
        const text = await response.text();
        this.logOutcome(status, startedAt);
        return isStaleDetail(text) ? { kind: 'upstream_stale' } : { kind: 'failed', cause: 'bad_status' };
      }

      // Anything else (401, 422, 500, ...): the body is never read, let alone forwarded.
      void response.body?.cancel().catch(() => undefined);
      this.logOutcome(status, startedAt);
      return { kind: 'failed', cause: status === 401 ? 'unauthorized' : 'bad_status' };
    } catch {
      const cause: ForecastFailureCause = timedOut ? 'timeout' : 'network';
      this.logger.warn(`GET /glucose upstream failed cause=${cause} latencyMs=${Date.now() - startedAt}`);
      return { kind: 'failed', cause };
    } finally {
      clearTimeout(timer);
    }
  }

  private logOutcome(status: number, startedAt: number): void {
    const line = `GET /glucose upstream status=${status} latencyMs=${Date.now() - startedAt}`;
    if (status === 200) this.logger.log(line);
    else this.logger.warn(line);
  }
}

/** The forecast service's stale 503 is `{"detail":"glucose data is stale"}`. Matched loosely on purpose. */
function isStaleDetail(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return false;
    const detail = (parsed as { detail?: unknown }).detail;
    return typeof detail === 'string' && /stale/i.test(detail);
  } catch {
    return false;
  }
}
