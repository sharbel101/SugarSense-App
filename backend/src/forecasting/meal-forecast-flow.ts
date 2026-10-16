import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DbService, describeDbError } from '../db/db.service.js';
import type { MealAnalysisOkResponse } from '../meals/meal-analysis-response.js';
import { clientIdToUuid, uuidFromSha256 } from './client-id.js';
import { EventsService } from './events.service.js';
import { ForecastService } from './forecast.service.js';
import type { ForecastDisplay } from './forecast-response.js';
import { UsersService } from './users.service.js';

export interface PhotoFlowContext {
  /** sha256 hex of the uploaded image: a retry of the same photo maps to the same meal event. */
  imageSha256: string;
  clientId?: string;
  /** When eating started, if the app knows; defaults to the time of the request. */
  eatenAt?: string;
  userNote?: string;
}

export interface PhotoFlowResult {
  mealEventId: string | null;
  forecast: ForecastDisplay | null;
  forecastNote: string;
}

export const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * Photo -> validated analysis -> meal event -> forecast, in one request. Whatever goes wrong after the
 * analysis (no database, a rejected time, a failed forecast) the caller still gets the analysis and, where
 * possible, the glucose-only forecast with the limitation stated.
 */
@Injectable()
export class MealForecastFlow {
  private readonly logger = new Logger(MealForecastFlow.name);

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(EventsService) private readonly events: EventsService,
    @Inject(ForecastService) private readonly forecast: ForecastService,
  ) {}

  /** Analysis succeeded: store the meal event and forecast with it. Never throws. */
  async afterAnalysis(analysis: MealAnalysisOkResponse, ctx: PhotoFlowContext): Promise<PhotoFlowResult> {
    if (!this.db.available) {
      return {
        mealEventId: null,
        forecast: await this.safeForecast(),
        forecastNote: 'This meal could not be saved, so the forecast does not include it.',
      };
    }
    try {
      const { userId } = await this.users.primary();
      const nowSec = Math.floor(Date.now() / 1000);
      const eatenAtSec = ctx.eatenAt ? Math.floor(Date.parse(ctx.eatenAt) / 1000) : nowSec;
      const written = await this.events.createPhotoMeal(userId, {
        clientUuid: ctx.clientId ? clientIdToUuid(ctx.clientId) : uuidFromSha256(ctx.imageSha256),
        eatenAtSec,
        analysis,
        userNote: ctx.userNote,
      });
      if (written.status !== 'created' && written.status !== 'exists') {
        return {
          mealEventId: null,
          forecast: await this.safeForecast(),
          forecastNote: `This meal was not added to the forecast (${written.reason ?? 'rejected'}).`,
        };
      }
      return {
        mealEventId: written.meal?.mealId ?? null,
        forecast: await this.safeForecast(),
        forecastNote:
          'Forecast includes this meal as an estimate. If you correct the amount, the forecast updates; your insulin entry is needed for the meal to move the central line.',
      };
    } catch (err) {
      this.logger.warn(`photo flow failed after analysis ${describeDbError(err)}`);
      return {
        mealEventId: null,
        forecast: await this.safeForecast(),
        forecastNote: 'This meal could not be saved, so the forecast does not include it.',
      };
    }
  }

  /** Analysis failed or found no food: keep the glucose-only forecast and say why the meal is absent. */
  async afterFailedAnalysis(): Promise<PhotoFlowResult> {
    return {
      mealEventId: null,
      forecast: await this.safeForecast(),
      forecastNote: 'The photo could not be used, so the forecast does not include this meal.',
    };
  }

  private async safeForecast(): Promise<ForecastDisplay | null> {
    try {
      return await this.forecast.run();
    } catch (err) {
      this.logger.warn(`forecast failed ${describeDbError(err)}`);
      return null;
    }
  }
}
