import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { fetchInsights } from '../api/insightsApi';
import { deriveInsightsView, INITIAL_INSIGHTS_STATE, reduceInsights, type InsightsState, type InsightsView } from './insightsState';

/** Insights change once or twice a day plus occasional events: poll slowly. */
export const INSIGHTS_POLL_MS = 15 * 60_000;
/** Re-derive between polls so an insight past its expiry disappears. */
const CLOCK_TICK_MS = 60_000;

type InsightsContextValue = {
  view: InsightsView;
  refreshing: boolean;
  /** Fetch now with the spinner (pull-to-refresh, Retry). */
  refresh: () => void;
  /** Fetch now without the spinner (the tab gained focus). */
  load: () => void;
};

const InsightsContext = createContext<InsightsContextValue | null>(null);

/** One fetcher for the app: on mount, on return to the foreground, every 15 minutes, and on request. */
export function InsightsProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<InsightsState>(INITIAL_INSIGHTS_STATE);
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
      const outcome = await fetchInsights(mine.signal);
      if (controller === mine) controller = null;
      if (disposed || mine.signal.aborted) return;
      const t = Date.now();
      setState((s) => reduceInsights(s, outcome, t));
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
      timer = setInterval(() => void run(), INSIGHTS_POLL_MS);
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

  const load = useCallback(() => {
    void runRef.current?.();
  }, []);

  const view = useMemo(() => deriveInsightsView(state, nowMs), [state, nowMs]);
  const value = useMemo(() => ({ view, refreshing, refresh, load }), [view, refreshing, refresh, load]);
  return <InsightsContext.Provider value={value}>{children}</InsightsContext.Provider>;
}

export function useInsights(): InsightsContextValue {
  const ctx = useContext(InsightsContext);
  if (!ctx) throw new Error('useInsights must be used inside <InsightsProvider>');
  return ctx;
}
