import type { MealView } from '../api/eventsApi.ts';

/**
 * Grouping of the server's saved meals (`GET /events/recent`) by LOCAL calendar day, for Home's
 * "Today's meals" and the meal-history screen. Pure. Cancelled (removed) meals never appear; meals
 * with unknown carbs are listed but never counted as 0 g.
 */

export type DayGroup = {
  key: string;
  label: string;
  meals: MealView[];
  /** Sum of the meals whose carbs are known; null when none are. */
  totalCarbsG: number | null;
  /** Meals in the day whose carbs are unknown (not included in the total). */
  unknownCount: number;
};

const pad = (n: number) => String(n).padStart(2, '0');

/** Local-date key, "2026-10-17". */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function dayLabel(key: string, now: Date): string {
  const today = dayKey(now);
  if (key === today) return 'Today';
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (key === dayKey(y)) return 'Yesterday';
  const [yy, mm, dd] = key.split('-').map(Number);
  return new Date(yy, mm - 1, dd).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

/** The last `count` local day keys, newest first: today, yesterday, ... */
export function lastDays(now: Date, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    out.push(dayKey(d));
  }
  return out;
}

export function mealTitle(m: MealView): string {
  return m.label ?? 'Meal';
}

export function activeMeals(meals: MealView[]): MealView[] {
  return meals.filter((m) => m.status !== 'cancelled' && Number.isFinite(Date.parse(m.eatenAt)));
}

/** One group per requested day (even when empty), meals newest first. */
export function groupMealsByDay(meals: MealView[], now: Date, days: string[] = lastDays(now, 3)): DayGroup[] {
  const live = activeMeals(meals);
  return days.map((key) => {
    const dayMeals = live
      .filter((m) => dayKey(new Date(m.eatenAt)) === key)
      .sort((a, b) => Date.parse(b.eatenAt) - Date.parse(a.eatenAt));
    const known = dayMeals.filter((m) => m.carbs.grams !== null);
    return {
      key,
      label: dayLabel(key, now),
      meals: dayMeals,
      totalCarbsG: known.length > 0 ? known.reduce((s, m) => s + (m.carbs.grams as number), 0) : null,
      unknownCount: dayMeals.length - known.length,
    };
  });
}

export function carbsText(m: MealView): string {
  return m.carbs.grams === null ? 'carbs unknown' : `${Math.round(m.carbs.grams)} g carbs`;
}

/** Display text for the glucose trend (mg/dL per minute from the server); null = not supplied. */
export function trendDisplay(trendMgdlPerMin: number | null): { arrow: string; text: string } | null {
  if (trendMgdlPerMin === null || !Number.isFinite(trendMgdlPerMin)) return null;
  const perMin = Math.round(trendMgdlPerMin * 10) / 10;
  const sign = perMin > 0 ? '+' : '';
  if (trendMgdlPerMin >= 2) return { arrow: '↑', text: `Rising fast · ${sign}${perMin} mg/dL/min` };
  if (trendMgdlPerMin >= 0.5) return { arrow: '↗', text: `Rising · ${sign}${perMin} mg/dL/min` };
  if (trendMgdlPerMin <= -2) return { arrow: '↓', text: `Falling fast · ${perMin} mg/dL/min` };
  if (trendMgdlPerMin <= -0.5) return { arrow: '↘', text: `Falling · ${perMin} mg/dL/min` };
  return { arrow: '→', text: 'Steady' };
}
