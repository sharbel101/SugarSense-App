import type { InsulinView, MealView } from '../api/eventsApi';
import type { EventRecord } from './eventQueue.ts';

/**
 * "Cancel meal and dose": removes a confirmed meal and the insulin recorded for it from SugarSense, in
 * the order the server needs: the DOSE first, then the MEAL, so a dose never acts alone for a moment
 * (a dose whose meal was removed is read as a lone dose and would lower the line). Entries still only
 * on this device are dropped from the send queue instead. It only removes entries from SugarSense; it
 * never un-takes insulin in real life. Pure: the server calls are injected so plain-Node tests can run it.
 */

export type CancelDeps = {
  /** The device's send queue. */
  records: EventRecord[];
  recentMeals: MealView[];
  recentInsulin: InsulinView[];
  editMeal: (serverId: string, patch: { status: 'cancelled'; expectedRevision?: number }) => Promise<{ result: string }>;
  editInsulin: (serverId: string, patch: { status: 'cancelled'; expectedRevision?: number }) => Promise<{ result: string }>;
  /** Drops a queued entry that the server never received. */
  discard: (localId: string) => void;
};

export type CancelResult =
  | { kind: 'done' }
  /** The entry changed on the server: reload and ask again. */
  | { kind: 'conflict' }
  | { kind: 'failed'; step: 'dose' | 'meal' };

const ok = (result: string) => result === 'updated' || result === 'unchanged';

/** `mealKey` is the meal's server id, or its local id while the server does not have it yet. */
export async function cancelMealAndDose(mealKey: string, deps: CancelDeps): Promise<CancelResult> {
  const mealRecord = deps.records.find((r) => r.event.kind === 'meal' && (r.event.id === mealKey || r.serverId === mealKey)) ?? null;
  const serverMealId = mealRecord ? mealRecord.serverId : mealKey;
  const meal = serverMealId ? deps.recentMeals.find((m) => m.id === serverMealId) ?? null : null;
  const mealIds = new Set<string>([mealKey]);
  if (mealRecord) mealIds.add(mealRecord.event.id);
  if (mealRecord?.serverId) mealIds.add(mealRecord.serverId);

  // ---- the dose(s) recorded for this meal
  const handled = new Set<string>();
  const doseRecords = deps.records.filter((r) => r.event.kind === 'insulin' && r.event.mealId !== null && mealIds.has(r.event.mealId) && r.status !== 'failed');
  for (const r of doseRecords) {
    if (r.serverId) {
      handled.add(r.serverId);
      const view = deps.recentInsulin.find((i) => i.id === r.serverId);
      if (view?.status === 'cancelled') continue;
      const out = await deps.editInsulin(r.serverId, { status: 'cancelled', ...(view ? { expectedRevision: view.revision } : null) });
      if (out.result === 'conflict') return { kind: 'conflict' };
      if (!ok(out.result)) return { kind: 'failed', step: 'dose' };
    } else {
      deps.discard(r.event.id);
    }
  }
  // Doses the server knows about that were recorded from somewhere else (not in this device's queue).
  for (const d of deps.recentInsulin) {
    if (d.status === 'cancelled' || handled.has(d.id) || d.mealId === null || !mealIds.has(d.mealId)) continue;
    const out = await deps.editInsulin(d.id, { status: 'cancelled', expectedRevision: d.revision });
    if (out.result === 'conflict') return { kind: 'conflict' };
    if (!ok(out.result)) return { kind: 'failed', step: 'dose' };
  }

  // ---- then the meal
  if (serverMealId) {
    const out = await deps.editMeal(serverMealId, { status: 'cancelled', ...(meal ? { expectedRevision: meal.revision } : null) });
    if (out.result === 'conflict') return { kind: 'conflict' };
    if (!ok(out.result)) return { kind: 'failed', step: 'meal' };
  } else if (mealRecord) {
    deps.discard(mealRecord.event.id);
  }
  return { kind: 'done' };
}
