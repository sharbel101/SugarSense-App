import { useFocusEffect } from '@react-navigation/native';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { garminConfig } from '../api/garminApi';
import type { GarminError } from '../api/garminContract';
import { buildWearableFromGarmin, type GarminSnapshot } from './garminAdapter';
import { loadGarmin, refreshGate, type HistoryBundle } from './garminLoad';
import { getWearableData } from './wearableData';
import type { WearableData } from './wearableModel';

/**
 * The visible screen asks whether a refresh is due once a minute, but `refreshGate` only lets a call through
 * every 6 minutes (1 minute after a failed one). Nothing runs in the background.
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
  /** Pull-to-refresh / Retry. Calls the API only if the 6-minute limit allows; otherwise says how long to wait. */
  refresh: () => { started: boolean; waitMs: number };
  /** When the data on screen was last loaded (device clock), or null. */
  updatedAt: number | null;
  /** Register that a Wearable screen is visible (starts the 60 s refresh). Returns the unregister function. */
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
  const [demoAt, setDemoAt] = useState(() => Date.now());
  const watchers = useRef(0);
  const runRef = useRef<(() => { started: boolean; waitMs: number }) | null>(null);
  const startRef = useRef<(() => void) | null>(null);
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!cfg) return;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let history: { history: HistoryBundle; at: number } | null = null;
    let disposed = false;

    let last: { at: number; ok: boolean } | null = null;

    const go = async (t: number) => {
      const mine = new AbortController();
      controller = mine;
      setLoading(true);
      const out = await loadGarmin(cfg, t, history, mine.signal);
      last = { at: t, ok: out.ok };
      if (controller === mine) controller = null;
      if (disposed || mine.signal.aborted) return;
      setLoading(false);
      setClock(Date.now());
      if (!out.ok) {
        if (out.error !== 'aborted') setError(out.error);
        return;
      }
      const s: GarminSnapshot = out.snapshot;
      history = { history: { heartRate: s.heartRate, stepsToday: s.stepsToday, stressBattery: s.stressBattery, daily: s.daily, exercises: s.exercises }, at: out.historyAt ?? t };
      setError(null);
      setSnapshot({ data: buildWearableFromGarmin(s, t), at: t });
    };
    const run = (): { started: boolean; waitMs: number } => {
      if (controller) return { started: false, waitMs: 0 };
      const gate = refreshGate(last, Date.now());
      if (!gate.allowed) return gate.waitMs >= 0 ? { started: false, waitMs: gate.waitMs } : { started: false, waitMs: 0 };
      void go(Date.now());
      return { started: true, waitMs: 0 };
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
      run();
      timer = setInterval(() => run(), WEARABLE_POLL_MS);
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

  const refresh = useCallback((): { started: boolean; waitMs: number } => {
    if (cfg) return runRef.current?.() ?? { started: false, waitMs: 0 };
    setDemoAt(Date.now());
    return { started: true, waitMs: 0 };
  }, [cfg]);

  const demo = useMemo(() => (live ? null : getWearableData(demoAt)), [live, demoAt]);
  const data = live ? (snapshot ? snapshot.data : null) : demo;
  const now = live ? (data ? clock + data.clockOffsetMs : clock) : demoAt;

  const updatedAt = live ? (snapshot ? snapshot.at : null) : demoAt;
  const value = useMemo<Ctx>(() => ({ data, now, loading, error, live, refresh, updatedAt, watch }), [data, now, loading, error, live, refresh, updatedAt, watch]);
  return <WearableContext.Provider value={value}>{children}</WearableContext.Provider>;
}

/** Wearable data for a screen. Calling this inside a screen also starts the 60 s refresh while that screen is focused. */
export function useWearable(): Ctx {
  const ctx = useContext(WearableContext);
  if (!ctx) throw new Error('useWearable must be used inside <WearableProvider>');
  const { watch } = ctx;
  useFocusEffect(useCallback(() => watch(), [watch]));
  return ctx;
}
