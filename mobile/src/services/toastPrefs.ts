import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';
import { setToastsEnabled } from './toast';

const KEY = 'sugarsense.toasts.v1';
let enabled = true;
const listeners = new Set<() => void>();

function emit() {
  setToastsEnabled(enabled);
  listeners.forEach((l) => l());
}

/** Read the saved choice once at start (default: on). */
export function loadToastPref(): void {
  void AsyncStorage.getItem(KEY)
    .then((raw) => {
      if (raw === '0') {
        enabled = false;
        emit();
      }
    })
    .catch(() => undefined);
}

export function setToastPref(on: boolean): void {
  enabled = on;
  void AsyncStorage.setItem(KEY, on ? '1' : '0').catch(() => undefined);
  emit();
}

/** Whether in-app toasts are on (Profile has the switch). */
export function useToastPref(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => enabled,
    () => enabled,
  );
}
