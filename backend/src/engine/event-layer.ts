import { profileCumulative } from './absorption.js';
import { insulinCumulativeAction, insulinRemainingFraction, mealCumulativeAbsorption } from './kernels.js';
import { FAT_PROTEIN, TIME_CLASS_RATIO, TREND_SLOPE_WINDOW_MIN, UNCERTAIN_INSULIN_TIMING_MIN, trendResponseAt } from './params.js';
import type {
  EngineParams,
  EventDisposition,
  EventLayerResult,
  InsulinInput,
  MealInput,
  MealLink,
  StepSeries,
} from './types.js';

/**
 * The meal-aware physiological layer. A pure function of (anchor time, events, therapy values,
 * parameters): same input, same output, nothing random.
 *
 * What it computes: for every 5-minute step h after the anchor, the glucose-effect INCREMENT that the
 * recorded events still have to produce - meal effect CSF*C*[F(age+h)-F(age)] and insulin effect
 * ISF*U*[A(age+h)-A(age)], with CSF = ISF/ICR (spec section 3: anchored simulator
 * y(t0) + m(t0+h) - m(t0)). The part of an event's effect that has already happened is, by
 * construction, in the CGM history and is NOT added again.
 *
 * How the ICR enters: only through CSF = ISF/ICR for the carbohydrate effect (spec double-counting
 * rule 1: one scalar, the kernel integrates to 1). The insulin effect uses ISF x units and never the ICR,
 * so a meal covered exactly by its bolus (units = carbs / ICR) nets to zero at full action while the
 * different shapes of F and A still produce the transient hump. There is no fixed "ICR penalty".
 *
 * What it deliberately does NOT do (safety): it never assumes an unrecorded dose, never treats a meal
 * with unknown insulin as uncovered in the MEAN (it widens the band instead), never lets a basal or
 * planned dose act, and never produces a dose.
 */

export interface LayerInput {
  anchorSec: number;
  horizonMin: number;
  stepMin: number;
  meals: readonly MealInput[];
  insulin: readonly InsulinInput[];
  links: readonly MealLink[];
  params: EngineParams;
  excludeMealIds: ReadonlySet<string>;
  /** Whether the insulin history behind the window is known; decides IOB: logged / zero / unknown. */
  insulinHistory: 'logged' | 'confirmed_none' | 'none_recorded';
  /**
   * What-if view only: count EVERY logged dose and meal in full, including doses without a recorded meal and meals
   * without an insulin record (which the normal line only uses to stretch the range). Never saved, never learned from.
   */
  applyAll?: boolean;
  /** Preview only: count exactly these entries (a meal still being confirmed, an insulin amount being tried) in full. */
  forceApplyIds?: ReadonlySet<string>;
}

const zeros = (n: number): number[] => Array.from({ length: n }, () => 0);

