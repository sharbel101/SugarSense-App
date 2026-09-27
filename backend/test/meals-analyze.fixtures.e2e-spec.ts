import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

/**
 * Live-Gemini fixture test (task point 11). Runs the *real* endpoint - real Gemini API call, real
 * Gate 1/Gate 2 validation - against a handful of sample food photos with a hand-checked, wide carb
 * ballpark. This is NOT a real accuracy-measurement harness (no ground truth here - nobody weighed
 * these meals); it exists only to catch an obviously broken prompt/schema/response-mapping on future
 * changes. See backend/src/meals/README.md for the real accuracy harness this still needs, as a
 * separate follow-up task.
 *
 * Skipped entirely when GEMINI_API_KEY is not set (e.g. most CI runs and most local dev machines),
 * so it never blocks `npm run test:e2e` for anyone without a key.
 */

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'meals');

function loadImageBase64(filename: string): string {
  return readFileSync(path.join(FIXTURES_DIR, filename)).toString('base64');
}

const hasApiKey = Boolean(process.env.GEMINI_API_KEY);
const REAL_CALL_TIMEOUT_MS = 45_000; // real Gemini calls with thinkingLevel HIGH + an image can be slow

interface FoodFixtureCase {
  file: string;
  label: string;
  /** Hand-checked wide ballpark, not a precise expectation - see file header. */
  minCarbsG: number;
  maxCarbsG: number;
}

const FOOD_FIXTURES: FoodFixtureCase[] = [
  { file: 'rice_bowl.jpg', label: 'bowl of steamed white rice', minCarbsG: 15, maxCarbsG: 90 },
  { file: 'banana.jpg', label: 'single banana', minCarbsG: 10, maxCarbsG: 45 },
  { file: 'salad.jpg', label: 'mixed green salad, no starchy toppings', minCarbsG: 0, maxCarbsG: 30 },
  { file: 'pizza_slice.jpg', label: 'large pizza slice with meat/mushroom toppings', minCarbsG: 15, maxCarbsG: 70 },
  {
    file: 'chicken_zucchini.jpg',
    label: 'breaded chicken breast with grilled zucchini',
    minCarbsG: 0,
    maxCarbsG: 40,
  },
];

describe.skipIf(!hasApiKey)(
  'POST /meals/analyze against the real Gemini endpoint (fixtures; skipped without GEMINI_API_KEY)',
  () => {
    let app: INestApplication<Server>;

    beforeAll(async () => {
      const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleFixture.createNestApplication();
      await app.init();
    });

    afterAll(async () => {
      await app.close();
    });

    for (const testCase of FOOD_FIXTURES) {
      it(
        `${testCase.file} (${testCase.label}) -> "ok" with totalNetCarbsG in [${testCase.minCarbsG}, ${testCase.maxCarbsG}]g`,
        async () => {
          const base64Data = loadImageBase64(testCase.file);
          const response = await request(app.getHttpServer())
            .post('/meals/analyze')
            .send({ images: [{ base64Data, mimeType: 'image/jpeg' }] })
            .expect(200);

          expect(response.body.status).toBe('ok');
          expect(response.body.promptVersion).toBeTruthy();
          expect(response.body.modelVersion).toBeTruthy();
          expect(Array.isArray(response.body.items)).toBe(true);
          expect(response.body.items.length).toBeGreaterThan(0);
          expect(response.body.totalCaloriesKcal).toBeGreaterThan(0);

          // The range must be an honest bound around the point estimate, not just present.
          expect(response.body.totalCarbsRangeLowG).toBeLessThanOrEqual(response.body.totalNetCarbsG);
          expect(response.body.totalNetCarbsG).toBeLessThanOrEqual(response.body.totalCarbsRangeHighG);

          // The wide, hand-checked sanity band - see file header for what this is and isn't.
          expect(response.body.totalNetCarbsG).toBeGreaterThanOrEqual(testCase.minCarbsG);
          expect(response.body.totalNetCarbsG).toBeLessThanOrEqual(testCase.maxCarbsG);

          // GI, if the model offered one at all, must never claim "high" confidence (task constraint).
          if (response.body.estimatedGlycemicIndex !== null) {
            expect(['medium', 'low']).toContain(response.body.glycemicIndexConfidence);
          }
        },
        REAL_CALL_TIMEOUT_MS,
      );
    }

    it(
      'no_food_laptop.jpg (a laptop, not food) -> "no_food_detected", never fabricating carbs',
      async () => {
        const base64Data = loadImageBase64('no_food_laptop.jpg');
        const response = await request(app.getHttpServer())
          .post('/meals/analyze')
          .send({ images: [{ base64Data, mimeType: 'image/jpeg' }] })
          .expect(200);

        expect(response.body.status).toBe('no_food_detected');
        expect(response.body).not.toHaveProperty('items');
        expect(response.body).not.toHaveProperty('totalNetCarbsG');
        expect(response.body.promptVersion).toBeTruthy();
        expect(response.body.modelVersion).toBeTruthy();
      },
      REAL_CALL_TIMEOUT_MS,
    );
  },
);
