import {
  postInsulin,
  postMeal,
  SERVER_HAS_IT,
  type ApiContext,
  type WriteOutcome,
  type WriteResult,
} from '../api/eventsApi.ts';
import type { ForecastDisplay } from '../api/forecastContract';
import type { InsulinEvent, LoggedEvent } from './events';

/**
 * The offline-safe event queue. Pure (the API context is injected) so plain-Node tests can run it.
 *
 * Every event keeps its client-generated id and sends it as `clientId`: resending can never create a
 * second event. An event is `pending` until the server confirms it - a network error, 404 (route not
 * deployed), 503 or any unconfirmed answer keeps it pending and retried; it is only `saved` when the
 * server said so, and only `failed` when the server said the entry itself is invalid.
 */

export type EventStatus = 'pending' | 'saved' | 'failed';

export type EventRecord = {
  event: LoggedEvent;
  status: EventStatus;
  /** The server's id, once it has the event. Needed for edits and for linking a dose to a meal. */
  serverId: string | null;
  revision: number | null;
  /** Server's reason for `failed`, or the text of an unresolved duplicate warning. */
  reason: string | null;
  /** The server said "looks like an entry you already made" and the person has not decided yet. */
  awaitingDuplicateDecision: boolean;
  allowDuplicate: boolean;
  attempts: number;
  nextAttemptAtMs: number;
  /** The save response carried a refreshed forecast (so "Forecast updated" is true). */
  forecastReturned: boolean;
  /** Server cancelled/edited states etc. are not tracked here; the list view reads GET /events/recent. */
};

export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_MAX_MS = 5 * 60_000;

export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

export function newRecord(event: LoggedEvent, nowMs: number): EventRecord {
  return {
    event,
    status: 'pending',
    serverId: null,
    revision: null,
    reason: null,
    awaitingDuplicateDecision: false,
    allowDuplicate: false,
    attempts: 0,
    nextAttemptAtMs: nowMs,
    forecastReturned: false,
  };
}

/** Idempotent by event id; newest event first. */
export function addRecord(records: EventRecord[], rec: EventRecord): EventRecord[] {
  if (records.some((r) => r.event.id === rec.event.id)) return records;
  return [...records, rec].sort((a, b) => Date.parse(b.event.occurredAtUtc) - Date.parse(a.event.occurredAtUtc));
}

/** Records that should be sent now: pending, no unresolved duplicate question, and past their backoff. */
export function dueRecords(records: EventRecord[], nowMs: number, force = false): EventRecord[] {
  return records.filter((r) => r.status === 'pending' && !r.awaitingDuplicateDecision && (force || r.nextAttemptAtMs <= nowMs));
}

/**
 * An insulin entry may point at a meal by its LOCAL id (the meal was just logged and the server has
 * not confirmed it yet) or by the server's id. Returns the server id to send, `null` for "no link",
 * or `'defer'` when the meal is local and not yet saved (send the dose after the meal).
 */
export function resolveMealLink(records: EventRecord[], mealId: string | null): string | null | 'defer' {
  if (mealId === null) return null;
  const local = records.find((r) => r.event.id === mealId && r.event.kind === 'meal');
  if (!local) return mealId;
  return local.serverId ?? 'defer';
}

export type SendReport = {
  record: EventRecord;
  /** A refreshed forecast to push into the screen, when the server returned one. */
  forecast: ForecastDisplay | null;
  /** True when nothing was sent (waiting for a linked meal). */
  skipped: boolean;
};

function afterOutcome(rec: EventRecord, outcome: WriteOutcome<{ id: string; revision: number }>, nowMs: number): EventRecord {
  const result: WriteResult = outcome.result;
  if (SERVER_HAS_IT.has(result)) {
    return {
      ...rec,
      status: 'saved',
      serverId: outcome.item?.id ?? rec.serverId,
      revision: outcome.item?.revision ?? rec.revision,
      reason: null,
      awaitingDuplicateDecision: false,
      forecastReturned: outcome.forecast !== null,
    };
  }
  if (result === 'duplicate') {
    // Not a failure and not saved: ask the person. Never loop on it.
    return { ...rec, status: 'pending', awaitingDuplicateDecision: true, reason: outcome.reason ?? 'This looks like an entry you already made.' };
  }
  if (result === 'invalid' || result === 'conflict' || result === 'not_found') {
    return { ...rec, status: 'failed', reason: outcome.reason ?? 'The server could not accept this entry.' };
  }
  // server_unavailable / network_error: not confirmed - stay pending, retry later with backoff.
  const attempts = rec.attempts + 1;
  return { ...rec, status: 'pending', attempts, nextAttemptAtMs: nowMs + backoffMs(attempts) };
}

/** Sends one record. Never throws. */
export async function sendRecord(ctx: ApiContext, all: EventRecord[], rec: EventRecord, nowMs: number): Promise<SendReport> {
  const e = rec.event;
  if (e.kind === 'meal') {
    const outcome = await postMeal(ctx, e, rec.allowDuplicate);
    return { record: afterOutcome(rec, outcome, nowMs), forecast: outcome.forecast, skipped: false };
  }
  const link = resolveMealLink(all, e.mealId);
  if (link === 'defer') return { record: rec, forecast: null, skipped: true };
  const toSend: InsulinEvent = { ...e, mealId: link };
  const outcome = await postInsulin(ctx, toSend, rec.allowDuplicate);
  return { record: afterOutcome(rec, outcome, nowMs), forecast: outcome.forecast, skipped: false };
}

/** What is persisted: only entries the server has not confirmed. A confirmed entry lives on the server. */
export function serializeQueue(records: EventRecord[]): string {
  return JSON.stringify({ v: 1, records: records.filter((r) => r.status !== 'saved') });
}

/** Tolerant reader: anything malformed yields an empty queue, never a crash. */
export function deserializeQueue(text: string | null): EventRecord[] {
  if (!text) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || (parsed as { v?: unknown }).v !== 1) return [];
    const list = (parsed as { records?: unknown }).records;
    if (!Array.isArray(list)) return [];
    const out: EventRecord[] = [];
    for (const r of list) {
      if (typeof r !== 'object' || r === null) continue;
      const rec = r as Partial<EventRecord>;
      const ev = rec.event as Partial<LoggedEvent> | undefined;
      if (!ev || typeof ev.id !== 'string' || (ev.kind !== 'meal' && ev.kind !== 'insulin') || typeof ev.occurredAtUtc !== 'string') continue;
      out.push({
        event: ev as LoggedEvent,
        status: rec.status === 'failed' ? 'failed' : 'pending',
        serverId: typeof rec.serverId === 'string' ? rec.serverId : null,
        revision: typeof rec.revision === 'number' ? rec.revision : null,
        reason: typeof rec.reason === 'string' ? rec.reason : null,
        awaitingDuplicateDecision: rec.awaitingDuplicateDecision === true,
        allowDuplicate: rec.allowDuplicate === true,
        attempts: typeof rec.attempts === 'number' ? rec.attempts : 0,
        nextAttemptAtMs: 0,
        forecastReturned: false,
      });
    }
    return out;
  } catch {
    return [];
  }
}
