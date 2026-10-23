/**
 * Client contract for the SugarSense Garmin metrics API (`/api/garmin/v1`, see
 * garmin-service/MASTER-PROMPT-GARMIN-FRONTEND.md). Every GET only reads OUR database; the one POST (`requestRefresh`) makes the
 * server fetch from Garmin right now because the person pressed refresh. Pure (no imports; fetch, clock and sleep are injected) so plain Node can test it.
 *
 * Rules: timestamps are UTC ISO strings and stay UTC here (local time only when displaying); a missing metric
 * is absent, never 0; a malformed entry is dropped rather than repaired; every failure becomes a typed result,
 * never a throw and never a number.
 */

export type Kind = 'instant' | 'interval' | 'cumulative' | 'daily_summary' | 'event';

export interface GarminEntry {
  /** A number, or an object for structured metrics (sleep_stages, hrv_status, activity_level). */
  value: number | Record<string, unknown>;
  unit: string | null;
  kind: Kind | string;
  origin: 'raw_sensor' | 'garmin_derived';
  measuredAt: string;
  fetchedAt: string | null;
  ageSeconds: number;
  quality: 'available' | 'stale';
  details: Record<string, unknown> | null;
}

export interface GarminLatest {
  generatedAt: string;
  lastSuccessfulFetchAt: string | null;
  metrics: Record<string, GarminEntry>;
  dataFreshness: 'fresh' | 'mixed' | 'stale' | 'no_data';
  missingMetrics: string[];
  warnings: string[];
}

export interface GarminObservation {
  metric: string;
  value: number | Record<string, unknown>;
  unit: string | null;
  kind: string;
  origin: 'raw_sensor' | 'garmin_derived';
  measuredAt: string;
  details: Record<string, unknown> | null;
}

export interface GarminHistory {
  observations: GarminObservation[];
  /** True when paging stopped at `maxPages` and more data exists. */
  truncated: boolean;
}

export interface GarminGroupStatus {
  lastSuccessfulFetchAt: string | null;
  lastMeasurementAt: string | null;
  stale: boolean;
}

export interface GarminStatus {
  /** normal | paused | backing_off | circuit_breaker_open | worker_not_running | ... */
  pollingState: string;
  pausedReason: string | null;
  groups: Record<string, GarminGroupStatus>;
  dataStale: boolean;
}

export type GarminError = 'not_configured' | 'unauthorized' | 'rate_limited' | 'unavailable' | 'server' | 'network' | 'timeout' | 'bad_body' | 'aborted';
export type GarminResult<T> = { ok: true; data: T } | { ok: false; error: GarminError; status?: number; code?: string };

