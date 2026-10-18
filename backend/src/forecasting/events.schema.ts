import { z } from 'zod';

/**
 * Request bodies for the manual event services (future UI: "log carbs", "log insulin", "correct this
 * meal"). Photo-derived meals go through the same service. Rules enforced here and again in the database:
 *  - unknown is not zero: omit a field to say "unknown"; send 0 only for a confirmed zero;
 *  - a planned dose is stored as planned and can never count as delivered insulin;
 *  - no event may be dated in the future (checked by the service against the clock).
 */

const grams = (max: number) => z.number().min(0).max(max);
const oneDecimal = (v: number): boolean => Math.abs(v * 10 - Math.round(v * 10)) < 1e-6;
const twoDecimals = (v: number): boolean => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;
const isoTime = z.iso.datetime({ offset: true });
/** The id the app generated for this entry; resending it never creates a second event. */
const clientId = z
  .string()
  .min(8)
  .max(80)
  .regex(/^[A-Za-z0-9._-]+$/);

export const createMealSchema = z
  .object({
    clientId,
    eatenAt: isoTime,
    /** Omit when the carbohydrate amount is unknown (the meal is then kept but not used for the mean). */
    carbsG: grams(400).refine(oneDecimal, 'at most 1 decimal').optional(),
    fatG: grams(300).optional(),
    proteinG: grams(300).optional(),
    fiberG: grams(200).optional(),
    glycemicIndex: z.number().int().min(0).max(100).optional(),
    absorptionClass: z.enum(['fast', 'medium', 'slow']).optional(),
    timingUncertaintyMin: z.number().int().min(0).max(120).optional(),
    note: z.string().trim().max(500).optional(),
    /** Short name shown in lists, e.g. "Pasta" or "Rice + chicken". */
    label: z.string().trim().min(1).max(80).optional(),
    allowDuplicate: z.boolean().optional(),
  })
  .strict();
export type CreateMealInput = z.infer<typeof createMealSchema>;

export const editMealSchema = z
  .object({
    carbsG: grams(400).refine(oneDecimal, 'at most 1 decimal').optional(),
    fatG: grams(300).optional(),
    proteinG: grams(300).optional(),
    fiberG: grams(200).optional(),
    glycemicIndex: z.number().int().min(0).max(100).optional(),
    absorptionClass: z.enum(['fast', 'medium', 'slow']).optional(),
    eatenAt: isoTime.optional(),
    timingUncertaintyMin: z.number().int().min(0).max(120).optional(),
    status: z.enum(['confirmed', 'cancelled']).optional(),
    note: z.string().trim().max(500).optional(),
    label: z.string().trim().min(1).max(80).optional(),
    expectedRevision: z.number().int().min(1).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).some((k) => k !== 'expectedRevision'), { message: 'nothing to change' });
export type EditMealInput = z.infer<typeof editMealSchema>;

const units = z.number().min(0).max(100).refine(twoDecimals, 'at most 2 decimals');

export const createInsulinSchema = z
  .object({
    clientId,
    administeredAt: isoTime,
    kind: z.enum(['bolus', 'correction', 'basal', 'other']),
    /** 'confirmed' = taken as stated; 'uncertain' = taken, amount or time approximate; 'planned' = not taken yet. */
    confirmation: z.enum(['confirmed', 'uncertain', 'planned']),
    /** Units actually taken. Required for confirmed/uncertain; 0 with 'confirmed' means "confirmed none taken". */
    unitsAdministered: units.optional(),
    /** Units the user intends to take. Required for planned; never treated as delivered. */
    plannedUnits: units.optional(),
    insulinType: z.enum(['rapid', 'ultra_rapid', 'short', 'long', 'other']).optional(),
    source: z.enum(['manual', 'pen', 'pump', 'import']).default('manual'),
    mealId: z.uuid().optional(),
    timingUncertain: z.boolean().optional(),
    allowDuplicate: z.boolean().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.confirmation === 'planned') {
      if (v.plannedUnits === undefined) ctx.addIssue({ code: 'custom', path: ['plannedUnits'], message: 'required for a planned dose' });
      if (v.unitsAdministered !== undefined)
        ctx.addIssue({ code: 'custom', path: ['unitsAdministered'], message: 'a planned dose has not been administered' });
    } else {
      if (v.unitsAdministered === undefined)
        ctx.addIssue({ code: 'custom', path: ['unitsAdministered'], message: 'required unless the dose is planned' });
      if (v.plannedUnits !== undefined)
        ctx.addIssue({ code: 'custom', path: ['plannedUnits'], message: 'only for a planned dose' });
    }
  });
export type CreateInsulinInput = z.infer<typeof createInsulinSchema>;

export const editInsulinSchema = z
  .object({
    unitsAdministered: units.optional(),
    administeredAt: isoTime.optional(),
    confirmation: z.enum(['confirmed', 'uncertain']).optional(),
    mealId: z.uuid().nullable().optional(),
    timingUncertain: z.boolean().optional(),
    /** Withdraw an entry that was a mistake. It stays in the history but stops acting in forecasts. */
    status: z.literal('cancelled').optional(),
    expectedRevision: z.number().int().min(1).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).some((k) => k !== 'expectedRevision'), { message: 'nothing to change' });
export type EditInsulinInput = z.infer<typeof editInsulinSchema>;

export const forecastQuerySchema = z.object({
  horizonMin: z.coerce.number().int().min(5).max(180).optional(),
});

/**
 * "What would this do?" before anything is saved: a meal (a stored draft by id, or typed grams) and/or an insulin amount the
 * person is considering. The preview counts them in full on top of what is already logged and saves nothing.
 */
export const previewSchema = z
  .object({
    mealId: z.uuid().optional(),
    meal: z
      .object({
        carbsG: z.number().min(1).max(400).refine(oneDecimal, 'at most 1 decimal'),
        eatenAt: isoTime.optional(),
        fatG: grams(300).optional(),
        proteinG: grams(300).optional(),
        absorptionClass: z.enum(['fast', 'medium', 'slow']).optional(),
      })
      .strict()
      .optional(),
    /** Units of rapid-acting insulin to try. 0 = none taken. */
    insulinUnits: units.optional(),
    insulinAt: isoTime.optional(),
    horizonMin: z.number().int().min(5).max(180).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.mealId === undefined && v.meal === undefined && v.insulinUnits === undefined) {
      ctx.addIssue({ code: 'custom', message: 'give a meal (mealId or meal) and/or insulinUnits' });
    }
    if (v.mealId !== undefined && v.meal !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['meal'], message: 'use mealId or meal, not both' });
    }
    if (v.insulinAt !== undefined && v.insulinUnits === undefined) {
      ctx.addIssue({ code: 'custom', path: ['insulinAt'], message: 'insulinAt needs insulinUnits' });
    }
  });
export type PreviewInput = z.infer<typeof previewSchema>;

export const counterfactualSchema = z
  .object({
    excludeMealIds: z.array(z.uuid()).min(1).max(20),
    horizonMin: z.number().int().min(5).max(180).optional(),
  })
  .strict();
export type CounterfactualInput = z.infer<typeof counterfactualSchema>;
