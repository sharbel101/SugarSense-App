import { z } from 'zod';

/**
 * Incoming HTTP request body for POST /meals/analyze.
 *
 * `images` is an array capped at 1 today (task point 10: single-photo only for now), but structured
 * as an array - not a single `image` field - so a second (oblique-angle) photo can be added later by
 * raising `.max(1)` alone, with no breaking change to clients already sending one image. See
 * CLAUDE.md section 9, "Guided two-photo capture" for the not-yet-built second-photo UX this leaves
 * room for.
 *
 * Images travel as base64 JSON rather than multipart/form-data: the mobile app already resizes to
 * 1024px JPEG q80 before upload (CLAUDE.md section 9), so payloads are small, and `@google/genai`'s
 * `createPartFromBase64` consumes base64 directly - no re-encoding step either side of this boundary.
 */

export const SUPPORTED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

// Generous but bounded: well above a resized 1024px JPEG q80 photo, far below the 15mb body-parser
// limit configured in main.ts (base64 inflates size by ~33%).
const MAX_BASE64_IMAGE_CHARS = 12_000_000;

export const analyzeMealImageSchema = z.object({
  base64Data: z
    .string()
    .min(1)
    .max(MAX_BASE64_IMAGE_CHARS)
    .describe('Raw base64 image data, no "data:" URI prefix.'),
  mimeType: z.enum(SUPPORTED_IMAGE_MIME_TYPES),
});

export const analyzeMealRequestSchema = z.object({
  images: z.array(analyzeMealImageSchema).min(1).max(1),
  userNote: z.string().trim().max(500).optional(),
  /** Optional: when eating started (ISO, UTC or with offset). Default: the time of the request. */
  eatenAt: z.iso.datetime({ offset: true }).optional(),
  /** Optional: id the app generated for this photo, so a retry maps to the same meal event. */
  clientId: z
    .string()
    .min(8)
    .max(80)
    .regex(/^[A-Za-z0-9._-]+$/)
    .optional(),
});

export type AnalyzeMealRequest = z.infer<typeof analyzeMealRequestSchema>;
