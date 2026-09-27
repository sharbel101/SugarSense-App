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
  private readonly apiKey: string | undefined;

  constructor(config: ConfigService) {
    this.apiKey = config.get<string>('GEMINI_API_KEY');
    this.model = config.get<string>('GEMINI_MODEL') || DEFAULT_GEMINI_MODEL;
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

    try {
      const response = await this.client.models.generateContent({
        model: this.model,
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
          thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
        },
      });

      const rawText = response.text;
      if (!rawText) {
        throw new MealVisionApiError('Gemini returned an empty response.');
      }
      // Prefer the model version the server itself reports it ran (most reproducible); fall back to
      // the configured string if the field is ever absent.
      return { rawText, modelVersion: response.modelVersion ?? this.model };
    } catch (err) {
      if (err instanceof MealVisionApiError) throw err;
      // Extract only message/status - never forward the raw SDK error object (see class doc comment).
      if (err instanceof GenAiApiError) {
        this.logger.warn(this.redact(`Gemini API error (status ${err.status}): ${err.message}`));
        throw new MealVisionApiError(`Gemini API error (status ${err.status}).`, err.status);
      }
      const message = err instanceof Error ? err.message : 'unknown error';
      this.logger.warn(this.redact(`Gemini call failed: ${message}`));
      throw new MealVisionApiError('Gemini call failed.');
    }
  }
}