export interface GarminConfig {
  /** e.g. `https://host/api/garmin/v1` or `/api/garmin/v1`; no trailing slash. */
  baseUrl: string;
  token: string | null;
  /** Transport-only headers (e.g. the ngrok interstitial bypass). */
  extraHeaders?: Record<string, string>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; cache?: 'no-store'; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export const GARMIN_TIMEOUT_MS = 10_000;
const RETRY_BACKOFF_MS = 400;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const isIso = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && Number.isFinite(Date.parse(v));
const iso = (v: unknown): string | null => (isIso(v) ? v : null);

function parseEntry(raw: unknown): GarminEntry | null {
  if (!isRec(raw)) return null;
  const value = typeof raw.value === 'number' && Number.isFinite(raw.value) ? raw.value : isRec(raw.value) ? raw.value : null;
  const age = num(raw.age_seconds);
  if (value === null || !isIso(raw.measured_at) || age === null || age < 0) return null;
  return {
    value,
    unit: typeof raw.unit === 'string' ? raw.unit : null,
    kind: typeof raw.kind === 'string' ? raw.kind : 'instant',
    origin: raw.origin === 'garmin_derived' ? 'garmin_derived' : 'raw_sensor',
    measuredAt: raw.measured_at,
    fetchedAt: iso(raw.fetched_at),
    ageSeconds: age,
    quality: raw.quality === 'stale' ? 'stale' : 'available',
    details: isRec(raw.details) ? raw.details : null,
  };
}

export function parseLatest(body: unknown): GarminLatest | null {
  if (!isRec(body) || !isIso(body.generated_at) || !isRec(body.metrics)) return null;
  const metrics: Record<string, GarminEntry> = {};
  for (const [name, raw] of Object.entries(body.metrics)) {
    const e = parseEntry(raw);
    if (e) metrics[name] = e;
  }
  const f = body.data_freshness;
  return {
    generatedAt: body.generated_at,
    lastSuccessfulFetchAt: iso(body.last_successful_fetch_at),
    metrics,
    dataFreshness: f === 'fresh' || f === 'mixed' || f === 'stale' || f === 'no_data' ? f : 'no_data',
    missingMetrics: Array.isArray(body.missing_metrics) ? body.missing_metrics.filter((x): x is string => typeof x === 'string') : [],
    warnings: Array.isArray(body.warnings) ? body.warnings.filter((x): x is string => typeof x === 'string').slice(0, 10) : [],
  };
}

function parseObservation(raw: unknown): GarminObservation | null {
  if (!isRec(raw) || typeof raw.metric !== 'string' || !isIso(raw.measured_at)) return null;
  const value = typeof raw.value === 'number' && Number.isFinite(raw.value) ? raw.value : isRec(raw.value) ? raw.value : null;
  if (value === null) return null;
  return {
    metric: raw.metric,
    value,
    unit: typeof raw.unit === 'string' ? raw.unit : null,
    kind: typeof raw.kind === 'string' ? raw.kind : 'instant',
    origin: raw.origin === 'garmin_derived' ? 'garmin_derived' : 'raw_sensor',
    measuredAt: raw.measured_at,
    details: isRec(raw.details) ? raw.details : null,
  };
}

export interface HistoryPage {
  observations: GarminObservation[];
  hasMore: boolean;
  nextCursor: string | null;
}

export function parseHistoryPage(body: unknown): HistoryPage | null {
  if (!isRec(body) || !Array.isArray(body.observations)) return null;
  const observations: GarminObservation[] = [];
  for (const raw of body.observations) {
    const o = parseObservation(raw);
    if (o) observations.push(o);
  }
  return { observations, hasMore: body.has_more === true, nextCursor: typeof body.next_cursor === 'string' ? body.next_cursor : null };
}

export function parseStatus(body: unknown): GarminStatus | null {
  if (!isRec(body) || !isRec(body.polling) || typeof body.polling.state !== 'string') return null;
  const groups: Record<string, GarminGroupStatus> = {};
  if (isRec(body.groups)) {
    for (const [name, g] of Object.entries(body.groups)) {
      if (!isRec(g)) continue;
      groups[name] = { lastSuccessfulFetchAt: iso(g.last_successful_fetch_at), lastMeasurementAt: iso(g.last_measurement_at), stale: g.stale === true };
    }
  }
  return {
    pollingState: body.polling.state,
    pausedReason: typeof body.polling.paused_reason === 'string' ? body.polling.paused_reason : null,
    groups,
    dataStale: body.data_stale === true,
  };
}

/* ------------------------------------------------------------------ transport */

function statusToError(status: number): GarminError {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 429) return 'rate_limited';
  if (status === 503) return 'unavailable';
  return 'server';
}

/**
 * One GET with a 10 s timeout. Retries ONCE (400 ms backoff) on a network error or HTTP 503; never on 4xx and
 * never on a timeout. `needsToken: false` is only for `/health`.
 */
export async function garminGet<T>(
  cfg: GarminConfig,
  path: string,
  query: Record<string, string | number | undefined>,
  parse: (body: unknown) => T | null,
  signal?: AbortSignal,
  needsToken = true,
): Promise<GarminResult<T>> {
  if (needsToken && !cfg.token) return { ok: false, error: 'not_configured' };
  const fetchImpl = cfg.fetchImpl ?? (fetch as unknown as FetchLike);
  const sleep = cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const qs = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  const url = `${cfg.baseUrl}${path}${qs ? `?${qs}` : ''}`;
  const headers: Record<string, string> = { Accept: 'application/json', ...(cfg.extraHeaders ?? {}), ...(needsToken && cfg.token ? { 'x-app-token': cfg.token } : {}) };

  let last: GarminResult<T> = { ok: false, error: 'network' };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal?.aborted) return { ok: false, error: 'aborted' };
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, cfg.timeoutMs ?? GARMIN_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await fetchImpl(url, { method: 'GET', headers, cache: 'no-store', signal: controller.signal });
      if (!res.ok) {
        const error = statusToError(res.status);
        let code: string | undefined;
        try {
          const b = await res.json();
          if (isRec(b) && isRec(b.error) && typeof b.error.code === 'string') code = b.error.code;
        } catch {
          /* no body */
        }
        last = { ok: false, error, status: res.status, code };
        if (res.status === 503 && attempt === 0) {
          await sleep(RETRY_BACKOFF_MS);
          continue;
        }
        return last;
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return { ok: false, error: 'bad_body' };
      }
      const data = parse(body);
      return data === null ? { ok: false, error: 'bad_body' } : { ok: true, data };
    } catch {
      if (timedOut) return { ok: false, error: 'timeout' };
      if (signal?.aborted) return { ok: false, error: 'aborted' };
      last = { ok: false, error: 'network' };
      if (attempt === 0) await sleep(RETRY_BACKOFF_MS);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  return last;
}

