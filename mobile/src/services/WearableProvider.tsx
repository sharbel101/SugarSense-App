import { useFocusEffect } from '@react-navigation/native';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { garminConfig } from '../api/garminApi';
import type { GarminError } from '../api/garminContract';
import { buildWearableFromGarmin, type GarminSnapshot } from './garminAdapter';
import { EMPTY_HISTORY, HISTORY_REFRESH_MS, loadGarminFast, loadHistoryBundle, refreshFromGarmin, type HistoryBundle } from './garminLoad';
import { getWearableData } from './wearableData';
import type { WearableData } from './wearableModel';

/**
 * Opening the screen and pulling down / Retry each make the server read Garmin right now (no time limit: every press is a new Garmin call).
 * While the screen stays open it only re-reads our own database once a minute, which costs Garmin nothing. Nothing runs in the background.
 */
export const WEARABLE_POLL_MS = 60_000;
const CLOCK_TICK_MS = 30_000;

type Ctx = {
  /** `null` while the first load is running or when it failed with nothing to show. */
  data: WearableData | null;
  /** Server-adjusted "now" (ms): ages do not depend on the phone clock. */
  now: number;
  loading: boolean;
  /** The newest attempt failed. If `data` is set it is the previous (older) data. */
  error: GarminError | null;
  /** True when a real Garmin source is configured; false = labelled demo data. */
  live: boolean;
  /** The latest values are on screen but the charts' history has not loaded (yet, or it failed). */
  historyIncomplete: boolean;
  /** Pull-to-refresh / Retry: fetch from Garmin now, then reload. Always starts unless one is already running. */
  refresh: () => { started: boolean };
  /** Set when the last refresh reached the server but Garmin could not be read (the older data is still shown). */
  syncProblem: string | null;
  /** When the data on screen was last loaded (device clock), or null. */
  updatedAt: number | null;
  /** Register that a Wearable screen is visible (refreshes it while it is visible). Returns the unregister function. */
  watch: () => () => void;
};

const WearableContext = createContext<Ctx | null>(null);

export function WearableProvider({ children }: { children: React.ReactNode }) {
  const cfg = useMemo(() => garminConfig(), []);
  const live = cfg !== null;
  const [clock, setClock] = useState(() => Date.now());
  const [snapshot, setSnapshot] = useState<{ data: WearableData; at: number } | null>(null);
  const [loading, setLoading] = useState(live);
  const [error, setError] = useState<GarminError | null>(null);
  const [historyIncomplete, setHistoryIncomplete] = useState(false);
  const [syncProblem, setSyncProblem] = useState<string | null>(null);
  const [demoAt, setDemoAt] = useState(() => Date.now());
  const watchers = useRef(0);
  const runRef = useRef<((fromGarmin: boolean) => { started: boolean }) | null>(null);
  const startRef = useRef<(() => void) | null>(null);
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!cfg) return;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let history: { history: HistoryBundle; at: number } | null = null;
    let disposed = false;

    // The latest values (two small calls) are shown as soon as they arrive; the history for the charts follows. A slow or failed history never blocks
    // the screen, and an exception while building the screen becomes an error message instead of an endless "Loading".
    const go = async (t: number, fromGarmin: boolean) => {
      const mine = new AbortController();
      controller = mine;
      setLoading(true);
      try {
        if (fromGarmin) {
          const r = await refreshFromGarmin(cfg, mine.signal);
          if (disposed || mine.signal.aborted) return;
          setSyncProblem(r.problem);
        }
        const fast = await loadGarminFast(cfg, mine.signal);
        if (disposed || mine.signal.aborted) return;
        setClock(Date.now());
        if (!fast.ok) {
          if (fast.error !== 'aborted') setError(fast.error);
          return;
        }
        const publish = (h: HistoryBundle) => {
          const s: GarminSnapshot = { latest: fast.latest, status: fast.status, ...h };
          setSnapshot({ data: buildWearableFromGarmin(s, t), at: t });
        };
        const needHistory = fromGarmin || !history || t - history.at >= HISTORY_REFRESH_MS;
        publish(history ? history.history : EMPTY_HISTORY);
        setError(null);
        if (!needHistory) return;
        setHistoryIncomplete(true);
        const hist = await loadHistoryBundle(cfg, t, mine.signal);
        if (disposed || mine.signal.aborted) return;
        if (hist.ok) {
          history = { history: hist.data, at: t };
          publish(hist.data);
          setHistoryIncomplete(false);
        }
      } catch {
        if (!disposed && !mine.signal.aborted) setError('bad_body');
      } finally {
        if (controller === mine) {
          controller = null;
          setLoading(false);
        }
      }
    };
    const run = (fromGarmin: boolean): { started: boolean } => {
      if (controller) return { started: false };
      void go(Date.now(), fromGarmin);
      return { started: true };
    };
    runRef.current = run;

    stopRef.current = () => {
      if (timer) clearInterval(timer);
      timer = null;
      controller?.abort();
      controller = null;
      setLoading(false);
    };
    startRef.current = () => {
      if (timer || watchers.current <= 0 || AppState.currentState !== 'active') return;
      run(true); // opening the screen = a refresh: read Garmin now
      timer = setInterval(() => run(false), WEARABLE_POLL_MS); // then only re-read our own database
    };
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') startRef.current?.();
      else stopRef.current?.();
    });
    return () => {
      disposed = true;
      sub.remove();
      stopRef.current?.();
      runRef.current = null;
      startRef.current = null;
      stopRef.current = null;
    };
  }, [cfg]);

  useEffect(() => {
    const id = setInterval(() => setClock(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const watch = useCallback(() => {
    watchers.current += 1;
    if (watchers.current === 1) startRef.current?.();
    return () => {
      watchers.current = Math.max(0, watchers.current - 1);
      if (watchers.current === 0) stopRef.current?.();
    };
  }, []);

  const refresh = useCallback((): { started: boolean } => {
    if (cfg) return runRef.current?.(true) ?? { started: false };
    setDemoAt(Date.now());
    return { started: true };
  }, [cfg]);

  const demo = useMemo(() => (live ? null : getWearableData(demoAt)), [live, demoAt]);
  const data = live ? (snapshot ? snapshot.data : null) : demo;
  const now = live ? (data ? clock + data.clockOffsetMs : clock) : demoAt;

  const updatedAt = live ? (snapshot ? snapshot.at : null) : demoAt;
  const value = useMemo<Ctx>(
    () => ({ data, now, loading, error, live, historyIncomplete: live && historyIncomplete, refresh, syncProblem: live ? syncProblem : null, updatedAt, watch }),
    [data, now, loading, error, live, historyIncomplete, refresh, syncProblem, updatedAt, watch],
  );
  return <WearableContext.Provider value={value}>{children}</WearableContext.Provider>;
}

/** Wearable data for a screen. Calling this inside a screen also refreshes it (Garmin read on open, then a 60 s database re-read) while that screen is focused. */
export function useWearable(): Ctx {
  const ctx = useContext(WearableContext);
  if (!ctx) throw new Error('useWearable must be used inside <WearableProvider>');
  const { watch } = ctx;
  useFocusEffect(useCallback(() => watch(), [watch]));
  return ctx;
}
