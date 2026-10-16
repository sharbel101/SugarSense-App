import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { fetchForecast } from '../api/apiContext';
import type { ForecastDisplay } from '../api/forecastContract';
import {
  applyForecastResponse,
  deriveForecastView,
  INITIAL_FORECAST_STATE,
  reduceForecast,
  type ForecastState,
  type ForecastView,
} from './forecastState';

/** The reading changes every 3-5 minutes: do not poll faster. */
export const FORECAST_POLL_MS = 60_000;
const CLOCK_TICK_MS = 30_000;

type ForecastContextValue = {
  view: ForecastView;
  refreshing: boolean;
  refresh: () => void;
  /** Push a forecast the server returned with an event save into the screen immediately. */
  applyForecast: (forecast: ForecastDisplay) => void;
};

const ForecastContext = createContext<ForecastContextValue | null>(null);

/**
 * One poller for `GET /forecast`, shared by Home, Predict and the post-meal screen. Same shape as
 * GlucoseProvider: 60 s while foregrounded, one request at a time, abort on background, fetch on
 * return. Nothing is computed on the device (see forecastState.ts for what is kept and for how long).
 */
export function ForecastProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<ForecastState>(INITIAL_FORECAST_STATE);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [refreshing, setRefreshing] = useState(false);
  const runRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let disposed = false;

    const run = async () => {
      if (controller) return;
      const mine = new AbortController();
      controller = mine;
      const outcome = await fetchForecast(mine.signal);
      if (controller === mine) controller = null;
      if (disposed || mine.signal.aborted) return;
      const t = Date.now();
      setState((s) => reduceForecast(s, outcome, t));
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
      timer = setInterval(() => void run(), FORECAST_POLL_MS);
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

  const applyForecast = useCallback((forecast: ForecastDisplay) => {
    const t = Date.now();
    setState((s) => applyForecastResponse(s, forecast, t));
    setNowMs(t);
  }, []);

  const view = useMemo(() => deriveForecastView(state, nowMs), [state, nowMs]);
  const value = useMemo(() => ({ view, refreshing, refresh, applyForecast }), [view, refreshing, refresh, applyForecast]);
  return <ForecastContext.Provider value={value}>{children}</ForecastContext.Provider>;
}

export function useForecast(): ForecastContextValue {
  const ctx = useContext(ForecastContext);
  if (!ctx) throw new Error('useForecast must be used inside <ForecastProvider>');
  return ctx;
}
