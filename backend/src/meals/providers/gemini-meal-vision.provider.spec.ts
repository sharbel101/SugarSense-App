import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';

// A sentinel that stands in for a real Gemini API key. The whole point of these tests is to prove
// this string can never reach a thrown error message (task point 1: "Verify no key material can
// appear in any response, log line, or error message sent to the client").
const FAKE_API_KEY = 'SECRET_TEST_GEMINI_KEY_DO_NOT_LEAK_1234567890';

const hoisted = vi.hoisted(() => {
  class MockApiError extends Error {
    status: number;
    constructor(options: { message: string; status: number }) {
      super(options.message);
      this.name = 'ApiError';
      this.status = options.status;
    }
  }
  return {
    MockApiError,
    generateContent: vi.fn(),
    lastConstructedApiKey: undefined as string | undefined,
  };
});

vi.mock('@google/genai', () => {
  class GoogleGenAI {
    models = { generateContent: hoisted.generateContent };
    constructor(options: { apiKey: string }) {
      hoisted.lastConstructedApiKey = options.apiKey;
    }
  }
  return {
    GoogleGenAI,
    ApiError: hoisted.MockApiError,
    PartMediaResolutionLevel: { MEDIA_RESOLUTION_HIGH: 'MEDIA_RESOLUTION_HIGH' },
    ThinkingLevel: { HIGH: 'HIGH' },
    createPartFromBase64: (data: string, mimeType: string) => ({ inlineData: { data, mimeType } }),
    createPartFromText: (text: string) => ({ text }),
    createUserContent: (parts: unknown[]) => ({ role: 'user', parts }),
  };
});

const { GeminiMealVisionProvider } = await import('./gemini-meal-vision.provider.js');
const { MealVisionApiError } = await import('./meal-vision.provider.js');

function fakeConfigService(values: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

describe('GeminiMealVisionProvider (security boundary: no API key material ever leaks)', () => {
  beforeEach(() => {
    hoisted.generateContent.mockReset();
    hoisted.lastConstructedApiKey = undefined;
  });

  it('throws a fixed, generic error - never a fabricated model string - when GEMINI_API_KEY is unset', async () => {
    const provider = new GeminiMealVisionProvider(fakeConfigService({}));

    await expect(
      provider.analyzeMealPhoto({ images: [{ base64Data: 'ZmFrZQ==', mimeType: 'image/jpeg' }] }),
    ).rejects.toThrow('GEMINI_API_KEY is not configured on the server.');
    expect(hoisted.generateContent).not.toHaveBeenCalled();
  });

  it('passes the configured key to the SDK constructor but never into any thrown error message or log line', async () => {
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const provider = new GeminiMealVisionProvider(fakeConfigService({ GEMINI_API_KEY: FAKE_API_KEY }));
    hoisted.generateContent.mockRejectedValueOnce(
      new hoisted.MockApiError({ message: `unauthorized (used key ${FAKE_API_KEY})`, status: 401 }),
    );

    expect(hoisted.lastConstructedApiKey).toBe(FAKE_API_KEY); // sanity: the SDK does get the real key

    let thrown: unknown;
    try {
      await provider.analyzeMealPhoto({ images: [{ base64Data: 'ZmFrZQ==', mimeType: 'image/jpeg' }] });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(MealVisionApiError);
    const message = thrown instanceof Error ? thrown.message : '';
    expect(message).not.toContain(FAKE_API_KEY);
    expect(message).toBe('Gemini API error (status 401).');

    // The upstream error's raw text (which happened to embed the key) still gets logged for
    // diagnostics, but with the key redacted first - defence in depth beyond "the SDK shouldn't do this".
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const loggedText = warnSpy.mock.calls[0]?.[0];
    expect(loggedText).not.toContain(FAKE_API_KEY);
    expect(loggedText).toContain('[REDACTED]');
    warnSpy.mockRestore();
  });

  it('never leaks the key even for a generic (non-ApiError) thrown error, in the message or the log line', async () => {
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const provider = new GeminiMealVisionProvider(fakeConfigService({ GEMINI_API_KEY: FAKE_API_KEY }));
    hoisted.generateContent.mockRejectedValueOnce(new Error(`connection reset for key=${FAKE_API_KEY}`));

    let thrown: unknown;
    try {
      await provider.analyzeMealPhoto({ images: [{ base64Data: 'ZmFrZQ==', mimeType: 'image/jpeg' }] });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(MealVisionApiError);
    const message = thrown instanceof Error ? thrown.message : '';
    expect(message).not.toContain(FAKE_API_KEY);
    expect(message).toBe('Gemini call failed.');

    const loggedText = warnSpy.mock.calls[0]?.[0];
    expect(loggedText).not.toContain(FAKE_API_KEY);
    expect(loggedText).toContain('[REDACTED]');
    warnSpy.mockRestore();
  });

  it('returns the raw text and model version on success, reporting the server-echoed modelVersion', async () => {
    const provider = new GeminiMealVisionProvider(fakeConfigService({ GEMINI_API_KEY: FAKE_API_KEY }));
    hoisted.generateContent.mockResolvedValueOnce({ text: '{"ok":true}', modelVersion: 'gemini-3.8-flash-001' });

    const result = await provider.analyzeMealPhoto({
      images: [{ base64Data: 'ZmFrZQ==', mimeType: 'image/jpeg' }],
    });

    expect(result).toEqual({ rawText: '{"ok":true}', modelVersion: 'gemini-3.8-flash-001' });
  });
});