export interface RefreshResult {
  ok: boolean;
  /** ok | partial | unavailable | rate_limited | auth_failed | paused */
  outcome: string;
  requests: number;
  rowsNew: number;
  retryAt: string | null;
  message: string | null;
}

export const REFRESH_TIMEOUT_MS = 30_000;

/**
 * Ask the server to fetch from Garmin NOW (`POST /refresh`). One attempt, no retry (a retry would be a second Garmin call),
 * 30 s timeout. A Garmin-side problem arrives as `{ ok: true, data: { ok: false, outcome } }`; only a transport/auth failure is an error result.
 */
export async function requestRefresh(cfg: GarminConfig, signal?: AbortSignal): Promise<GarminResult<RefreshResult>> {
  if (!cfg.token) return { ok: false, error: 'not_configured' };
  if (signal?.aborted) return { ok: false, error: 'aborted' };
  const fetchImpl = cfg.fetchImpl ?? (fetch as unknown as FetchLike);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(cfg.timeoutMs ?? 0, REFRESH_TIMEOUT_MS));
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetchImpl(`${cfg.baseUrl}/refresh`, { method: 'POST', headers: { Accept: 'application/json', ...(cfg.extraHeaders ?? {}), 'x-app-token': cfg.token }, cache: 'no-store', signal: controller.signal });
    if (!res.ok) return { ok: false, error: statusToError(res.status), status: res.status };
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, error: 'bad_body' };
    }
    if (!isRec(body) || typeof body.ok !== 'boolean' || typeof body.outcome !== 'string') return { ok: false, error: 'bad_body' };
    return {
      ok: true,
      data: { ok: body.ok, outcome: body.outcome, requests: num(body.requests) ?? 0, rowsNew: num(body.rows_new) ?? 0, retryAt: iso(body.retry_at), message: typeof body.message === 'string' ? body.message : null },
    };
  } catch {
    if (timedOut) return { ok: false, error: 'timeout' };
    return { ok: false, error: signal?.aborted ? 'aborted' : 'network' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Plain-language text for a refresh that reached the server but not Garmin. `null` = nothing to tell the person. */
export function refreshProblemText(r: RefreshResult): string | null {
  switch (r.outcome) {
    case 'ok':
      return null;
    case 'partial':
      return 'Some Garmin data could not be refreshed. Showing what was received.';
    case 'rate_limited':
      return 'Garmin asked us to slow down, so this refresh was skipped. Showing the last data received.';
    case 'auth_failed':
      return 'Garmin rejected the SugarSense access key, so nothing could be refreshed. Showing the last data received.';
    case 'paused':
      return 'Refreshing from Garmin is switched off on the server. Showing the last data received.';
    default:
      return 'Garmin could not be reached just now. Showing the last data received.';
  }
}

export const fetchLatest = (cfg: GarminConfig, signal?: AbortSignal) => garminGet(cfg, '/metrics/latest', {}, parseLatest, signal);
export const fetchStatus = (cfg: GarminConfig, signal?: AbortSignal) => garminGet(cfg, '/status', {}, parseStatus, signal);

/** History for `metrics` between `from` and `to` (ISO, UTC). Follows `next_cursor` up to `maxPages` pages. */
export async function fetchHistory(
  cfg: GarminConfig,
  q: { metrics: string[]; from: string; to: string; limit?: number; maxPages?: number; maxPoints?: number },
  signal?: AbortSignal,
): Promise<GarminResult<GarminHistory>> {
  const maxPages = q.maxPages ?? 6;
  const all: GarminObservation[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const r = await garminGet(cfg, '/metrics/history', { metrics: q.metrics.join(','), from: q.from, to: q.to, limit: q.limit ?? 500, max_points: q.maxPoints, cursor }, parseHistoryPage, signal);
    if (!r.ok) return r;
    all.push(...r.data.observations);
    if (!r.data.hasMore || !r.data.nextCursor) return { ok: true, data: { observations: all, truncated: false } };
    cursor = r.data.nextCursor;
  }
  return { ok: true, data: { observations: all, truncated: true } };
}

/** Plain-language text for an error. Never a number. */
export function garminErrorText(error: GarminError): string {
  switch (error) {
    case 'not_configured':
      return 'Garmin data is not set up in this app yet.';
    case 'unauthorized':
      return 'Garmin data is unavailable: this app is not authorised to read it.';
    case 'rate_limited':
      return 'Too many requests. Try again in a minute.';
    case 'unavailable':
      return 'Garmin data is unavailable right now.';
    case 'timeout':
      return 'Garmin data took too long to load.';
    case 'network':
      return 'Can’t reach SugarSense. Check your connection.';
    case 'bad_body':
    case 'server':
      return 'Garmin data could not be read right now.';
    case 'aborted':
      return '';
  }
}
