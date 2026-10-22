import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { apiContext } from '../api/apiContext';
import {
  getRecent,
  patchInsulin,
  patchMeal,
  SERVER_HAS_IT,
  type InsulinPatch,
  type InsulinView,
  type MealPatch,
  type MealView,
  type WriteOutcome,
} from '../api/eventsApi';
import type { LoggedEvent, MealEvent } from './events';
import {
  addRecord,
  deserializeQueue,
  dueRecords,
  newRecord,
  sendRecord,
  serializeQueue,
  type EventRecord,
} from './eventQueue';
import { useForecast } from './ForecastProvider';
import { noteEntrySaved } from './LastKnownSync';
import { recentAfterRefresh, recentWhileRefreshing, type RecentState } from './recentState';

const STORAGE_KEY = 'sugarsense.eventQueue.v1';
const RETRY_TICK_MS = 10_000;

export type { RecentState } from './recentState';

type EventsContextValue = {
  /** Entries the server has not confirmed (pending / failed) plus just-saved ones this session. */
  records: EventRecord[];
  pendingCount: number;
  /** Queue an event and send it now. Idempotent by `event.id`: a repeat adds nothing. */
  addEvent: (event: LoggedEvent) => void;
  /** Retry every pending entry now ("Send now"). */
  sendNow: () => void;
  /** After a duplicate warning: resend with `allowDuplicate`. */
  saveAnyway: (id: string) => void;
  /** Remove an entry that is still only on this device (pending / failed). */
  discard: (id: string) => void;
  /** A photo meal the server already stored (`mealEventId`): remember it without re-sending. */
  adoptSavedMeal: (event: MealEvent, serverId: string) => void;
  /** Correct or cancel a meal on the server. The refreshed forecast is pushed to the screen. */
  editMeal: (serverId: string, patch: MealPatch) => Promise<WriteOutcome<MealView>>;
  editInsulin: (serverId: string, patch: InsulinPatch) => Promise<WriteOutcome<InsulinView>>;
  recent: RecentState;
  refreshRecent: () => void;
};

const EventsContext = createContext<EventsContextValue | null>(null);

/**
 * Event store backed by the server and safe offline. Each event keeps its client id (sent as
 * `clientId`), so retries can never create a second event. Entries the server has not confirmed are
 * persisted (AsyncStorage; every call is guarded) and retried with backoff and on each return to the
 * foreground. Nothing is called "saved" until the server says so.
 */
