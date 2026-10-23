import { useEffect, useRef } from 'react';
import { useForecast } from './ForecastProvider';
import { showToast } from './toast';
import { loadToastPref } from './toastPrefs';
import { forecastToast, shouldToastForecast } from './toastText';

/**
 * Mount once inside the providers. Loads the saved on/off choice and toasts "Forecast updated" when a forecast built
 * on a NEW glucose reading arrives (not on the first load, not for the same reading again, not for one kept over
 * from earlier). Saves and alerts toast from where they happen.
 */
export function ToastSync() {
  const { view } = useForecast();
  const lastAnchor = useRef<string | null>(null);
  const seenFirst = useRef(false);

  useEffect(() => {
    loadToastPref();
  }, []);

  const fc = view.kind === 'ok' && view.asOf === null ? view.data : null;
  useEffect(() => {
    if (!fc) return;
    if (!seenFirst.current) {
      seenFirst.current = true;
      lastAnchor.current = fc.anchor.measuredAt;
      return;
    }
    if (shouldToastForecast(lastAnchor.current, fc)) showToast(forecastToast(fc));
    lastAnchor.current = fc.anchor.measuredAt;
  }, [fc]);

  return null;
}
