import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MealsController } from './meals.controller.js';
import { MealsService, MEAL_ANALYSIS_SLEEP_FN } from './meals.service.js';
import { MEAL_VISION_PROVIDER } from './providers/meal-vision.provider.js';
import { FakeMealVisionProvider } from './providers/fake-meal-vision.provider.js';

const detectedRawText = JSON.stringify({
  foodStatus: 'detected',
  items: [
    {
      name: 'steamed white rice',
      portionDescription: '1 cup',
      estimatedGrams: 158,
      netCarbsG: 45,
      caloriesKcal: 205,
      confidence: 'medium',
    },
  ],
  totalNetCarbsG: 45,
  totalCarbsRangeLowG: 38,
  totalCarbsRangeHighG: 55,
  totalCaloriesKcal: 205,
  totalFatG: 0.4,
  totalProteinG: 4.3,
  totalFiberG: 0.6,
  estimatedGlycemicIndex: 73,
  glycemicIndexConfidence: 'medium',
  analysisNotes: null,
});

describe('MealsController (integration, fake provider)', () => {
  let app: INestApplication<Server>;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [MealsController],
      providers: [
        MealsService,
        {
          provide: MEAL_VISION_PROVIDER,
          useValue: new FakeMealVisionProvider([{ kind: 'raw', rawText: detectedRawText, modelVersion: 'm1' }]),
        },
        { provide: MEAL_ANALYSIS_SLEEP_FN, useValue: async () => {} },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('POST /meals/analyze -> 200 with a well-formed "ok" body for a valid request', async () => {
    const response = await request(app.getHttpServer())
      .post('/meals/analyze')
      .send({ images: [{ base64Data: 'ZmFrZQ==', mimeType: 'image/jpeg' }] })
      .expect(200);

    expect(response.body.status).toBe('ok');
    expect(response.body.totalNetCarbsG).toBe(45);
    expect(response.body.promptVersion).toBeTruthy();
    expect(response.body.modelVersion).toBe('m1');
  });

  it('POST /meals/analyze -> 400 when images is missing', async () => {
    await request(app.getHttpServer()).post('/meals/analyze').send({}).expect(400);
  });

  it('POST /meals/analyze -> 400 when more than one image is sent (single-photo only for now)', async () => {
    await request(app.getHttpServer())
      .post('/meals/analyze')
      .send({
        images: [
          { base64Data: 'ZmFrZQ==', mimeType: 'image/jpeg' },
          { base64Data: 'ZmFrZQ==', mimeType: 'image/jpeg' },
        ],
      })
      .expect(400);
  });

  it('POST /meals/analyze -> 400 for an unsupported mime type', async () => {
    await request(app.getHttpServer())
      .post('/meals/analyze')
      .send({ images: [{ base64Data: 'ZmFrZQ==', mimeType: 'image/gif' }] })
      .expect(400);
  });

  it('never echoes a GEMINI_API_KEY-shaped value back in any response', async () => {
    const response = await request(app.getHttpServer())
      .post('/meals/analyze')
      .send({ images: [{ base64Data: 'ZmFrZQ==', mimeType: 'image/jpeg' }] })
      .expect(200);

    expect(JSON.stringify(response.body)).not.toContain('GEMINI_API_KEY');
  });
});
