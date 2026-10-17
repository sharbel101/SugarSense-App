import { useEffect, useState } from 'react';
import { apiContext } from '../api/apiContext';
import { getTherapySettings } from '../api/therapyApi';
import type { SavedTherapy } from './doseEstimate';

export type SavedTherapyState =
  | { loading: true }
  | { loading: false; therapy: SavedTherapy; insulinType: 'rapid' | 'ultra_rapid' | null };

/**
 * Reads what the person SAVED in Insulin settings (`GET /therapy/settings`): the ratio, the
 * correction factor and the insulin type. Read-only: never writes, pre-fills or adjusts a setting.
 * `therapy: null` = could not be read.
 */
export function useSavedTherapy(): SavedTherapyState {
  const [state, setState] = useState<SavedTherapyState>({ loading: true });
  useEffect(() => {
    let alive = true;
    void getTherapySettings(apiContext).then((r) => {
      if (!alive) return;
      setState(
        r.kind === 'ok'
          ? {
              loading: false,
              insulinType: r.value.insulinType,
              therapy: {
                status: r.value.status,
                icrSegments: r.value.icrSegments.map((s) => ({ startMinute: s.startMinute, gramsPerUnit: s.gramsPerUnit })),
                isfSegments: r.value.isfSegments.map((s) => ({ startMinute: s.startMinute, mgdlPerUnit: s.mgdlPerUnit })),
              },
            }
          : { loading: false, therapy: null, insulinType: null },
      );
    });
    return () => {
      alive = false;
    };
  }, []);
  return state;
}