export function EventsProvider({ children }: { children: React.ReactNode }) {
  const { applyForecast } = useForecast();
  const [records, setRecords] = useState<EventRecord[]>([]);
  const [recent, setRecent] = useState<RecentState>({ kind: 'idle' });
  const recordsRef = useRef<EventRecord[]>([]);
  const sendingRef = useRef(false);
  const loadedRef = useRef(false);

  useEffect(() => {
    recordsRef.current = records;
  }, [records]);

  // Restore the unsent queue once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let text: string | null = null;
      try {
        text = await AsyncStorage.getItem(STORAGE_KEY);
      } catch {
        text = null;
      }
      if (cancelled) return;
      const restored = deserializeQueue(text);
      loadedRef.current = true;
      if (restored.length > 0) setRecords((cur) => restored.reduce((acc, r) => addRecord(acc, r), cur));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist the unsent queue whenever it changes (only after the restore, so we never overwrite it with an empty list).
  useEffect(() => {
    if (!loadedRef.current) return;
    AsyncStorage.setItem(STORAGE_KEY, serializeQueue(records)).catch(() => undefined);
  }, [records]);

  // Keeps the list on screen while the new one loads, and keeps the last good list if the refresh fails.
  const refreshRecent = useCallback(() => {
    setRecent((cur) => recentWhileRefreshing(cur));
    void getRecent(apiContext, 48).then((r) => setRecent((cur) => recentAfterRefresh(cur, r.kind === 'ok' ? r : { kind: 'unavailable' })));
  }, []);

  const flush = useCallback(
    async (force: boolean) => {
      if (sendingRef.current) return;
      sendingRef.current = true;
      let anySaved = false;
      try {
        let progressed = true;
        // A dose may wait for its meal: loop while something was sent, so the dose goes right after.
        while (progressed) {
          progressed = false;
          const due = dueRecords(recordsRef.current, Date.now(), force);
          for (const rec of due) {
            const report = await sendRecord(apiContext, recordsRef.current, rec, Date.now());
            if (report.skipped) continue;
            progressed = progressed || report.record.status === 'saved';
            anySaved = anySaved || report.record.status === 'saved';
            // Before the refreshed forecast is applied: the remembered on-board amounts predate this save.
            if (report.record.status === 'saved') noteEntrySaved();
            recordsRef.current = recordsRef.current.map((r) => (r.event.id === rec.event.id ? report.record : r));
            setRecords(recordsRef.current);
            if (report.forecast) applyForecast(report.forecast);
          }
        }
      } finally {
        sendingRef.current = false;
      }
      // What was just saved must show up in the lists (Home, Meals) without waiting for a reload.
      if (anySaved) refreshRecent();
    },
    [applyForecast, refreshRecent],
  );

  // Retry timer + on every return to the foreground.
  useEffect(() => {
    const tick = setInterval(() => {
      if (AppState.currentState === 'active') void flush(false);
    }, RETRY_TICK_MS);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') {
        void flush(true);
        refreshRecent();
      }
    });
    return () => {
      clearInterval(tick);
      sub.remove();
    };
  }, [flush, refreshRecent]);

  const addEvent = useCallback(
    (event: LoggedEvent) => {
      if (recordsRef.current.some((r) => r.event.id === event.id)) return;
      recordsRef.current = addRecord(recordsRef.current, newRecord(event, Date.now()));
      setRecords(recordsRef.current);
      void flush(true);
    },
    [flush],
  );

  const sendNow = useCallback(() => void flush(true), [flush]);

  const saveAnyway = useCallback(
    (id: string) => {
      recordsRef.current = recordsRef.current.map((r) =>
        r.event.id === id ? { ...r, awaitingDuplicateDecision: false, allowDuplicate: true, reason: null } : r,
      );
      setRecords(recordsRef.current);
      void flush(true);
    },
    [flush],
  );

  const discard = useCallback((id: string) => {
    recordsRef.current = recordsRef.current.filter((r) => !(r.event.id === id && r.status !== 'saved'));
    setRecords(recordsRef.current);
  }, []);

  const adoptSavedMeal = useCallback((event: MealEvent, serverId: string) => {
    if (recordsRef.current.some((r) => r.event.id === event.id)) return;
    const rec: EventRecord = { ...newRecord(event, Date.now()), status: 'saved', serverId };
    recordsRef.current = addRecord(recordsRef.current, rec);
    setRecords(recordsRef.current);
  }, []);

  const editMeal = useCallback(
    async (serverId: string, patch: MealPatch) => {
      const out = await patchMeal(apiContext, serverId, patch);
      if (SERVER_HAS_IT.has(out.result)) {
        noteEntrySaved();
        if (out.forecast) applyForecast(out.forecast);
        refreshRecent();
      }
      return out;
    },
    [applyForecast, refreshRecent],
  );

  const editInsulin = useCallback(
    async (serverId: string, patch: InsulinPatch) => {
      const out = await patchInsulin(apiContext, serverId, patch);
      if (SERVER_HAS_IT.has(out.result)) {
        noteEntrySaved();
        if (out.forecast) applyForecast(out.forecast);
        refreshRecent();
      }
      return out;
    },
    [applyForecast, refreshRecent],
  );

  const pendingCount = useMemo(() => records.filter((r) => r.status === 'pending').length, [records]);
  const value = useMemo<EventsContextValue>(
    () => ({ records, pendingCount, addEvent, sendNow, saveAnyway, discard, adoptSavedMeal, editMeal, editInsulin, recent, refreshRecent }),
    [records, pendingCount, addEvent, sendNow, saveAnyway, discard, adoptSavedMeal, editMeal, editInsulin, recent, refreshRecent],
  );
  return <EventsContext.Provider value={value}>{children}</EventsContext.Provider>;
}

export function useEvents(): EventsContextValue {
  const ctx = useContext(EventsContext);
  if (!ctx) throw new Error('useEvents must be used inside EventsProvider');
  return ctx;
}
