import { Body, Controller, HttpCode, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { NoStoreInterceptor } from '../common/no-store.interceptor.js';
import { AppTokenGuard } from '../common/app-token.guard.js';
import { createRateLimitGuard, envInt } from '../common/rate-limit.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { analyzeMealRequestSchema, type AnalyzeMealRequest } from './dto/analyze-meal-request.schema.js';
import type { MealAnalysisResponse } from './meal-analysis-response.js';
import { MealsService } from './meals.service.js';

/** Each call spends Gemini quota: default 10 per address and 30 in total per 10 minutes. */
const MealsRateLimitGuard = createRateLimitGuard({
  perIpMax: envInt('RATE_LIMIT_MEALS_PER_IP', 10),
  globalMax: envInt('RATE_LIMIT_MEALS_GLOBAL', 30),
  windowMs: 10 * 60_000,
});

@Controller('meals')
@UseGuards(AppTokenGuard, MealsRateLimitGuard)
@UseInterceptors(NoStoreInterceptor)
export class MealsController {
  constructor(private readonly meals: MealsService) {}

  /**
   * Meal-photo carb/calorie/GI estimation only (task point 8). No insulin-unit or dosing arithmetic
   * happens here or anywhere downstream of the vision model - that stays in the existing
   * deterministic bolus calculator (CLAUDE.md section 10), which never takes a model output as input.
   */
  @Post('analyze')
  @HttpCode(200)
  analyze(
    @Body(new ZodValidationPipe(analyzeMealRequestSchema)) body: AnalyzeMealRequest,
  ): Promise<MealAnalysisResponse> {
    return this.meals.analyzeMeal(body);
  }
}
