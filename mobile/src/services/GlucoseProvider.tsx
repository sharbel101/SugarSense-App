import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { fetchGlucose } from '../api/glucoseApi';
import {
  deriveGlucoseView,
  INITIAL_GLUCOSE_STATE,
  reduceGlucose,
  type GlucoseState,
  type GlucoseView,
} from './glucoseState';

/** The reading changes every ~3-5 min and the server caches per reading: do not poll faster. */
export const GLUCOSE_POLL_MS = 60_000;
/** Re-derive ages/staleness between polls so an old number can never sit there looking current. */
const CLOCK_TICK_MS = 30_000;

type GlucoseContextValue = {
  view: GlucoseView;
  /** A manual retry is in flight. */
  refreshing: boolean;
  refresh: () => void;
};

const GlucoseContext = createContext<GlucoseContextValue | null>(null);

/**
 * One poller for the whole app, shared by Home and Predict. Polls every 60 s while the app is in
 * the foreground (AppState 'active'), fetches immediately on returning to the foreground, aborts
 * the in-flight request on background/unmount. Shows `loading` only until the first fetch lands;
 * see glucoseState.ts for what is kept across failed refreshes and when a number turns stale.
 */
export function GlucoseProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<GlucoseState>(INITIAL_GLUCOSE_STATE);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [refreshing, setRefreshing] = useState(false);
  const runRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let disposed = false;

    const run = async () => {
      if (controller) return; // one request at a time
      const mine = new AbortController();
      controller = mine;
      const outcome = await fetchGlucose(mine.signal);
      if (controller === mine) controller = null;
      if (disposed || mine.signal.aborted) return;
      const t = Date.now();
      setState((s) => reduceGlucose(s, outcome, t));
      setNowMs(t);
    };
    runRef.current = run;

    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
      controller?.abort();
      controller = null;
    };
    const start = () => {
      if (timer) return;
      void run();
      timer = setInterval(() => void run(), GLUCOSE_POLL_MS);
    };

    if (AppState.currentState === 'active') start();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') start();
      else stop();
    });
    const clock = setInterval(() => setNowMs(Date.now()), CLOCK_TICK_MS);

    return () => {
      disposed = true;
      sub.remove();
      clearInterval(clock);
      stop();
      runRef.current = null;
    };
  }, []);

  const refresh = useCallback(() => {
    const run = runRef.current;
    if (!run) return;
    setRefreshing(true);
    void run().finally(() => setRefreshing(false));
  }, []);

  const view = useMemo(() => deriveGlucoseView(state, nowMs), [state, nowMs]);
  const value = useMemo(() => ({ view, refreshing, refresh }), [view, refreshing, refresh]);

  return <GlucoseContext.Provider value={value}>{children}</GlucoseContext.Provider>;
}

export function useGlucose(): GlucoseContextValue {
  const ctx = useContext(GlucoseContext);
  if (!ctx) throw new Error('useGlucose must be used inside <GlucoseProvider>');
  return ctx;
}
