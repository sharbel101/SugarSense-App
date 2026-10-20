import { MORNING_RESISTANCE } from '../engine/params.js';
import { localDayKey } from './time.js';

/**
 * The person's FIRST rapid-acting dose of each local day (a day starts at 03:00 local, so a late-night snack dose still belongs to the
 * previous day and the dose taken on waking is the first of the new one). There is no clock time to set: the first dose after the day
 * starts is the one that counts, whenever the person wakes. The caller passes only doses that count (rapid-acting, delivered, not
 * cancelled); ties on the same second go to the smallest id so the result is deterministic.
 */
export function firstDoseIdsOfLocalDays(doses: readonly { id: string; tSec: number }[], timeZone: string, dayStartHour: number = MORNING_RESISTANCE.dayStartHour): Set<string> {
  const best = new Map<string, { id: string; tSec: number }>();
  for (const d of doses) {
    const key = localDayKey(d.tSec, timeZone, dayStartHour);
    const cur = best.get(key);
    if (!cur || d.tSec < cur.tSec || (d.tSec === cur.tSec && d.id < cur.id)) best.set(key, d);
  }
  return new Set([...best.values()].map((d) => d.id));
}
