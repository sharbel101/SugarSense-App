import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useSyncExternalStore } from 'react';
import { useForecast } from './ForecastProvider';
import { useGlucose } from './GlucoseProvider';
import {
  deserializeLastKnown,
  EMPTY_LAST_KNOWN,
  mergeGlucose,
  mergeOnBoard,
  serializeLastKnown,
  type LastKnown,
} from './lastKnown';

const KEY = 'sugarsense.lastKnown.v1';

let current: LastKnown = EMPTY_LAST_KNOWN;
const listeners = new Set<() => void>();

function set(next: LastKnown) {
  if (next === current) return;
  current = next;
  void AsyncStorage.setItem(KEY, serializeLastKnown(next)).catch(() => undefined);
  listeners.forEach((l) => l());
}

/** The last good reading and on-board amounts (possibly old: the screen must say so). */
export function useLastKnown(): LastKnown {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
    () => current,
  );
}

/**
 * Mount once inside the providers. Loads what was saved, then remembers every FRESH good reading and forecast
 * (never one kept over from earlier, so an old value is never re-stamped as new).
 */
export function LastKnownSync() {
  const { view } = useGlucose();
  const { view: forecast } = useForecast();

  useEffect(() => {
    let alive = true;
    void AsyncStorage.getItem(KEY)
      .then((raw) => {
        if (!alive) return;
        const saved = deserializeLastKnown(raw);
        // Merge, so anything remembered before the load finished is not lost.
        let merged = current;
        if (saved.glucose) merged = mergeGlucose(merged, saved.glucose);
        if (saved.onBoard) merged = mergeOnBoard(merged, saved.onBoard);
        if (merged !== current) {
          current = merged;
          listeners.forEach((l) => l());
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const okData = view.kind === 'ok' ? view.data : null;
  useEffect(() => {
    if (okData) set(mergeGlucose(current, { mgdl: okData.glucoseMgdl, measuredAt: okData.measuredAt }));
  }, [okData]);

  const fc = forecast.kind === 'ok' && forecast.asOf === null ? forecast.data : null;
  useEffect(() => {
    if (!fc) return;
    const a = fc.mealAware.availability;
    set(mergeOnBoard(current, { insulinUnits: a.insulinOnBoardUnits, insulin: a.insulin, carbsGrams: a.carbsOnBoardGrams, asOf: fc.anchor.measuredAt }));
  }, [fc]);

  return null;
}
