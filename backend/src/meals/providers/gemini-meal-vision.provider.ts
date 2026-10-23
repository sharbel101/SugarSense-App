import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GoogleGenAI,
  PartMediaResolutionLevel,
  ThinkingLevel,
  createPartFromBase64,
  createPartFromText,
  createUserContent,
  ApiError as GenAiApiError,
} from '@google/genai';
import { GEMINI_MEAL_ANALYSIS_JSON_SCHEMA } from '../schema/to-gemini-json-schema.js';
import { buildMealAnalysisSystemPrompt } from '../prompt/meal-analysis-prompt.js';
import {
  MealVisionApiError,
  type MealVisionProvider,
  type MealVisionRawResult,
  type MealVisionRequest,
} from './meal-vision.provider.js';

/**
 * Default model. Pinned to an exact GA model string, not a floating alias like "gemini-flash-latest" -
 * CLAUDE.md invariant 4 requires every prediction be reproducible from its stored `model_version`,
 * which is meaningless if the string on file can silently start meaning a different model tomorrow.
 * Override with GEMINI_MODEL for ops to roll forward/back without a code deploy; whatever string is
 * actually configured is what gets stored as modelVersion (see `analyzeMealPhoto` below).
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

/**
 * Latency controls (all overridable by env, none changes what is stored):
 *  - GEMINI_THINKING_LEVEL: how much the model reasons before answering. Gemini 3 defaults to HIGH, the slowest setting; MEDIUM is the default
 *    here (it was HIGH). Allowed: MINIMAL, LOW, MEDIUM, HIGH. Lower it further only after comparing carbs/fat/protein on real photos.
 *  - GEMINI_CALL_TIMEOUT_MS: hard limit for ONE model call (default 30 s). Before this, a hung call waited about 5 minutes for the network to give up.
 *  - GEMINI_HEDGE_MS: if the primary model has not answered after this long, the fallback model is started in parallel and the first valid
 *    answer wins (default 8 s). A primary that fails fast with 429/5xx/timeout starts the fallback at once, as before.
 */
export const DEFAULT_THINKING_LEVEL = 'MEDIUM';
export const DEFAULT_CALL_TIMEOUT_MS = 30_000;
export const DEFAULT_HEDGE_MS = 8_000;
const THINKING_LEVELS = ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'] as const;
type ThinkingName = (typeof THINKING_LEVELS)[number];

