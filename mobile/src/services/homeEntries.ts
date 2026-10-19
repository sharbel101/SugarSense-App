import type { InsulinView, MealView } from '../api/eventsApi';
import type { EventRecord } from './eventQueue.ts';
import { INSULIN_KINDS } from './events.ts';

/**
 * The rows Home shows for "recent carbs" and "recent insulin": what the server has, PLUS what was just
 * entered on this device and is still on its way. An entry appears the moment it is entered (marked
 * "Sending..." until the server confirms it, "Not saved" if the server refused it) and is never listed
 * twice once the server has it. Pure.
 */
export type EntryRow = {
  key: string;
  title: string;
  /** "45 g" / "4 U" */
  amount: string;
  timeIso: string;
  state: 'saved' | 'sending' | 'failed';
};

const num = (n: number) => String(Math.round(n * 10) / 10);

function stateOf(r: EventRecord): EntryRow['state'] {
  return r.status === 'saved' ? 'saved' : r.status === 'failed' ? 'failed' : 'sending';
}

export function mealRows(recent: MealView[], records: EventRecord[]): EntryRow[] {
  const serverIds = new Set(recent.map((m) => m.id));
  const rows: EntryRow[] = [];
  for (const m of recent) {
    if (m.status === 'cancelled' || !Number.isFinite(Date.parse(m.eatenAt))) continue;
    rows.push({ key: m.id, title: m.label ?? 'Meal', amount: m.carbs.grams === null ? '? g' : `${num(m.carbs.grams)} g`, timeIso: m.eatenAt, state: 'saved' });
  }
  for (const r of records) {
    if (r.event.kind !== 'meal') continue;
    if (r.serverId && serverIds.has(r.serverId)) continue;
    rows.push({ key: r.event.id, title: r.event.label || 'Meal', amount: `${num(r.event.carbsG)} g`, timeIso: r.event.occurredAtUtc, state: stateOf(r) });
  }
  return rows.sort((a, b) => Date.parse(b.timeIso) - Date.parse(a.timeIso));
}

export function insulinRows(recent: InsulinView[], records: EventRecord[]): EntryRow[] {
  const serverIds = new Set(recent.map((i) => i.id));
  const kindLabel = (k: string) => INSULIN_KINDS.find((x) => x.value === k)?.label ?? 'Insulin';
  const rows: EntryRow[] = [];
  for (const i of recent) {
    if (i.status === 'cancelled' || !Number.isFinite(Date.parse(i.administeredAt))) continue;
    const planned = i.confirmation === 'planned';
    rows.push({
      key: i.id,
      title: planned ? 'Planned, not taken' : kindLabel(i.kind),
      amount: i.unitsTaken === null ? '? U' : i.unitsTaken === 0 ? 'None' : `${num(i.unitsTaken)} U`,
      timeIso: i.administeredAt,
      state: 'saved',
    });
  }
  for (const r of records) {
    if (r.event.kind !== 'insulin') continue;
    if (r.serverId && serverIds.has(r.serverId)) continue;
    const u = r.event.unitsAdministered;
    rows.push({ key: r.event.id, title: kindLabel(r.event.insulinKind), amount: u === 0 ? 'None' : `${num(u)} U`, timeIso: r.event.occurredAtUtc, state: stateOf(r) });
  }
  return rows.sort((a, b) => Date.parse(b.timeIso) - Date.parse(a.timeIso));
}
