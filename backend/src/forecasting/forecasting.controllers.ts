import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { AppTokenGuard } from '../common/app-token.guard.js';
import { createRateLimitGuard, envInt } from '../common/rate-limit.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { DbService, describeDbError } from '../db/db.service.js';
import {
  counterfactualSchema,
  createInsulinSchema,
  createMealSchema,
  editInsulinSchema,
  editMealSchema,
  forecastQuerySchema,
  type CounterfactualInput,
  type CreateInsulinInput,
  type CreateMealInput,
  type EditInsulinInput,
  type EditMealInput,
} from './events.schema.js';
import { EventsApiService } from './events-api.service.js';
import type { WriteStatus } from './events.service.js';
import { ForecastService } from './forecast.service.js';
import { PersonalizationService } from './personalization.service.js';
import { therapySettingsSchema, type TherapySettingsInput } from './therapy.schema.js';
import { TherapyService } from './therapy.service.js';
import { UsersService } from './users.service.js';

const ForecastingRateLimit = createRateLimitGuard({
  perIpMax: envInt('RATE_LIMIT_FORECAST_PER_IP', 60),
  globalMax: envInt('RATE_LIMIT_FORECAST_GLOBAL', 180),
  windowMs: 60_000,
});

const HTTP_BY_WRITE: Record<WriteStatus, number> = {
  created: HttpStatus.CREATED,
  updated: HttpStatus.OK,
  unchanged: HttpStatus.OK,
  exists: HttpStatus.OK,
  duplicate: HttpStatus.CONFLICT,
  conflict: HttpStatus.CONFLICT,
  not_found: HttpStatus.NOT_FOUND,
  invalid: HttpStatus.UNPROCESSABLE_ENTITY,
};

const UNAVAILABLE_BODY = { status: 'unavailable', reason: 'Saving and reading your history is not available right now.' } as const;

/** Database failures answer with a fixed message: no driver text, SQL or connection detail leaves the server. */
async function guarded<T>(db: DbService, fn: () => Promise<T>): Promise<T> {
  if (!db.available) throw new ServiceUnavailableException(UNAVAILABLE_BODY);
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpException) throw err;
    void describeDbError(err);
    throw new ServiceUnavailableException(UNAVAILABLE_BODY);
  }
}

@Controller('forecast')
@UseGuards(AppTokenGuard, ForecastingRateLimit)
export class ForecastController {
  constructor(
    @Inject(ForecastService) private readonly forecast: ForecastService,
    @Inject(PersonalizationService) private readonly personalization: PersonalizationService,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(DbService) private readonly db: DbService,
  ) {}

  /** Current forecast: glucose-only baseline adjusted for logged meals and insulin, up to 3 hours. */
  @Get()
  async get(@Query(new ZodValidationPipe(forecastQuerySchema)) q: { horizonMin?: number }) {
    return this.forecast.run({ horizonMin: q.horizonMin });
  }

  /**
   * What-if view for a future "clear recent meals" action: the given meals are left out, insulin that was
   * delivered still counts, nothing is saved or deleted, and the response is labelled counterfactual.
   */
  @Post('counterfactual')
  @HttpCode(200)
  async counterfactual(@Body(new ZodValidationPipe(counterfactualSchema)) body: CounterfactualInput) {
    return this.forecast.run({ horizonMin: body.horizonMin, excludeMealIds: body.excludeMealIds, persist: false });
  }

  /** Stored-outcome comparison of the meal-aware layer against the glucose-only baseline. */
  @Get('evaluation')
  async evaluation() {
    return guarded(this.db, async () => {
      const { userId } = await this.users.primary();
      const rows = await this.personalization.compareBaselineVsAdjusted(userId);
      return {
        comparison: rows,
        note:
          rows.length === 0
            ? 'No scored forecasts with logged events yet. Nothing can be said about accuracy.'
            : 'Measured on your own stored forecasts. Small samples are not evidence of improvement.',
      };
    });
  }
}

@Controller('events')
@UseGuards(AppTokenGuard, ForecastingRateLimit)
export class EventsController {
  constructor(
    @Inject(EventsApiService) private readonly api: EventsApiService,
    @Inject(DbService) private readonly db: DbService,
  ) {}

  @Post('meals')
  async addMeal(@Body(new ZodValidationPipe(createMealSchema)) body: CreateMealInput, @Res({ passthrough: true }) res: Response) {
    const out = await guarded(this.db, () => this.api.addMeal(body));
    res.status(HTTP_BY_WRITE[out.result]);
    return out;
  }

  @Patch('meals/:id')
  async editMeal(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(editMealSchema)) body: EditMealInput,
    @Res({ passthrough: true }) res: Response,
  ) {
    const out = await guarded(this.db, () => this.api.editMeal(id, body));
    res.status(HTTP_BY_WRITE[out.result]);
    return out;
  }

  @Get('meals/:id/coverage')
  async coverage(@Param('id', new ParseUUIDPipe()) id: string) {
    const view = await guarded(this.db, () => this.api.mealCoverage(id));
    if (!view) throw new NotFoundException();
    return view;
  }

  @Post('insulin')
  async addInsulin(@Body(new ZodValidationPipe(createInsulinSchema)) body: CreateInsulinInput, @Res({ passthrough: true }) res: Response) {
    const out = await guarded(this.db, () => this.api.addInsulin(body));
    res.status(HTTP_BY_WRITE[out.result]);
    return out;
  }

  @Patch('insulin/:id')
  async editInsulin(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(editInsulinSchema)) body: EditInsulinInput,
    @Res({ passthrough: true }) res: Response,
  ) {
    const out = await guarded(this.db, () => this.api.editInsulin(id, body));
    res.status(HTTP_BY_WRITE[out.result]);
    return out;
  }

  @Get('recent')
  async recent(@Query('hours') hours?: string) {
    const h = Number(hours);
    return guarded(this.db, () => this.api.recent(Number.isFinite(h) && h > 0 ? h : 12));
  }
}

@Controller('therapy')
@UseGuards(AppTokenGuard, ForecastingRateLimit)
export class TherapyController {
  constructor(
    @Inject(TherapyService) private readonly therapy: TherapyService,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(DbService) private readonly db: DbService,
  ) {}

  /** The settings in force now (or `status: "not_set"`). Field names carry the unit. */
  @Get('settings')
  async get() {
    return guarded(this.db, async () => this.therapy.getView((await this.users.primary()).userId));
  }

  @Get('settings/history')
  async history() {
    return guarded(this.db, async () => ({ versions: await this.therapy.history((await this.users.primary()).userId) }));
  }

  /** Saves a NEW version of the settings you enter. Never edits history; never changes automatically. */
  @Put('settings')
  async put(@Body(new ZodValidationPipe(therapySettingsSchema)) body: TherapySettingsInput) {
    return guarded(this.db, async () => this.therapy.setSettings((await this.users.primary()).userId, body));
  }
}
