import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { analyzeMealRequestSchema, type AnalyzeMealRequest } from './dto/analyze-meal-request.schema.js';
import type { MealAnalysisResponse } from './meal-analysis-response.js';
import { MealsService } from './meals.service.js';

@Controller('meals')
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
