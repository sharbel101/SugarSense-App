import type { MealView } from '../api/eventsApi.ts';
import type { EventRecord } from './eventQueue.ts';

/**
 * A meal the person can attach insulin to ("For which meal?", "I took none for this meal"), from
 * the server's recent meals plus meals still only on this device. Pure.
 *
 * `key` is what an insulin entry stores in `mealId`: the server id when the server has the meal, the
 * local event id while it does not (the send queue resolves it to the server id once the meal is
 * saved - see `resolveMealLink`).
 */
export type MealRef = {
  key: string;
  label: string;
  occurredAtUtc: string;
  utcOffsetMin: number;
  carbsG: number | null;
  /** Not confirmed by the server yet. */
  pending: boolean;
};

function describe(carbs: number | null): string {
  return carbs === null ? 'Meal (carbs unknown)' : `Meal, ${Math.round(carbs)} g carbs`;
}

export function mealChoices(records: EventRecord[], recentMeals: MealView[], nowMs: number, hours = 6, deviceOffsetMin = 0): MealRef[] {
  const from = nowMs - hours * 3_600_000;
  const out: MealRef[] = [];
  const serverIdsSeen = new Set<string>();

  for (const m of recentMeals) {
    if (m.status === 'cancelled') continue;
    const t = Date.parse(m.eatenAt);
    if (!Number.isFinite(t) || t < from) continue;
    serverIdsSeen.add(m.id);
    out.push({ key: m.id, label: describe(m.carbs.grams), occurredAtUtc: m.eatenAt, utcOffsetMin: deviceOffsetMin, carbsG: m.carbs.grams, pending: false });
  }
  for (const r of records) {
    if (r.event.kind !== 'meal' || r.status === 'failed') continue;
    if (r.serverId && serverIdsSeen.has(r.serverId)) continue;
    const t = Date.parse(r.event.occurredAtUtc);
    if (!Number.isFinite(t) || t < from) continue;
    out.push({
      key: r.serverId ?? r.event.id,
      label: describe(r.event.carbsG),
      occurredAtUtc: r.event.occurredAtUtc,
      utcOffsetMin: r.event.utcOffsetMin,
      carbsG: r.event.carbsG,
      pending: r.status !== 'saved' && r.serverId === null,
    });
  }
  return out.sort((a, b) => Date.parse(b.occurredAtUtc) - Date.parse(a.occurredAtUtc));
}

/** Finds one meal by its server id or local id (e.g. the id a forecast prompt points at). */
export function findMealRef(records: EventRecord[], recentMeals: MealView[], key: string, deviceOffsetMin = 0): MealRef | null {
  const rec = records.find((r) => r.event.kind === 'meal' && (r.event.id === key || r.serverId === key));
  if (rec && rec.event.kind === 'meal') {
    return {
      key: rec.serverId ?? rec.event.id,
      label: describe(rec.event.carbsG),
      occurredAtUtc: rec.event.occurredAtUtc,
      utcOffsetMin: rec.event.utcOffsetMin,
      carbsG: rec.event.carbsG,
      pending: rec.serverId === null,
    };
  }
  const view = recentMeals.find((m) => m.id === key);
  if (!view) return null;
  return { key: view.id, label: describe(view.carbs.grams), occurredAtUtc: view.eatenAt, utcOffsetMin: deviceOffsetMin, carbsG: view.carbs.grams, pending: false };
}
