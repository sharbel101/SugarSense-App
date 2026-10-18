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
      // The scan is only a DRAFT until the person confirms it: it must not count in the real forecast. What they get back is a
      // PREVIEW of what this meal would do (counted in full, no insulin yet), so the screen can show it right away.
      const mealId = written.meal?.mealId ?? null;
      const forecast = mealId ? await this.safePreview(mealId) : await this.safeForecast();
      return { mealEventId: mealId, forecast, forecastNote: forecastNoteFor(forecast) };
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

  private async safePreview(mealId: string): Promise<ForecastDisplay | null> {
    try {
      return await this.forecast.preview({ mealId });
    } catch (err) {
      this.logger.warn(`preview failed ${describeDbError(err)}`);
      return null;
    }
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

/**
 * What to tell the person about the forecast that came back with their meal. Never claims the meal is in a
 * forecast that does not exist.
 */
export function forecastNoteFor(forecast: ForecastDisplay | null): string {
  if (forecast === null) return 'Your meal is saved, but the forecast could not be refreshed just now.';
  switch (forecast.status) {
    case 'ok':
      return forecast.preview
        ? 'Preview of what this meal would do to your glucose, counted in full before any insulin. It is not saved, and does not count in your forecast, until you confirm it.'
        : 'Forecast includes this meal as an estimate.';
    case 'baseline_unavailable':
      return 'Your meal is waiting for your confirmation. The glucose forecast is not available right now, so no forecast is drawn for it yet.';
    case 'stale':
      return 'Your meal is waiting for your confirmation. The latest glucose reading is too old to forecast from, so no forecast is shown.';
    default:
      return 'Your meal is waiting for your confirmation. Glucose is not available right now, so no forecast is shown.';
  }
}
