import type { MealAnalysisResult } from '../schema/meal-analysis.schema.js';

/**
 * Gate 2 (PDF Sec 5 / HANDOFF-BACKEND-AI.md section 5): semantic sanity, run only after Gate 1
 * (`gate1-structural.ts`) has already confirmed the shape is correct. A pure function of an already
 * structurally-valid `MealAnalysisResult` - no I/O, replayable in tests with fixed inputs.
 *
 * The five checks below are exactly the ones specified for this endpoint. Two additional
 * consistency checks are included (marked below) because they follow directly from CLAUDE.md
 * section 2's "never store or show a fabricated number": a `no_food` / `unidentified` result must
 * not smuggle in nutrition numbers, and a `detected` result must not smuggle in zero items.
 */

export type Gate2Result = { ok: true } | { ok: false; reasons: string[] };

const CARBS_SUM_TOLERANCE_FRACTION = 0.05; // 5%
const MAX_TOTAL_CARBS_G = 400;

const PLACEHOLDER_NAME_PATTERN =
  /^(food( item)?|item|unknown( food)?|unidentified( food)?|n\/?a|placeholder|meal|dish|plate|misc(ellaneous)?)$/i;

export function runGate2SemanticSanity(result: MealAnalysisResult): Gate2Result {
  const reasons: string[] = [];

  if (result.foodStatus !== 'detected') {
    // Additional consistency check (see file header): a non-detected result must carry no
    // nutrition numbers and no items, so it can never be mistaken for a real (possibly zero) estimate.
    const hasLeakedNumbers = [
      result.totalNetCarbsG,
      result.totalCarbsRangeLowG,
      result.totalCarbsRangeHighG,
      result.totalCaloriesKcal,
      result.totalFatG,
      result.totalProteinG,
      result.totalFiberG,
      result.estimatedGlycemicIndex,
      result.absorptionClass,
      result.absorptionConfidence,
      result.preparationAndMixtureFactors,
    ].some((value) => value !== null);
    if (hasLeakedNumbers || result.items.length > 0) {
      reasons.push(
        `foodStatus is "${result.foodStatus}" but nutrition fields or items were still populated ` +
          '(they must all be null/empty for a non-detected result).',
      );
    }
    // None of the checks below apply when there is no food to check numbers for.
    return reasons.length > 0 ? { ok: false, reasons } : { ok: true };
  }

  // Additional consistency check (see file header): "detected" must mean at least one item.
  if (result.items.length === 0) {
    reasons.push('foodStatus is "detected" but items is empty.');
  }

  // Additional consistency check: the core numeric fields are required for a real "detected"
  // result - the service layer trusts a passing Gate 2 to mean these are safe to read as non-null
  // when building the success response. (Fat/protein/fibre/GI stay optionally null even when
  // detected - the model may genuinely have no basis for them; see rule 4 in the system prompt.)
  const requiredNumericFields: Array<[string, number | null]> = [
    ['totalNetCarbsG', result.totalNetCarbsG],
    ['totalCarbsRangeLowG', result.totalCarbsRangeLowG],
    ['totalCarbsRangeHighG', result.totalCarbsRangeHighG],
    ['totalCaloriesKcal', result.totalCaloriesKcal],
  ];
  for (const [field, value] of requiredNumericFields) {
    if (value === null) {
      reasons.push(`foodStatus is "detected" but required field ${field} is null.`);
    }
  }

  for (const item of result.items) {
    if (PLACEHOLDER_NAME_PATTERN.test(item.name.trim())) {
      reasons.push(`item name "${item.name}" is an empty/placeholder name.`);
    }
  }

  // 1. Sum of per-item net_carbs_g must be within 5% of total_net_carbs_g.
  if (result.totalNetCarbsG !== null) {
    const itemSum = result.items.reduce((sum, item) => sum + item.netCarbsG, 0);
    const tolerance = Math.max(result.totalNetCarbsG * CARBS_SUM_TOLERANCE_FRACTION, 0.01);
    if (Math.abs(itemSum - result.totalNetCarbsG) > tolerance) {
      reasons.push(
        `sum of item netCarbsG (${itemSum}) is not within 5% of totalNetCarbsG (${result.totalNetCarbsG}).`,
      );
    }
  }

  // 2. total_carbs_range_low_g <= total_net_carbs_g <= total_carbs_range_high_g.
  if (
    result.totalNetCarbsG !== null &&
    result.totalCarbsRangeLowG !== null &&
    result.totalCarbsRangeLowG > result.totalNetCarbsG
  ) {
    reasons.push(
      `totalCarbsRangeLowG (${result.totalCarbsRangeLowG}) is greater than totalNetCarbsG (${result.totalNetCarbsG}).`,
    );
  }
  if (
    result.totalNetCarbsG !== null &&
    result.totalCarbsRangeHighG !== null &&
    result.totalNetCarbsG > result.totalCarbsRangeHighG
  ) {
    reasons.push(
      `totalNetCarbsG (${result.totalNetCarbsG}) is greater than totalCarbsRangeHighG (${result.totalCarbsRangeHighG}).`,
    );
  }

  // 3. total_net_carbs_g must be within 0-400 g. (Also enforced by the Zod schema's .max(400), but
  //    Gate 2 restates it so a violation is logged distinctly as a sanity failure, not a schema one.)
  if (result.totalNetCarbsG !== null && (result.totalNetCarbsG <= 0 || result.totalNetCarbsG > MAX_TOTAL_CARBS_G)) {
    reasons.push(`totalNetCarbsG (${result.totalNetCarbsG}) is outside 0-${MAX_TOTAL_CARBS_G}g.`);
  }

  // 5. estimated_glycemic_index, if present, must be within 0-100.
  // (Also schema-enforced; restated here for the same reason as #3.)
  if (
    result.estimatedGlycemicIndex !== null &&
    (result.estimatedGlycemicIndex < 0 || result.estimatedGlycemicIndex > 100)
  ) {
    reasons.push(`estimatedGlycemicIndex (${result.estimatedGlycemicIndex}) is outside 0-100.`);
  }

  return reasons.length > 0 ? { ok: false, reasons } : { ok: true };
}
