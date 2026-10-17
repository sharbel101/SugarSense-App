import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useState } from 'react';
import { TARGET_MAX_MGDL, TARGET_MIN_MGDL } from './doseEstimate';

/**
 * The person's target glucose (mg/dL) for the correction part of the combined dose. It is kept ON
 * THIS DEVICE only (the server has no field for it yet), is never defaulted, and never changes by
 * itself. Every storage call is guarded: without storage the correction is simply left out.
 */
const KEY = 'sugarsense.targetGlucoseMgdl.v1';

/** `null` when empty or not a usable number; the error string is shown under the field. */
export function parseTargetGlucose(text: string): { ok: true; value: number | null } | { ok: false; error: string } {
  const t = text.trim().replace(',', '.');
  if (t === '') return { ok: true, value: null };
  if (!/^\d+(\.\d+)?$/.test(t)) return { ok: false, error: 'Enter a number in mg/dL.' };
  const n = Number(t);
  if (n < TARGET_MIN_MGDL || n > TARGET_MAX_MGDL) return { ok: false, error: `Target glucose must be ${TARGET_MIN_MGDL}-${TARGET_MAX_MGDL} mg/dL.` };
  return { ok: true, value: Math.round(n) };
}

export async function readTargetGlucose(): Promise<number | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= TARGET_MIN_MGDL && n <= TARGET_MAX_MGDL ? n : null;
  } catch {
    return null;
  }
}

export async function writeTargetGlucose(value: number | null): Promise<void> {
  try {
    if (value === null) await AsyncStorage.removeItem(KEY);
    else await AsyncStorage.setItem(KEY, String(value));
  } catch {
    // Storage unavailable: the correction is left out next time rather than guessed.
  }
}

export function useTargetGlucose(): { loading: boolean; target: number | null; save: (v: number | null) => Promise<void> } {
  const [state, setState] = useState<{ loading: boolean; target: number | null }>({ loading: true, target: null });
  useEffect(() => {
    let alive = true;
    void readTargetGlucose().then((target) => {
      if (alive) setState({ loading: false, target });
    });
    return () => {
      alive = false;
    };
  }, []);
  const save = useCallback(async (v: number | null) => {
    await writeTargetGlucose(v);
    setState({ loading: false, target: v });
  }, []);
  return { ...state, save };
}
