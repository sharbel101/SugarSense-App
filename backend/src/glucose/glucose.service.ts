import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ForecastUpstreamClient, type ForecastFailureCause } from './forecast-upstream.client.js';
import type {
  GlucoseResponse,
  GlucoseStaleResponse,
  GlucoseUnavailableResponse,
} from './glucose-response.js';
import { mapUpstreamGlucose } from './map-upstream-glucose.js';
import { upstreamGlucoseSchema } from './schema/upstream-glucose.schema.js';

export type NowFn = () => number;
export const GLUCOSE_NOW_FN = 'GLUCOSE_NOW_FN';
export const realNow: NowFn = () => Date.now();

/** Keep equal to the forecast service's `FORECAST_STALE_MIN`. */
export const DEFAULT_GLUCOSE_STALE_MINUTES = 20;
/** CLAUDE.md section 12 L1: implausible value. */
export const GLUCOSE_MIN_PLAUSIBLE_MGDL = 20;
export const GLUCOSE_MAX_PLAUSIBLE_MGDL = 600;
/** A reading dated further in the future than this is clock skew, never "fresh". */
export const FUTURE_TOLERANCE_MS = 5 * 60_000;

export const STALE_REASON = 'The latest glucose reading is too old to show. Check your sensor.';
export const UNVERIFIED_REASON = 'Glucose reading could not be verified.';
export const UNEXPECTED_REASON = 'Glucose service returned an unexpected response.';

export const REASON_BY_CAUSE: Record<ForecastFailureCause, string> = {
  not_configured: 'Glucose service is not configured.',
  unauthorized: 'Glucose service rejected the request.',
  timeout: 'Glucose service is not reachable right now.',
  network: 'Glucose service is not reachable right now.',
  bad_status: UNEXPECTED_REASON,
  invalid_json: UNEXPECTED_REASON,
};

function stale(lastMeasuredAt: string | null): GlucoseStaleResponse {
  return { status: 'stale', reason: STALE_REASON, lastMeasuredAt };
}

function unavailable(reason: string): GlucoseUnavailableResponse {
  return { status: 'unavailable', reason };
}

@Injectable()
export class GlucoseService {
  private readonly logger = new Logger(GlucoseService.name);

  constructor(
    private readonly client: ForecastUpstreamClient,
    private readonly config: ConfigService,
    @Inject(GLUCOSE_NOW_FN) private readonly now: NowFn,
  ) {}

  /** Never throws: every path is one of the three response variants. */
  async getGlucose(): Promise<GlucoseResponse> {
    const result = await this.client.fetchGlucose();

    if (result.kind === 'upstream_stale') return stale(null);
    if (result.kind === 'failed') return unavailable(REASON_BY_CAUSE[result.cause]);

    // Gate 1: structure. Log issue paths only - values are health data.
    const parsed = upstreamGlucoseSchema.safeParse(result.body);
    if (!parsed.success) {
      const paths = [...new Set(parsed.error.issues.map((i) => i.path.join('.') || '(root)'))];
      this.logger.warn(`GET /glucose upstream body failed Gate 1 at: ${paths.join(', ')}`);
      return unavailable(UNEXPECTED_REASON);
    }
    const body = parsed.data;

    // Gate 2: plausibility.
    if (body.glucose < GLUCOSE_MIN_PLAUSIBLE_MGDL || body.glucose > GLUCOSE_MAX_PLAUSIBLE_MGDL) {
      this.logger.warn('GET /glucose rejected: implausible glucose value');
      return unavailable(UNVERIFIED_REASON);
    }
    const nowMs = this.now();
    const measuredMs = Date.parse(body.timestamp);
    if (Number.isNaN(measuredMs) || measuredMs > nowMs + FUTURE_TOLERANCE_MS) {
      this.logger.warn('GET /glucose rejected: reading timestamp is in the future');
      return unavailable(UNVERIFIED_REASON);
    }

    // Rounded UP so a reading is never shown fresher than it is.
    const ageMinutes = Math.max(0, Math.ceil((nowMs - measuredMs) / 60_000));
    if (ageMinutes > this.staleMinutes()) return stale(body.timestamp);

    return mapUpstreamGlucose(body, ageMinutes);
  }

  private staleMinutes(): number {
    const raw = Number(this.config.get<string>('GLUCOSE_STALE_MINUTES'));
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_GLUCOSE_STALE_MINUTES;
  }
}
