import { z } from 'zod';

/**
 * Request body for PUT /therapy/settings. Units are spelled out in the field names so nothing is
 * ambiguous: ICR is grams of carbohydrate covered by ONE unit of rapid-acting insulin; ISF is mg/dL
 * lowered by ONE unit. Ranges mirror the database CHECK constraints (defence in depth).
 *
 * Partial updates carry over what is not sent: an ICR-only request keeps the previous ISF segments and
 * insulin settings. Every accepted request creates a NEW immutable version; nothing is overwritten.
 */

const startMinute = z.number().int().min(0).max(1439);
const twoDecimals = (v: number): boolean => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;

const icrSegment = z.object({
  startMinute,
  gramsPerUnit: z.number().min(1).max(150).refine(twoDecimals, 'at most 2 decimals'),
});
const isfSegment = z.object({
  startMinute,
  mgdlPerUnit: z.number().min(5).max(500).refine(twoDecimals, 'at most 2 decimals'),
});

const strictlyIncreasingFromMidnight = (segments: { startMinute: number }[]): boolean =>
  segments[0]?.startMinute === 0 && segments.every((s, i) => i === 0 || s.startMinute > (segments[i - 1] as { startMinute: number }).startMinute);

export const therapySettingsSchema = z
  .object({
    icrSegments: z.array(icrSegment).min(1).max(8).refine(strictlyIncreasingFromMidnight, {
      message: 'segments must start at minute 0 and have strictly increasing start minutes',
    }),
    isfSegments: z
      .array(isfSegment)
      .min(1)
      .max(8)
      .refine(strictlyIncreasingFromMidnight, {
        message: 'segments must start at minute 0 and have strictly increasing start minutes',
      })
      .optional(),
    insulinType: z.enum(['rapid', 'ultra_rapid']).optional(),
    insulinPeakMin: z.number().min(35).max(120).optional(),
    insulinDurationMin: z.number().min(300).max(480).optional(),
    source: z.enum(['clinician_prescribed', 'user_entered']),
    /** When the setting starts to apply. Default: now. Not more than 24 h in the future. */
    effectiveFrom: z.iso.datetime({ offset: true }).optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict()
  .refine((v) => v.insulinPeakMin === undefined || v.insulinDurationMin === undefined || v.insulinPeakMin < v.insulinDurationMin / 2, {
    message: 'insulinPeakMin must be less than half of insulinDurationMin',
  });

export type TherapySettingsInput = z.infer<typeof therapySettingsSchema>;
