import { LINK_WINDOW } from './params.js';
import type { InsulinConfirmation, MealLink } from './types.js';

/**
 * Meal <-> insulin association and the carbohydrate-coverage comparison.
 *
 * This is analysis for forecasting and history only. It never produces, suggests or adjusts a dose:
 * it reports what the recorded insulin would cover under the stored ICR, nothing more.
 *
 * Rules that protect against wrong conclusions:
 *  - No insulin recorded is NOT "no insulin taken". Only an explicit confirmed zero-unit event says that.
 *  - A planned dose is not a delivered dose and is never linked.
 *  - Basal and other non-bolus events are never used as a meal bolus.
 *  - If a dose could belong to more than one meal (or a meal to more than one dose) nothing is linked.
 */

export interface LinkableMeal {
  id: string;
  tSec: number;
}

export interface LinkableInsulin {
  id: string;
  tSec: number;
  /** Delivered units; null = unknown. */
  unitsAdministered: number | null;
  kind: 'bolus' | 'correction' | 'basal' | 'other';
  confirmation: InsulinConfirmation;
  declaredMealId: string | null;
  /** false for long-, short- or other non-rapid-acting insulin: it cannot stand in for a rapid meal bolus. */
  rapidActing?: boolean;
}

const inWindow = (mealSec: number, doseSec: number): boolean => {
  const deltaMin = (doseSec - mealSec) / 60;
  return deltaMin >= -LINK_WINDOW.beforeMin && deltaMin <= LINK_WINDOW.afterMin;
};

const isDeliveredPositive = (e: LinkableInsulin): boolean =>
  e.confirmation !== 'planned' && e.rapidActing !== false && e.unitsAdministered !== null && e.unitsAdministered > 0;

const isConfirmedZero = (e: LinkableInsulin): boolean =>
  e.confirmation === 'confirmed' && e.unitsAdministered === 0;

export function linkMealsToInsulin(
  meals: readonly LinkableMeal[],
  insulin: readonly LinkableInsulin[],
): MealLink[] {
  const mealIds = new Set(meals.map((m) => m.id));
  // Only rapid-acting bolus doses can be a meal bolus; basal/other and correction doses link only by declaration.
  const bolusDoses = insulin.filter((e) => e.kind === 'bolus' && isDeliveredPositive(e));
  const declaredDoses = insulin.filter(
    (e) => isDeliveredPositive(e) && e.declaredMealId !== null && mealIds.has(e.declaredMealId),
  );
  const zeroEvents = insulin.filter(isConfirmedZero);

  return meals.map((meal): MealLink => {
    const declared = declaredDoses.filter((d) => d.declaredMealId === meal.id);
    if (declared.length > 0) {
      return {
        mealId: meal.id,
        status: 'linked_declared',
        insulinIds: declared.map((d) => d.id),
        unitsTotal: sum(declared.map((d) => d.unitsAdministered as number)),
      };
    }

    const zeroHere = zeroEvents.filter(
      (z) => z.declaredMealId === meal.id || (z.declaredMealId === null && inWindow(meal.tSec, z.tSec)),
    );
    // Doses not claimed by another meal and inside this meal's window.
    const candidates = bolusDoses.filter(
      (d) => d.declaredMealId === null && inWindow(meal.tSec, d.tSec),
    );

    if (candidates.length === 0) {
      if (zeroHere.length > 0) {
        return { mealId: meal.id, status: 'confirmed_none', insulinIds: zeroHere.map((z) => z.id), unitsTotal: 0 };
      }
      return { mealId: meal.id, status: 'none_recorded', insulinIds: [], unitsTotal: null };
    }

    // A dose that also sits in another meal's window cannot be assigned to either; a confirmed zero in the
    // same window contradicts a positive dose. Both stay unlinked.
    const contested = candidates.some((d) =>
      meals.some((other) => other.id !== meal.id && inWindow(other.tSec, d.tSec)),
    );
    if (contested || zeroHere.length > 0) {
      return { mealId: meal.id, status: 'ambiguous', insulinIds: [], unitsTotal: null };
    }
    return {
      mealId: meal.id,
      status: 'linked_auto',
      insulinIds: candidates.map((d) => d.id),
      unitsTotal: sum(candidates.map((d) => d.unitsAdministered as number)),
    };
  });
}

export interface CarbCoverage {
  /** units x ICR: grams the recorded insulin corresponds to under the stored ratio. */
  coverageG: number;
  /** recorded carbohydrate minus coverage; positive = more carbohydrate than the insulin corresponds to. */
  carbsMinusCoverageG: number;
}

/** Null whenever any input is unknown - never a number built from a guess. */
export function carbCoverage(
  carbsG: number | null,
  unitsAdministered: number | null,
  icrGPerU: number | null,
): CarbCoverage | null {
  if (carbsG === null || unitsAdministered === null || icrGPerU === null) return null;
  if (!(icrGPerU > 0) || unitsAdministered < 0 || carbsG < 0) return null;
  const coverageG = unitsAdministered * icrGPerU;
  return { coverageG, carbsMinusCoverageG: carbsG - coverageG };
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}