export function computeEventLayer(input: LayerInput): EventLayerResult {
  const { anchorSec, horizonMin, stepMin, params } = input;
  const n = Math.floor(horizonMin / stepMin);
  const minutes = Array.from({ length: n }, (_, j) => (j + 1) * stepMin);

  const mealEffect = zeros(n);
  const insulinEffect = zeros(n);
  const scenarioUp = zeros(n);
  const scenarioDown = zeros(n);
  const varCarb = zeros(n);
  const varIns = zeros(n);
  const varTiming = zeros(n);
  const varFp = zeros(n);
  const dispositions: EventDisposition[] = [];
  // Event-driven glucose slope over the last TREND_SLOPE_WINDOW_MIN minutes, from APPLIED events only (mg/dL/min,
  // unscaled). The glucose-only model already extrapolates part of it, so it is taken back out below.
  let slopeMeal = 0;
  let slopeInsulin = 0;

  const linkByMeal = new Map(input.links.map((l) => [l.mealId, l]));
  const mealByInsulin = new Map<string, string>();
  for (const l of input.links) {
    if (l.status === 'linked_declared' || l.status === 'linked_auto') {
      for (const id of l.insulinIds) mealByInsulin.set(id, l.mealId);
    }
  }
  const mealById = new Map(input.meals.map((m) => [m.id, m]));
  const usableMeal = (m: MealInput): boolean => m.carbsG !== null && m.icrGPerU !== null && m.isfMgdlPerU !== null;

  // ---- meals ------------------------------------------------------------------------------------
  let appliedMeals = 0;
  for (const meal of input.meals) {
    if (input.excludeMealIds.has(meal.id)) {
      dispositions.push({ eventType: 'meal', id: meal.id, role: 'excluded', reason: 'excluded_by_request' });
      continue;
    }
    if (!usableMeal(meal)) {
      const reason = meal.carbsG === null ? 'carbs_unknown' : 'therapy_settings_missing';
      dispositions.push({ eventType: 'meal', id: meal.id, role: 'ignored', reason });
      continue;
    }
    const link = linkByMeal.get(meal.id);
    const status = link?.status ?? 'none_recorded';
    // An AMBIGUOUS meal (a dose that could belong to it or to another meal, or contradicting records) still has insulin recorded
    // around it, so it is counted: the forecast adds the effects of what was logged, and which meal a dose belongs to does not
    // change that sum. Only a meal with NO insulin record at all stays out of the central line (the insulin may just not be logged yet).
    const knownCoverage =
      input.applyAll === true || input.forceApplyIds?.has(meal.id) === true || status === 'linked_declared' || status === 'linked_auto' || status === 'confirmed_none' || status === 'ambiguous';

    const csf = (meal.isfMgdlPerU as number) / (meal.icrGPerU as number);
    const incAt = (ageMin: number, j: number): number => mealIncrement(meal, csf, ageMin, minutes[j] as number, params);
    const age0 = (anchorSec - meal.tSec) / 60;

    for (let j = 0; j < n; j += 1) {
      const inc = incAt(age0, j);
      if (knownCoverage) {
        mealEffect[j] = (mealEffect[j] as number) + inc;
        const dF = mealF(meal, age0 + (minutes[j] as number), params) - mealF(meal, age0, params);
        const sc = (meal.carbsSigmaG ?? 0) * csf * dF;
        varCarb[j] = (varCarb[j] as number) + (params.mCsf * sc) ** 2;
        // An absorption profile that moved away from the default on evidence of limited quality: the shift is only partly trusted, so
        // a share of the difference to the default profile is added to the timing uncertainty (the band widens, the line does not move).
        if (meal.absorption && meal.absorption.uncertaintyWeight > 0) {
          const dDefault = mealCumulativeAbsorption(age0 + (minutes[j] as number), params.tauMMin) - mealCumulativeAbsorption(age0, params.tauMMin);
          const shift = meal.absorption.uncertaintyWeight * Math.abs(dF - dDefault) * csf * (meal.carbsG as number);
          varTiming[j] = (varTiming[j] as number) + (params.mCsf * shift) ** 2;
        }
        if (meal.timingUncertaintyMin > 0) {
          const spread = Math.abs(incAt(age0 + meal.timingUncertaintyMin, j) - incAt(age0 - meal.timingUncertaintyMin, j)) / 2;
          varTiming[j] = (varTiming[j] as number) + (params.mCsf * spread) ** 2;
        }
        const extraG = meal.absorption?.extraEquivalentG ?? 0;
        if (meal.absorption && extraG > 0) {
          // The extra amplitude is itself an estimate: treat it as uncertain by half of its size.
          const { delayMin, tauSlowMin } = meal.absorption;
          const dX = mealCumulativeAbsorption(age0 + (minutes[j] as number) - delayMin, tauSlowMin) - mealCumulativeAbsorption(age0 - delayMin, tauSlowMin);
          varFp[j] = (varFp[j] as number) + (0.5 * csf * extraG * dX) ** 2;
        }
        const fpMax = FAT_PROTEIN.alphaPMax * (meal.proteinG ?? 0) + FAT_PROTEIN.alphaFMax * (meal.fatG ?? 0);
        if (fpMax > 0 && !(meal.absorption && extraG > 0)) {
          const dF = delayedIncrement(age0, minutes[j] as number);
          varFp[j] = (varFp[j] as number) + (FAT_PROTEIN.amplitudeSdFactor * csf * fpMax * dF) ** 2;
        }
      } else {
        // No insulin record at all around this meal: the mean is NOT moved (it may simply not be logged yet). The
        // uncovered-carbohydrate path is the upper end of the plausible range, so the band is stretched to reach it.
        scenarioUp[j] = (scenarioUp[j] as number) + params.mCsf * inc;
      }
    }
    if (knownCoverage) {
      {
        slopeMeal += (csf * (meal.carbsG as number) * (mealF(meal, age0, params) - mealF(meal, age0 - TREND_SLOPE_WINDOW_MIN, params))) / TREND_SLOPE_WINDOW_MIN;
      }
      appliedMeals += 1;
      dispositions.push({ eventType: 'meal', id: meal.id, role: 'applied', reason: status === 'ambiguous' ? 'insulin_link_ambiguous' : `insulin_${status}` });
    } else {
      dispositions.push({
        eventType: 'meal',
        id: meal.id,
        role: 'scenario_only',
        reason: 'insulin_not_recorded',
      });
    }
  }

  // ---- insulin ----------------------------------------------------------------------------------
  let appliedInsulin = 0;
  for (const dose of input.insulin) {
    if (dose.isfMgdlPerU === null) {
      dispositions.push({ eventType: 'insulin', id: dose.id, role: 'ignored', reason: 'isf_missing' });
      continue;
    }
    const linkedMealId = mealByInsulin.get(dose.id) ?? dose.declaredMealId;
    let role: 'applied' | 'scenario_only';
    let reason: string;
    if (linkedMealId !== null && linkedMealId !== undefined && mealById.has(linkedMealId)) {
      const meal = mealById.get(linkedMealId) as MealInput;
      if (input.excludeMealIds.has(meal.id)) {
        role = 'applied';
        reason = 'meal_excluded_but_insulin_delivered';
      } else if (usableMeal(meal)) {
        role = 'applied';
        reason = 'linked_to_meal';
      } else {
        role = 'scenario_only';
        reason = 'linked_meal_not_usable';
      }
    } else if (dose.kind === 'correction') {
      role = 'applied';
      reason = 'correction_dose';
    } else {
      // A delivered dose with no meal recorded (a correction logged "with a meal", a snack bolus, a dose whose meal is not logged yet)
      // lowers glucose like any other dose, so it is counted in the central line. If it covered food that was never logged the glucose
      // will end higher; the range always reaches up to the glucose-only line for that case. Not a training example (see isLearningEligible).
      role = 'applied';
      reason = 'dose_without_recorded_meal';
    }

    if ((input.applyAll === true || input.forceApplyIds?.has(dose.id) === true) && role === 'scenario_only') {
      role = 'applied';
      reason = 'what_if_counted';
    }

    const tp = dose.ultraRapid ? params.tpUltraMin : params.tpRapidMin;
    const age0 = (anchorSec - dose.tSec) / 60;
    const incAt = (ageMin: number, j: number): number =>
      dose.isfMgdlPerU! * dose.units *
      (insulinCumulativeAction(ageMin + (minutes[j] as number), tp, params.tdMin) -
        insulinCumulativeAction(ageMin, tp, params.tdMin));
    for (let j = 0; j < n; j += 1) {
      const inc = incAt(age0, j);
      if (role === 'applied') {
        insulinEffect[j] = (insulinEffect[j] as number) + inc;
        const rel2 = params.cS ** 2 + (dose.uncertain ? params.uncertainDoseRel ** 2 : 0);
        varIns[j] = (varIns[j] as number) + (params.mIsf * inc) ** 2 * rel2;
        if (dose.uncertain) {
          const spread =
            Math.abs(incAt(age0 + UNCERTAIN_INSULIN_TIMING_MIN, j) - incAt(age0 - UNCERTAIN_INSULIN_TIMING_MIN, j)) / 2;
          varTiming[j] = (varTiming[j] as number) + (params.mIsf * spread) ** 2;
        }
      } else {
        scenarioDown[j] = (scenarioDown[j] as number) + params.mIsf * inc;
      }
    }
    if (role === 'applied') {
      slopeInsulin +=
        (dose.isfMgdlPerU * dose.units * (insulinCumulativeAction(age0, tp, params.tdMin) - insulinCumulativeAction(age0 - TREND_SLOPE_WINDOW_MIN, tp, params.tdMin))) /
        TREND_SLOPE_WINDOW_MIN;
      appliedInsulin += 1;
    }
    dispositions.push({ eventType: 'insulin', id: dose.id, role, reason });
  }

  // ---- state at the anchor ----------------------------------------------------------------------
  // Carbs / insulin still on board, now and at each forecast step (same kernels as the effects above).
  // Both are estimates from LOGGED entries only. null = unknown (nothing recorded), never a stand-in zero.
  const loggedMeals = input.meals.filter((m) => !input.excludeMealIds.has(m.id) && m.carbsG !== null);
  const cobAt = (offsetMin: number): number | null =>
    loggedMeals.length === 0
      ? null
      : loggedMeals.reduce((acc, m) => {
          const age = (anchorSec - m.tSec) / 60 + offsetMin;
          return acc + (m.carbsG as number) * (1 - mealF(m, age, params));
        }, 0);
  const iobAt = (offsetMin: number): number | null => {
    if (input.insulinHistory === 'none_recorded') return null;
    if (input.insulinHistory === 'confirmed_none') return 0;
    return input.insulin.reduce((acc, d) => {
      const tp = d.ultraRapid ? params.tpUltraMin : params.tpRapidMin;
      return acc + d.units * insulinRemainingFraction((anchorSec - d.tSec) / 60 + offsetMin, tp, params.tdMin);
    }, 0);
  };
  const cobG = cobAt(0);
  const iobU = iobAt(0);

  if (params.trendOverlap) {
    for (let j = 0; j < n; j += 1) {
      const k = trendResponseAt(Math.min(minutes[j] as number, 120));
      mealEffect[j] = (mealEffect[j] as number) - k * slopeMeal;
      insulinEffect[j] = (insulinEffect[j] as number) - k * slopeInsulin;
    }
  }

  const series: StepSeries = {
    minutes,
    mealEffect,
    insulinEffect,
    mealApplied: mealEffect.map((v) => params.mCsf * v),
    insulinApplied: insulinEffect.map((v) => params.mIsf * v),
    sigmaCarb: varCarb.map(Math.sqrt),
    sigmaInsulin: varIns.map(Math.sqrt),
    sigmaTiming: varTiming.map(Math.sqrt),
    sigmaFatProtein: varFp.map(Math.sqrt),
    scenarioUp,
    scenarioDown,
    iobUnits: minutes.map((m) => iobAt(m)),
    cobGrams: minutes.map((m) => cobAt(m)),
  };

  const featureConfig =
    appliedMeals > 0 && appliedInsulin > 0
      ? 'meal+insulin'
      : appliedMeals > 0
        ? 'meal_only'
        : appliedInsulin > 0
          ? 'insulin_only'
          : 'glucose_only';

  return { series, dispositions, cobG, iobU, appliedMeals, appliedInsulin, featureConfig };
}