function positiveInt(v: string | undefined, fallback: number): number {
  const n = v === undefined || v.trim() === '' ? NaN : Number(v);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Real `MealVisionProvider` backed by the official `@google/genai` Node SDK (never hand-rolled HTTP).
 *
 * SECURITY (task point 1): GEMINI_API_KEY is read once from `ConfigService` (server-side env only,
 * see backend/.env.example) and handed directly to the SDK constructor. It is never interpolated
 * into a log line, an error message, or anything returned to a caller - see the `catch` blocks below,
 * which extract only `.message`/`.status` from SDK errors and construct a fresh, sanitised
 * `MealVisionApiError`. The SDK authenticates via an `x-goog-api-key` header, not a URL, so the key
 * cannot leak through a logged request URL either.
 */
@Injectable()
export class GeminiMealVisionProvider implements MealVisionProvider {
  private readonly logger = new Logger(GeminiMealVisionProvider.name);
  private readonly client: GoogleGenAI | null;
  private readonly model: string;
  /** Optional second model tried once, inside the same attempt, when the first one is overloaded. */
  private readonly fallbackModel: string | undefined;
  private readonly apiKey: string | undefined;
  private readonly thinking: ThinkingName;
  private readonly callTimeoutMs: number;
  private readonly hedgeMs: number;

  constructor(config: ConfigService) {
    this.apiKey = config.get<string>('GEMINI_API_KEY');
    this.model = config.get<string>('GEMINI_MODEL') || DEFAULT_GEMINI_MODEL;
    const fallback = config.get<string>('GEMINI_FALLBACK_MODEL')?.trim();
    this.fallbackModel = fallback && fallback !== this.model ? fallback : undefined;
    const level = config.get<string>('GEMINI_THINKING_LEVEL')?.trim().toUpperCase() ?? '';
    this.thinking = (THINKING_LEVELS as readonly string[]).includes(level) ? (level as ThinkingName) : DEFAULT_THINKING_LEVEL;
    this.callTimeoutMs = positiveInt(config.get<string>('GEMINI_CALL_TIMEOUT_MS'), DEFAULT_CALL_TIMEOUT_MS);
    this.hedgeMs = positiveInt(config.get<string>('GEMINI_HEDGE_MS'), DEFAULT_HEDGE_MS);
    // Deliberately lazy/nullable rather than throwing here: the rest of the server (e.g. /health)
    // must keep working even if this one key is unset (HANDOFF-BACKEND-AI.md: "nothing is required
    // for the server to start"). analyzeMealPhoto throws a clear, specific error if it's actually used.
    this.client = this.apiKey ? new GoogleGenAI({ apiKey: this.apiKey }) : null;
  }

  /**
   * Defence in depth for task point 1 ("no key material in ... any log line"): even though Gemini
   * authenticates via an `x-goog-api-key` header (so the key should never appear in a URL or error
   * body the SDK surfaces to us), this scrubs the exact configured key out of anything we are about
   * to log, in case an upstream error or a future SDK version ever echoes it back.
   */
  private redact(text: string): string {
    return this.apiKey ? text.split(this.apiKey).join('[REDACTED]') : text;
  }

  async analyzeMealPhoto(request: MealVisionRequest): Promise<MealVisionRawResult> {
    if (!this.client) {
      throw new MealVisionApiError('GEMINI_API_KEY is not configured on the server.');
    }
    if (request.images.length === 0) {
      throw new MealVisionApiError('At least one image is required.');
    }

    const imageParts = request.images.map((image) =>
      createPartFromBase64(image.base64Data, image.mimeType, PartMediaResolutionLevel.MEDIA_RESOLUTION_HIGH),
    );
    const parts = request.userNote ? [...imageParts, createPartFromText(request.userNote)] : imageParts;

    return this.runWithFallback(this.client, parts);
  }

  /**
   * Primary first. If it fails with a transient status (429/5xx/timeout) the fallback runs at once. If it is merely slow (no answer after
   * hedgeMs) the fallback is started in PARALLEL and the first successful answer wins; the loser is cancelled. A caller error (401, 400 ...) never
   * uses the fallback. The model that actually answered is what is stored as modelVersion.
   */
  private async runWithFallback(client: GoogleGenAI, parts: ReturnType<typeof createPartFromBase64>[]): Promise<MealVisionRawResult> {
    const primaryCtl = new AbortController();
    const primary = this.generate(client, this.model, parts, primaryCtl.signal);
    if (!this.fallbackModel) return primary;
    const fallbackModel = this.fallbackModel;

    type Settled = { kind: 'ok'; value: MealVisionRawResult } | { kind: 'err'; error: unknown } | { kind: 'slow' };
    const settled = primary.then<Settled, Settled>(
      (value) => ({ kind: 'ok', value }),
      (error: unknown) => ({ kind: 'err', error }),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slow = new Promise<Settled>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'slow' }), this.hedgeMs);
    });
    const first = await Promise.race([settled, slow]);
    clearTimeout(timer);

    if (first.kind === 'ok') return first.value;
    if (first.kind === 'err') {
      if (first.error instanceof MealVisionApiError && isTransientStatus(first.error.cause)) {
        this.logger.warn(`Gemini ${String(first.error.cause)} on the primary model; trying the fallback model`);
        return this.generate(client, fallbackModel, parts, new AbortController().signal);
      }
      throw first.error;
    }

    // The primary is slow: run both, the first valid answer wins and the other call is cancelled.
    this.logger.warn(`Gemini primary model has not answered after ${this.hedgeMs} ms; starting the fallback model in parallel`);
    const fallbackCtl = new AbortController();
    const fallback = this.generate(client, fallbackModel, parts, fallbackCtl.signal);
    const racers = [
      { name: 'primary', p: primary, ctl: primaryCtl },
      { name: 'fallback', p: fallback, ctl: fallbackCtl },
    ];
    try {
      const win = await Promise.any(racers.map((r) => r.p.then((value) => ({ name: r.name, value }))));
      for (const r of racers) if (r.name !== win.name) r.ctl.abort();
      return win.value;
    } catch (agg) {
      const errors = agg instanceof AggregateError ? (agg.errors as unknown[]) : [agg];
      // Both failed: report a caller error if there was one, else the primary's error.
      throw errors.find((e) => e instanceof MealVisionApiError && !isTransientStatus(e.cause)) ?? errors[0] ?? new MealVisionApiError('Gemini call failed.');
    }
  }

  private async generate(client: GoogleGenAI, model: string, parts: ReturnType<typeof createPartFromBase64>[], signal: AbortSignal): Promise<MealVisionRawResult> {
    const started = Date.now();
    try {
      const response = await client.models.generateContent({
        model,
        contents: createUserContent(parts),
        config: {
          systemInstruction: buildMealAnalysisSystemPrompt(),
          // Low temperature: this is an estimation task, not a creative one (CLAUDE.md section 9).
          temperature: 0.1,
          responseMimeType: 'application/json',
          responseJsonSchema: GEMINI_MEAL_ANALYSIS_JSON_SCHEMA,
          // Portion-size and absorption-profile estimation from a single 2D photo is a genuinely
          // reasoning-heavy visual task (occlusion, density, hidden ingredients) - raise thinking
          // above the model's default for it, per Gemini 3's thinkingLevel control.
          thinkingConfig: { thinkingLevel: ThinkingLevel[this.thinking] },
          abortSignal: signal,
          httpOptions: { timeout: this.callTimeoutMs },
        },
      });

      const rawText = response.text;
      if (!rawText) {
        throw new MealVisionApiError('Gemini returned an empty response.');
      }
      // Prefer the model version the server itself reports it ran (most reproducible); fall back to
      // the configured string if the field is ever absent.
      this.logger.log(`Gemini ${model} answered in ${Date.now() - started} ms (thinking ${this.thinking})`);
      return { rawText, modelVersion: response.modelVersion ?? model };
    } catch (err) {
      if (err instanceof MealVisionApiError) throw err;
      // Extract only message/status - never forward the raw SDK error object (see class doc comment).
      if (err instanceof GenAiApiError) {
        this.logger.warn(this.redact(`Gemini API error (status ${err.status}): ${err.message}`));
        throw new MealVisionApiError(`Gemini API error (status ${err.status}).`, err.status);
      }
      const message = err instanceof Error ? err.message : 'unknown error';
      const elapsed = Date.now() - started;
      this.logger.warn(this.redact(`Gemini call failed after ${elapsed} ms: ${message}`));
      // A timeout is treated as transient (cause 504) so the fallback model can be tried; the message stays generic.
      const timedOut = elapsed >= this.callTimeoutMs - 250 || /timeout|timed out/i.test(message);
      throw timedOut ? new MealVisionApiError('Gemini call failed.', 504) : new MealVisionApiError('Gemini call failed.');
    }
  }
}

/** Overload / rate-limit / server-side statuses that are worth one more try, not a caller mistake. */
export function isTransientStatus(status: unknown): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}
