import { useCallback, useMemo, useState } from 'react';
import { getWearableData } from './wearableData';
import type { WearableData } from './wearableModel';

/**
 * The Wearable screens read their data here. There is no network call: the source is `getWearableData`
 * (demo today, see wearableData.ts). `refresh` re-reads it and moves "now" forward so ages and freshness
 * are recomputed. Screens never fetch device data themselves.
 */
export function useWearable(): { data: WearableData; now: number; refresh: () => void } {
  const [now, setNow] = useState(() => Date.now());
  const data = useMemo(() => getWearableData(now), [now]);
  const refresh = useCallback(() => setNow(Date.now()), []);
  return { data, now, refresh };
}
