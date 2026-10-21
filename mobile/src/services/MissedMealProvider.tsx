import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useEvents } from './EventsProvider';
import { useGlucose } from './GlucoseProvider';
import { mealRows } from './homeEntries';
import {
  deserializeMissedMeal,
  detectMealSpike,
  dismissMissedMeal,
  evaluateMissedMeal,
  INITIAL_MISSED_MEAL_STATE,
  isDismissed,
  serializeMissedMeal,
  spikeSummary,
  type MealSpike,
  type MissedMealState,
} from './mealSpike';
import { useRiskAlerts } from './RiskAlertsProvider';
import { alertPermission, showAlert } from './webNotifications';

const KEY = 'sugarsense.missedMeal.v1';

type Value = {
  /** A fast rise with no meal logged around it, or null. Hidden after "Not a meal". */
  spike: MealSpike | null;
  summary: string | null;
  /** "Not a meal": stay quiet about this for 3 hours. */
  dismiss: () => void;
};

const MissedMealContext = createContext<Value | null>(null);

/**
 * Watches the readings and the logged meals. When glucose rises fast and no meal is logged around it, Home shows a
 * "Possible missed meal log" box and (if the person turned alerts on) one notification asks them to log the meal
 * and insulin if they had them. It only runs while the app is open. It never guesses carbs or a dose.
 * If the meal list could not be read, nothing is raised: an unknown meal history is not "no meal".
 */
export function MissedMealProvider({ children }: { children: React.ReactNode }) {
  const { view } = useGlucose();
  const { recent, records } = useEvents();
  const { enabled } = useRiskAlerts();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [state, setState] = useState<MissedMealState>(INITIAL_MISSED_MEAL_STATE);
  const [loaded, setLoaded] = useState(false);
  const stateRef = useRef<MissedMealState>(INITIAL_MISSED_MEAL_STATE);

  useEffect(() => {
    let alive = true;
    void AsyncStorage.getItem(KEY)
      .then((raw) => {
        if (!alive) return;
        stateRef.current = deserializeMissedMeal(raw);
        setState(stateRef.current);
        setLoaded(true);
      })
      .catch(() => alive && setLoaded(true));
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const okData = view.kind === 'ok' ? view.data : null;
  const mealsKnown = recent.kind === 'ok';
  const spike = useMemo<MealSpike | null>(() => {
    if (!okData || !mealsKnown) return null;
    const readings = [...okData.history, { time: okData.measuredAt, value: okData.glucoseMgdl }];
    const meals = mealRows(recent.kind === 'ok' ? recent.meals : [], records).map((r) => Date.parse(r.timeIso));
    return detectMealSpike(readings, meals, nowMs);
  }, [okData, mealsKnown, recent, records, nowMs]);

  // One notification per spike (and at most one per 3 hours). Only when the person turned alerts on and the browser
  // allows them, so a switched-off feature never uses up the budget.
  useEffect(() => {
    if (!loaded || !spike || !enabled || alertPermission() !== 'granted') return;
    const r = evaluateMissedMeal(stateRef.current, spike, Date.now());
    if (!r.notify) return;
    stateRef.current = r.state;
    setState(r.state);
    void AsyncStorage.setItem(KEY, serializeMissedMeal(r.state)).catch(() => undefined);
    void showAlert({
      kind: 'meal',
      type: 'missed_meal',
      title: 'Glucose rose quickly',
      body: `${spikeSummary(spike)} If you ate or took insulin, log your meal and insulin.`,
      tag: 'sugarsense-missed-meal',
    });
  }, [loaded, spike, enabled]);

  const dismiss = useCallback(() => {
    const next = dismissMissedMeal(stateRef.current, Date.now());
    stateRef.current = next;
    setState(next);
    void AsyncStorage.setItem(KEY, serializeMissedMeal(next)).catch(() => undefined);
  }, []);

  const shown = spike && !isDismissed(state, nowMs) ? spike : null;
  const value = useMemo<Value>(() => ({ spike: shown, summary: shown ? spikeSummary(shown) : null, dismiss }), [shown, dismiss]);
  return <MissedMealContext.Provider value={value}>{children}</MissedMealContext.Provider>;
}

export function useMissedMeal(): Value {
  const ctx = useContext(MissedMealContext);
  if (!ctx) throw new Error('useMissedMeal must be used inside <MissedMealProvider>');
  return ctx;
}
