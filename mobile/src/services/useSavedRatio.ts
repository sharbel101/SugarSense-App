import { useEffect, useState } from 'react';
import { apiContext } from '../api/apiContext';
import { getTherapySettings } from '../api/therapyApi';
import type { SavedRatio } from './mealInsulinEstimate';

export type SavedRatioState = { loading: true } | { loading: false; ratio: SavedRatio };

/**
 * Reads the ratio the person SAVED in Insulin settings (`GET /therapy/settings`). Read-only: this
 * never writes, pre-fills or adjusts a setting. `ratio: null` = could not be read.
 */
export function useSavedRatio(): SavedRatioState {
  const [state, setState] = useState<SavedRatioState>({ loading: true });
  useEffect(() => {
    let alive = true;
    void getTherapySettings(apiContext).then((r) => {
      if (!alive) return;
      setState({
        loading: false,
        ratio:
          r.kind === 'ok'
            ? { status: r.value.status, icrSegments: r.value.icrSegments.map((s) => ({ startMinute: s.startMinute, gramsPerUnit: s.gramsPerUnit })) }
            : null,
      });
    });
    return () => {
      alive = false;
    };
  }, []);
  return state;
}
