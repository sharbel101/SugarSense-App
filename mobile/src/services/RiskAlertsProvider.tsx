import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useForecast } from './ForecastProvider';
import {
  deserializeAlertState,
  evaluateRisks,
  INITIAL_ALERT_STATE,
  serializeAlertState,
  type AlertNotification,
  type AlertState,
} from './riskAlerts';
import { alertPermission, requestAlertPermission, showAlert, type AlertPermission } from './webNotifications';

const STATE_KEY = 'sugarsense.riskAlerts.v1';
const ENABLED_KEY = 'sugarsense.riskAlertsEnabled.v1';

type RiskAlertsValue = {
  permission: AlertPermission;
  /** The person turned alerts on for this device (and the browser allows them). */
  enabled: boolean;
  /** Must be called from a tap: the browser only shows its permission question then. */
  enable: () => Promise<void>;
  disable: () => void;
  sendTest: () => Promise<boolean>;
};

const RiskAlertsContext = createContext<RiskAlertsValue | null>(null);

/**
 * Watches the forecast and raises the predicted-low / predicted-high alerts (riskAlerts.ts has the
 * rules). Only a fresh forecast is evaluated, never a kept-over one or a failure, so a missing
 * forecast can neither raise nor clear an alert. The alert state is kept on the device so reopening
 * the app does not announce the same risk again. Alerts are shown only when the person turned them on
 * and the browser allows them.
 */
export function RiskAlertsProvider({ children }: { children: React.ReactNode }) {
  const { view } = useForecast();
  const stateRef = useRef<AlertState>(INITIAL_ALERT_STATE);
  const [loaded, setLoaded] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [permission, setPermission] = useState<AlertPermission>(() => alertPermission());
  const enabledRef = useRef(false);

  useEffect(() => {
    let alive = true;
    void Promise.all([AsyncStorage.getItem(STATE_KEY), AsyncStorage.getItem(ENABLED_KEY)])
      .then(([rawState, rawEnabled]) => {
        if (!alive) return;
        stateRef.current = deserializeAlertState(rawState);
        enabledRef.current = rawEnabled === '1';
        setEnabled(rawEnabled === '1');
        setLoaded(true);
      })
      .catch(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  // The person can change the browser permission in its settings and come back: read it again on return.
  useEffect(() => {
    const target = globalThis as { addEventListener?: (type: string, fn: () => void) => void; removeEventListener?: (type: string, fn: () => void) => void };
    if (!target.addEventListener || !target.removeEventListener) return;
    const reread = () => setPermission(alertPermission());
    target.addEventListener('focus', reread);
    target.addEventListener('visibilitychange', reread);
    return () => {
      target.removeEventListener?.('focus', reread);
      target.removeEventListener?.('visibilitychange', reread);
    };
  }, []);

  const deliver = useCallback(async (list: AlertNotification[]) => {
    if (!enabledRef.current || alertPermission() !== 'granted') return;
    for (const n of list) await showAlert(n);
  }, []);

  // A fresh forecast (not one kept from earlier) is the only thing that can raise or clear an alert.
  useEffect(() => {
    if (!loaded || view.kind !== 'ok' || view.asOf !== null) return;
    const result = evaluateRisks(stateRef.current, view.data, Date.now());
    if (result.state === stateRef.current) return;
    stateRef.current = result.state;
    void AsyncStorage.setItem(STATE_KEY, serializeAlertState(result.state)).catch(() => undefined);
    void deliver(result.notifications);
  }, [loaded, view, deliver]);

  const enable = useCallback(async () => {
    const p = await requestAlertPermission();
    setPermission(p);
    const on = p === 'granted';
    enabledRef.current = on;
    setEnabled(on);
    void AsyncStorage.setItem(ENABLED_KEY, on ? '1' : '0').catch(() => undefined);
  }, []);

  const disable = useCallback(() => {
    enabledRef.current = false;
    setEnabled(false);
    void AsyncStorage.setItem(ENABLED_KEY, '0').catch(() => undefined);
  }, []);

  const sendTest = useCallback(
    () =>
      showAlert({
        kind: 'low',
        type: 'predicted',
        title: 'Test alert',
        body: 'This is how a predicted low or high blood sugar alert will look. Nothing is wrong.',
        tag: 'sugarsense-test',
      }),
    [],
  );

  const value = useMemo(() => ({ permission, enabled, enable, disable, sendTest }), [permission, enabled, enable, disable, sendTest]);
  return <RiskAlertsContext.Provider value={value}>{children}</RiskAlertsContext.Provider>;
}

export function useRiskAlerts(): RiskAlertsValue {
  const ctx = useContext(RiskAlertsContext);
  if (!ctx) throw new Error('useRiskAlerts must be used inside RiskAlertsProvider');
  return ctx;
}
