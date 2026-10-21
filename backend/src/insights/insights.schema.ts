import { z } from 'zod';

/** GET /insights?limit=5 : how many of the current insights to return (the engine itself caps a run at 5). */
export const insightsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(10).default(5),
});
export type InsightsQuery = z.infer<typeof insightsQuerySchema>;

/**
 * The rendered text the insight engine stores (backend/insights, render.py). Parsed defensively: a stored row that does not match is
 * skipped rather than shown, and older rows without `evidence_refs` still work.
 */
export const storedContentSchema = z.object({
  headline: z.string().min(1).max(120),
  facts_text: z.array(z.string().max(1200)).min(1).max(10),
  explanation: z.string().max(600).nullable().optional(),
  limitations: z.array(z.string().max(400)).max(12).default([]),
  evidence_refs: z.array(z.string().max(8)).max(12).default([]),
  validation_status: z.enum(['valid', 'fallback', 'not_applicable']).optional(),
});

export const storedEvidenceSchema = z.object({
  facts: z
    .array(z.object({ ref: z.string(), name: z.string(), value: z.union([z.number(), z.string()]), unit: z.string(), kind: z.string() }))
    .max(40)
    .default([]),
  coverage: z.number().min(0).max(1).optional(),
  method: z.string().max(300).optional(),
  quality_flags: z.array(z.string()).max(12).default([]),
});

export const INSIGHT_NOTICE =
  'These insights describe your recorded data. They are not medical advice, not a dose or treatment instruction, and not safety alerts; real-time alerts come from the alert system.';

export type InsightTrigger = 'morning' | 'evening' | 'event';

export interface InsightItem {
  id: string;
  category: string;
  /** Short title, written by Python. */
  headline: string;
  trigger: InsightTrigger;
  /** Higher = more important. Already sorted; shown for transparency, not for the UI to re-rank. */
  priority: number;
  createdAt: string;
  expiresAt: string | null;
  observationStart: string;
  observationEnd: string;
  /** The factual sentences. Authoritative: every number comes from the engine's own calculations. Always present. */
  factsText: string[];
  /** Plain-language explanation by the local model. null when it did not pass validation (the factsText still stands). */
  explanation: string | null;
  /** Material data limitations ("No sleep record, so nothing is said about sleep quality."). Show them. */
  limitations: string[];
  /** 'valid' = model explanation present and validated; 'fallback' = Python text only; 'not_applicable' = availability summary. */
  validation: 'valid' | 'fallback' | 'not_applicable';
  evidenceRefs: string[];
  evidence: { coverage: number | null; method: string | null; qualityFlags: string[]; facts: { ref: string; name: string; value: number | string; unit: string; kind: string }[] };
  contentVersion: number;
}

export type InsightsResponse =
  | { status: 'ok'; generatedAt: string | null; count: number; insights: InsightItem[]; notice: string }
  | { status: 'empty'; reason: 'not_generated_yet' | 'none_active'; lastRunAt: string | null; insights: []; notice: string };
