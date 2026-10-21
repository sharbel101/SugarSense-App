/**
 * Contract for `GET /insights` (backend/src/insights/README.md is the source of truth).
 *
 * Pure on purpose (no imports; the base URL and fetch are injected) so plain Node can test it.
 * The parser is defensive: it keeps only the fields the screen uses, drops an insight that has no
 * headline or no `factsText`, caps string lengths and ignores unknown keys. It never edits, rounds
 * or re-ranks anything - `factsText` is shown as received (tags stripped by `stripEvidenceTags`).
 */

export type InsightTrigger = 'morning' | 'evening' | 'event';
export type InsightValidation = 'valid' | 'fallback' | 'not_applicable';

export interface Insight {
  id: string;
  /** Open-ended: an unknown category still renders from `headline` + `facts`. */
  category: string;
  headline: string;
  trigger: InsightTrigger | null;
  createdAt: string | null;
  expiresAt: string | null;
  /** Authoritative sentences, evidence tags already stripped. At least one. */
  facts: string[];
  /** Optional plain-language gloss; never replaces `facts`. */
  explanation: string | null;
  limitations: string[];
  validation: InsightValidation | null;
}

export interface InsightsOk {
  status: 'ok';
  generatedAt: string | null;
  notice: string | null;
  /** In the order received - do not re-sort. */
  insights: Insight[];
}

export interface InsightsEmpty {
  status: 'empty';
  reason: 'not_generated_yet' | 'none_active';
  lastRunAt: string | null;
  notice: string | null;
}

export type InsightsResponse = InsightsOk | InsightsEmpty;

export type InsightsFetchOutcome =
  | { kind: 'ok'; response: InsightsOk }
  | { kind: 'empty'; response: InsightsEmpty }
  /** Not JSON, wrong content type, HTTP 404/503, or an unknown `status`: the feature is not there (yet). */
  | { kind: 'unavailable' }
  | { kind: 'error'; cause: 'network' | 'timeout' | 'aborted' };

const MAX_HEADLINE = 200;
const MAX_SENTENCE = 1200;
const MAX_NOTICE = 600;
const MAX_LIST = 20;
const MAX_INSIGHTS = 10;

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isIso(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && Number.isFinite(Date.parse(v));
}

/** Remove evidence references such as "[E2]" or "[E1, E3]" from a sentence. */
export function stripEvidenceTags(text: string): string {
  return text
    .replace(/\s*\[E\d+(?:,\s*E\d+)*\]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = stripEvidenceTags(v).slice(0, max).trim();
  return t.length > 0 ? t : null;
}

function cleanList(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v.slice(0, MAX_LIST)) {
    const t = cleanText(item, max);
    if (t) out.push(t);
  }
  return out;
}

function parseInsight(raw: unknown): Insight | null {
  if (!isRec(raw)) return null;
  const headline = cleanText(raw.headline, MAX_HEADLINE);
  const facts = cleanList(raw.factsText, MAX_SENTENCE);
  if (!headline || facts.length === 0) return null; // no facts = nothing authoritative to show
  const trigger = raw.trigger === 'morning' || raw.trigger === 'evening' || raw.trigger === 'event' ? raw.trigger : null;
  const validation = raw.validation === 'valid' || raw.validation === 'fallback' || raw.validation === 'not_applicable' ? raw.validation : null;
  return {
    id: typeof raw.id === 'string' && raw.id.length > 0 ? raw.id.slice(0, 80) : '',
    category: typeof raw.category === 'string' ? raw.category.slice(0, 80) : '',
    headline,
    trigger,
    createdAt: isIso(raw.createdAt) ? raw.createdAt : null,
    expiresAt: isIso(raw.expiresAt) ? raw.expiresAt : null,
    facts,
    // A fallback means the explanation did not pass validation: show none.
    explanation: validation === 'fallback' ? null : cleanText(raw.explanation, MAX_SENTENCE),
    limitations: cleanList(raw.limitations, MAX_SENTENCE),
    validation,
  };
}

/** `null` = not a recognisable `/insights` body (the caller treats it as unavailable). */
export function parseInsightsResponse(body: unknown): InsightsResponse | { status: 'unavailable' } | null {
  if (!isRec(body)) return null;
  const notice = cleanText(body.notice, MAX_NOTICE);
  if (body.status === 'unavailable') return { status: 'unavailable' };
  if (body.status === 'empty') {
    return {
      status: 'empty',
      reason: body.reason === 'none_active' ? 'none_active' : 'not_generated_yet',
      lastRunAt: isIso(body.lastRunAt) ? body.lastRunAt : null,
      notice,
    };
  }
  if (body.status !== 'ok' || !Array.isArray(body.insights)) return null;
  const insights: Insight[] = [];
  for (const raw of body.insights.slice(0, MAX_INSIGHTS)) {
    const insight = parseInsight(raw);
    if (insight) insights.push(insight);
  }
  return { status: 'ok', generatedAt: isIso(body.generatedAt) ? body.generatedAt : null, notice, insights };
}

/** Drop insights whose `expiresAt` has passed on the device. Order is kept. */
export function visibleInsights(insights: Insight[], nowMs: number): Insight[] {
  return insights.filter((i) => i.expiresAt === null || Date.parse(i.expiresAt) > nowMs);
}

export const INSIGHTS_REQUEST_TIMEOUT_MS = 12_000;
export const INSIGHTS_LIMIT = 5;

type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; cache?: 'no-store'; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; headers?: { get(name: string): string | null }; json(): Promise<unknown> }>;

/**
 * `GET ${baseUrl}/insights?limit=5`. Never throws. A 200 HTML page (the SPA fallback before the
 * backend rollout), 404, 503, invalid JSON or an unknown `status` all become `unavailable`.
 */
export async function fetchInsightsFrom(
  baseUrl: string,
  signal?: AbortSignal,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  /** Transport headers (ngrok bypass, optional X-App-Token). Never health data. */
  extraHeaders: Record<string, string> = {},
): Promise<InsightsFetchOutcome> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, INSIGHTS_REQUEST_TIMEOUT_MS);
  const onOuterAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  try {
    const res = await fetchImpl(`${baseUrl}/insights?limit=${INSIGHTS_LIMIT}`, {
      method: 'GET',
      headers: { Accept: 'application/json', ...extraHeaders },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!res.ok) return { kind: 'unavailable' };
    const type = res.headers?.get('content-type');
    if (typeof type === 'string' && !type.toLowerCase().includes('json')) return { kind: 'unavailable' };
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { kind: 'unavailable' };
    }
    const parsed = parseInsightsResponse(body);
    if (parsed === null || parsed.status === 'unavailable') return { kind: 'unavailable' };
    return parsed.status === 'ok' ? { kind: 'ok', response: parsed } : { kind: 'empty', response: parsed };
  } catch {
    if (timedOut) return { kind: 'error', cause: 'timeout' };
    if (controller.signal.aborted) return { kind: 'error', cause: 'aborted' };
    return { kind: 'error', cause: 'network' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
  }
}