/**
 * Cumulative fraction of a meal's carbohydrate absorbed s minutes after eating. With a resolved absorption profile it is the
 * early/delayed mixture; without one it is exactly the previous single gamma(2) kernel (tau = tauM x speed-class ratio).
 */
function mealF(meal: MealInput, sMin: number, params: EngineParams): number {
  return meal.absorption ? profileCumulative(sMin, meal.absorption) : mealCumulativeAbsorption(sMin, params.tauMMin * TIME_CLASS_RATIO[meal.timeClass]);
}

/** Glucose increment (mg/dL, unscaled) of one meal over [age, age + h]. */
function mealIncrement(meal: MealInput, csf: number, ageMin: number, hMin: number, params: EngineParams): number {
  const main = csf * (meal.carbsG as number) * (mealF(meal, ageMin + hMin, params) - mealF(meal, ageMin, params));
  const profileExtra = meal.absorption?.extraEquivalentG ?? 0;
  if (meal.absorption && profileExtra > 0) {
    // Extra late glucose from fat/protein (carbohydrate-equivalent grams), timed like the delayed component of the profile.
    const { delayMin, tauSlowMin } = meal.absorption;
    return main + csf * profileExtra * (mealCumulativeAbsorption(ageMin + hMin - delayMin, tauSlowMin) - mealCumulativeAbsorption(ageMin - delayMin, tauSlowMin));
  }
  const eq = params.alphaP * (meal.proteinG ?? 0) + params.alphaF * (meal.fatG ?? 0);
  // The project spec's optional extra delayed amplitude (alphaP / alphaF, default 0) and the mass-conserving delayed fraction of an
  // absorption profile describe the same physiology; never apply both to one meal.
  if (eq <= 0 || (meal.absorption && meal.absorption.phi > 0)) return main;
  return main + csf * eq * delayedIncrement(ageMin, hMin);
}

/** Increment of the delayed fat/protein appearance kernel over [age, age + h] (fraction of its total). */
function delayedIncrement(ageMin: number, hMin: number): number {
  const { delayMin, tauMin } = FAT_PROTEIN;
  return (
    mealCumulativeAbsorption(ageMin + hMin - delayMin, tauMin) - mealCumulativeAbsorption(ageMin - delayMin, tauMin)
  );
}
