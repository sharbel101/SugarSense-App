import { HttpException, Inject, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { carbCoverage, linkMealsToInsulin } from '../engine/coverage.js';
import { carbSigmaG, priorBaselineSigma, type ForecastPoint } from '../engine/compose.js';
import { resolveAbsorptionProfile } from '../engine/absorption.js';
import {
  ABSORPTION_LAYER_VERSION,
  BASELINE_HORIZON_MIN,
  DEFAULT_ENGINE_PARAMS,
  ENGINE_LAYER_VERSION,
  SHADOW_MARKER,
  TIME_CLASS_RATIO,
  MAX_HORIZON_MIN,
  STEP_MIN,
} from '../engine/params.js';
import { computeRun, hashInputs, type RunInputs } from '../engine/run.js';
import type { AbsorptionFeatures, EngineParams, EventDisposition, EventLayerResult, InsulinInput, MealInput, MealLink } from '../engine/types.js';
import { DbService, describeDbError } from '../db/db.service.js';
import type { PreviewInput } from './events.schema.js';
import { GlucoseService } from '../glucose/glucose.service.js';
import { BaselineErrorService } from './baseline-error.service.js';
import { EventsService, checkEventTime, type InsulinRow, type MealRow } from './events.service.js';
import {
  ALL_LOGGED_COUNTED_DESCRIPTION,
  FORECAST_DISCLAIMER,
  type AllLoggedCountedDisplay,
  type EventRoleDisplay,
  type ForecastDisplay,
  type ForecastEventDisplay,
} from './forecast-response.js';
import { ParametersService } from './parameters.service.js';
import { PersonalizationService } from './personalization.service.js';
import { PredictionStore, type EventLinkRecord } from './prediction-store.service.js';
import { TherapyService, type ResolvedTherapy, type TherapyResolver } from './therapy.service.js';
import { toIso, toSec } from './time.js';
import { declaredMealOf, isRapidActing, toLinkable } from './linkable.js';
import { UsersService } from './users.service.js';

/** Insulin tail (longest allowed duration) plus margin: events older than this cannot still be acting. */
const LOOKBACK_SEC = 480 * 60;
const FUTURE_SLACK_SEC = 5 * 60;
/**
 * The what-if view is only shown when it moves the line by at least this much (mg/dL) somewhere. Below that it is within the noise of
 * the forecast itself (the 80% range is about +/-25 mg/dL at one hour) and would only add a second line that looks the same.
 */
const ALL_COUNTED_MIN_DIFF_MGDL = 15;

/**
 * How the new absorption model (absorption.ts) is deployed. 'shadow' (default): the incumbent single-component profile draws the
 * forecast, and the candidate's forecast is computed alongside, stored under a shadow model_version and scored against real outcomes,
 * never shown or learned from. 'active': the candidate draws the forecast and the incumbent is the shadow. 'off': incumbent only.
 * Promote by setting ABSORPTION_MODE=active only after GET /forecast/evaluation shows the candidate at least as good on stored outcomes.
 */
export type AbsorptionMode = 'off' | 'shadow' | 'active';
export function absorptionMode(): AbsorptionMode {
  const v = (process.env.ABSORPTION_MODE ?? 'shadow').toLowerCase();
  return v === 'off' || v === 'active' ? v : 'shadow';
}

export interface RunOptions {
  horizonMin?: number;
  /** Preview: a meal and/or a dose that are NOT logged (yet); they are counted in full and nothing is saved. */
  preview?: { meal: MealRow | null; insulin: InsulinRow | null };
  /** What-if view: ignore these meals' carbohydrate effect. Insulin that was delivered stays. Never saved. */
  excludeMealIds?: string[];
  persist?: boolean;
  nowSec?: number;
}

const ROLE_DISPLAY: Record<EventDisposition['role'], EventRoleDisplay> = {
  applied: 'used',
  scenario_only: 'range_only',
  ignored: 'not_used',
  excluded: 'excluded',
};

/**
 * The orchestrator: current glucose-only forecast + the logged meals and insulin, combined by the
 * meal-aware layer, saved before its outcome is known. Degrades step by step and says so:
 * no database -> glucose-only; no therapy settings -> glucose-only; unknown insulin -> mean unchanged,
 * range widened; baseline unavailable -> no forecast at all (nothing is extrapolated).
 */
@Injectable()
export class ForecastService {
  private readonly logger = new Logger(ForecastService.name);

  constructor(
    @Inject(GlucoseService) private readonly glucose: GlucoseService,
    @Inject(DbService) private readonly db: DbService,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(TherapyService) private readonly therapy: TherapyService,
    @Inject(EventsService) private readonly events: EventsService,
    @Inject(ParametersService) private readonly parameters: ParametersService,
    @Inject(BaselineErrorService) private readonly baselineError: BaselineErrorService,
    @Inject(PredictionStore) private readonly store: PredictionStore,
    @Inject(PersonalizationService) private readonly personalization: PersonalizationService,
  ) {}

  /**
   * "What would this meal / this insulin amount do?", before anything is saved. The meal (a stored draft by id, or typed grams) and
   * the insulin amount are counted IN FULL on top of what is already logged: a meal with no insulin shows its uncovered rise, a meal
   * with the amount entered shows the net effect, an amount alone shows the correction. Nothing is written; confirming (PATCH
   * status confirmed, POST /events/insulin) is what makes it count. A what-if of the numbers the person typed, never a suggestion.
   */
  async preview(input: PreviewInput): Promise<ForecastDisplay> {
    const nowSec = Math.floor(Date.now() / 1000);
    const base = { horizonMin: input.horizonMin, persist: false };
    if (!this.db.available) return this.run(base);
    let meal: MealRow | null = null;
    let insulin: InsulinRow | null = null;
    try {
      const user = await this.users.primary();
      if (input.mealId) {
        const row = await this.events.mealById(user.userId, input.mealId);
        if (!row || row.status === 'cancelled') throw new NotFoundException();
        meal = row;
      } else if (input.meal) {
        const t = input.meal.eatenAt ? toSec(input.meal.eatenAt) : nowSec;
        const bad = checkEventTime(t, nowSec);
        if (bad) throw new UnprocessableEntityException(bad);
        meal = adHocMeal(input.meal, t);
      }
      if (input.insulinUnits !== undefined) {
        const t = input.insulinAt ? toSec(input.insulinAt) : nowSec;
        const bad = checkEventTime(t, nowSec);
        if (bad) throw new UnprocessableEntityException(bad);
        insulin = previewDose(input.insulinUnits, t, meal);
      }
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.warn('preview inputs not loaded ' + describeDbError(err));
      return this.run(base);
    }
    return this.run({ ...base, nowSec, preview: { meal, insulin } });
  }

  async run(opts: RunOptions = {}): Promise<ForecastDisplay> {
    const horizon = Math.min(MAX_HORIZON_MIN, Math.max(STEP_MIN, Math.floor((opts.horizonMin ?? MAX_HORIZON_MIN) / STEP_MIN) * STEP_MIN));
    const g = await this.glucose.getGlucose();
    if (g.status === 'stale') return { status: 'stale', reason: g.reason, lastMeasuredAt: g.lastMeasuredAt };
    if (g.status === 'unavailable') return { status: 'unavailable', reason: g.reason };

    const anchorSec = toSec(g.measuredAt);
    const anchor = { measuredAt: g.measuredAt, glucoseMgdl: g.glucoseMgdl, ageMinutes: g.ageMinutes };
    // Without the glucose-only forecast no glucose line is drawn - but what the person logged is still
    // accounted for (insulin / carbs on board), so a logged meal or dose never seems to have vanished.
    const baseline = g.predictions
      .map((p) => ({ minutes: Math.round((toSec(p.time) - anchorSec) / 60), value: p.value }))
      .filter((p) => p.minutes >= STEP_MIN && p.minutes <= BASELINE_HORIZON_MIN && p.minutes % STEP_MIN === 0);
    const baselineModel = g.modelVersion ?? 'unknown_baseline';
    const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
    const excludeMealIds = [...new Set(opts.excludeMealIds ?? [])].sort();
    const counterfactual = excludeMealIds.length > 0;
    const notes: string[] = [];

    // ---- load events, settings, parameters (all optional: failure degrades to glucose-only) ------
    let userId: string | null = null;
    let resolver: TherapyResolver | null = null;
    let mealRows: MealRow[] = [];
    let insulinRows: InsulinRow[] = [];
    let params: EngineParams = { ...DEFAULT_ENGINE_PARAMS };
    let parameterLabel = 'm_csf=default,m_isf=default';
    let sigmaFn: (m: number) => number = priorBaselineSigma;
    let eventsLoaded = false;
    if (this.db.available) {
      try {
        const user = await this.users.primary();
        userId = user.userId;
        resolver = await this.therapy.resolver(user.userId, user.timezone);
        [mealRows, insulinRows] = await Promise.all([
          this.events.mealsBetween(user.userId, anchorSec - LOOKBACK_SEC, nowSec + FUTURE_SLACK_SEC),
          this.events.insulinBetween(user.userId, anchorSec - LOOKBACK_SEC, nowSec + FUTURE_SLACK_SEC),
        ]);
        const active = await this.parameters.getActive(user.userId);
        params = active.params;
        parameterLabel = active.label;
        sigmaFn = await this.baselineError.sigmaFn(user.userId, baselineModel);
        eventsLoaded = true;
      } catch (err) {
        this.logger.warn(`events not loaded ${describeDbError(err)}`);
        notes.push('Your logged meals and insulin could not be read just now, so this is the glucose-only forecast.');
        mealRows = [];
        insulinRows = [];
        resolver = null;
        params = { ...DEFAULT_ENGINE_PARAMS };
        parameterLabel = 'm_csf=default,m_isf=default';
        sigmaFn = priorBaselineSigma;
      }
    } else {
      notes.push('Logged meals and insulin are not available right now, so this is the glucose-only forecast.');
    }

    // Preview: the meal / dose being tried are added to what is logged and counted in full (never saved).
    const forceApplyIds: string[] = [];
    const previewing = opts.preview !== undefined && eventsLoaded;
    if (opts.preview && eventsLoaded) {
      const { meal: pm, insulin: pi } = opts.preview;
      if (pm) {
        mealRows = [...mealRows.filter((m) => m.mealId !== pm.mealId), pm];
        forceApplyIds.push(pm.mealId);
      }
      if (pi) {
        insulinRows = [...insulinRows, pi];
        forceApplyIds.push(pi.insulinId);
      }
    }

    const atAnchor: ResolvedTherapy = resolver ? resolver.at(anchorSec) : unavailableTherapy();
    if (atAnchor.insulinPeakMin !== null || atAnchor.insulinDurationMin !== null) {
      const td = atAnchor.insulinDurationMin ?? params.tdMin;
      const tp = atAnchor.insulinPeakMin ?? (atAnchor.insulinType === 'ultra_rapid' ? params.tpUltraMin : params.tpRapidMin);
      if (tp > 0 && tp < td / 2) {
        params = { ...params, tdMin: td, ...(atAnchor.insulinType === 'ultra_rapid' ? { tpUltraMin: tp } : { tpRapidMin: tp }) };
      }
    }

    const mode = absorptionMode();
    const candidateIsMain = mode === 'active';
    const mainVersion = candidateIsMain ? ABSORPTION_LAYER_VERSION : ENGINE_LAYER_VERSION;
    const built = buildEngineInputs({ mealRows, insulinRows, resolver, params, anchorSec, absorption: candidateIsMain ? 'v2' : 'legacy' });
    const knots: [number, number][] = [];
    for (let m = 0; m <= MAX_HORIZON_MIN; m += STEP_MIN) knots.push([m, Math.round(sigmaFn(m) * 100) / 100]);
    const inputs: RunInputs = {
      layerVersion: mainVersion,
      anchorSec,
      horizonMin: horizon,
      baseline,
      baselineSigmaKnots: knots,
      meals: built.meals,
      insulin: built.insulin,
      links: built.links,
      params,
      excludeMealIds,
      insulinHistory: built.insulinHistory,
    };
    const { layer, points } = computeRun(inputs, { forceApplyIds });
    const allDispositions = [...layer.dispositions, ...built.extraDispositions];

    const timeOf = (e: EventDisposition): number =>
      e.eventType === 'meal'
        ? ((mealRows.find((m) => m.mealId === e.id)?.eatenAtSec) ?? anchorSec)
        : ((insulinRows.find((i) => i.insulinId === e.id)?.administeredAtSec) ?? anchorSec);
    const eventDisplay: ForecastEventDisplay[] = allDispositions.map((d) => ({
      id: d.id,
      type: d.eventType,
      time: toIso(timeOf(d)),
      role: ROLE_DISPLAY[d.role],
      reason: d.reason,
    }));
    const count = (type: 'meal' | 'insulin', role: EventDisposition['role']): number =>
      allDispositions.filter((d) => d.eventType === type && d.role === role).length;
    const availabilityView = {
      mealsUsed: count('meal', 'applied'),
      mealsRangeOnly: count('meal', 'scenario_only'),
      mealsNotUsed: count('meal', 'ignored'),
      insulin: built.insulinHistory,
      insulinDosesUsed: count('insulin', 'applied'),
      insulinDosesRangeOnly: count('insulin', 'scenario_only'),
      insulinOnBoardUnits: layer.iobU === null ? null : Math.round(layer.iobU * 100) / 100,
      carbsOnBoardGrams: layer.cobG === null ? null : Math.round(layer.cobG * 10) / 10,
      therapySettings: (atAnchor.icrStatus === 'available' && atAnchor.isfMgdlPerU !== null ? 'available' : 'unavailable') as 'available' | 'unavailable',
    };

    if (!g.forecastAvailable) {
      notes.push('Nothing is estimated without the glucose forecast, so no glucose line is drawn for your logged meals and insulin yet. They are saved and will be used as soon as it is back.');
      notes.push(...buildNotes({ layer, allDispositions, atAnchor, points: [], counterfactual, built, eventsLoaded: eventsLoaded || !this.db.available, baselineSigmaExtrapolated: true }));
      return {
        status: 'baseline_unavailable',
        anchor,
        reason: g.forecastUnavailableReason ?? 'The glucose forecast is not available right now.',
        mealAware: {
          changedForecast: false,
          counterfactual,
          excludedMealIds: excludeMealIds.filter((id) => mealRows.some((m) => m.mealId === id)),
          availability: availabilityView,
          events: eventDisplay,
          allLoggedCounted: null,
        },
        notes: [...new Set(notes)],
        disclaimer: FORECAST_DISCLAIMER,
      };
    }

    // ---- save before the outcome is known ---------------------------------------------------------
    let saved = false;
    if (eventsLoaded && userId && opts.persist !== false && !counterfactual) {
      try {
        const eligible = isLearningEligible(layer, allDispositions, built.meals, atAnchor, built.insulinHistory);
        const res = await this.store.persist({
          userId,
          inputs,
          inputsHash: hashInputs(inputs, { therapyProfileId: atAnchor.profileId }),
          baselineModel,
          layerModel: `${mainVersion}+${baselineModel}`,
          parameterLabel,
          therapy: atAnchor,
          layer: { ...layer, dispositions: allDispositions },
          points,
          eligible,
          eventLinks: buildEventLinks(allDispositions, mealRows, insulinRows, built.links, built.mealInputs),
          snapshot: { inputs, therapyAtAnchor: { version: atAnchor.version, icrStatus: atAnchor.icrStatus }, eligible },
        });
        saved = res.runId.length > 0;
        if (mode !== 'off') {
          await this.persistShadow({ mode, userId, inputs, mainHash: hashInputs(inputs, { therapyProfileId: atAnchor.profileId }), built, mealRows, insulinRows, resolver, params, anchorSec, atAnchor, baselineModel, parameterLabel, forceApplyIds, layer, allDispositions });
        }
      } catch (err) {
        this.logger.warn(`forecast not saved ${describeDbError(err)}`);
        notes.push('This forecast could not be saved to your history.');
      }
    }

    notes.push(...buildNotes({ layer, allDispositions, atAnchor, points, counterfactual, built, eventsLoaded: eventsLoaded || !this.db.available, baselineSigmaExtrapolated: true }));

    const allLoggedCounted = counterfactual || previewing ? null : buildAllLoggedCounted(inputs, points, allDispositions, anchorSec);
    if (previewing) {
      notes.unshift(
        opts.preview?.meal
          ? 'Preview: this meal is counted here in full but is not saved, and does not count in your forecast, until you confirm it.'
          : 'Preview: the insulin amount you entered is counted here in full but is not saved until you record it.',
      );
    }
    if (allLoggedCounted) notes.push(allCountedNote(allLoggedCounted, points));
    if (candidateIsMain && built.meals.some((m) => m.absorption && m.absorption.source !== 'default' && m.absorption.source !== 'user_class' && allDispositions.some((d) => d.id === m.id && d.role === 'applied'))) {
      notes.push('How fast a meal\'s carbohydrate arrives is estimated from the photo analysis (absorption class, fat, protein, fibre). It is an estimate, not a measurement, and it widens the range.');
    }

    const changed = points.some((p) => Math.abs(p.adjusted - (p.baseline ?? p.adjusted)) >= 0.05);

    return {
      status: 'ok',
      anchor,
      generatedAt: toIso(nowSec),
      horizonMin: horizon,
      stepMin: 5,
      intervalLevel: 0.8,
      points: points.map(toPointDisplay(anchorSec)),
      mealAware: {
        changedForecast: changed,
        counterfactual,
        excludedMealIds: excludeMealIds.filter((id) => mealRows.some((m) => m.mealId === id)),
        availability: availabilityView,
        events: eventDisplay,
        allLoggedCounted,
        ...(previewing ? { preview: { mealId: opts.preview?.meal?.mealId ?? null, insulinUnits: opts.preview?.insulin?.unitsAdministered ?? null } } : {}),
      },
      models: {
        baseline: g.modelVersion,
        eventLayer: mainVersion,
        eventLayerEvidence: eventsLoaded && userId ? await this.personalization.layerEvidence(userId) : { status: 'none_yet', samples: 0 },
      },
      saved,
      ...(previewing ? { preview: true as const } : {}),
      notes: [...new Set(notes)],
      disclaimer: FORECAST_DISCLAIMER,
    };
  }

  /**
   * Computes the OTHER absorption model on the same inputs and stores its forecast as a shadow run, only when it would actually
   * differ (some counted meal has a non-default profile). Failure here never affects the forecast that is shown.
   */
  private async persistShadow(a: {
    mode: AbsorptionMode;
    userId: string;
    inputs: RunInputs;
    mainHash: string;
    built: Built;
    mealRows: MealRow[];
    insulinRows: InsulinRow[];
    resolver: TherapyResolver | null;
    params: EngineParams;
    anchorSec: number;
    atAnchor: ResolvedTherapy;
    baselineModel: string;
    parameterLabel: string;
    forceApplyIds: string[];
    layer: EventLayerResult;
    allDispositions: EventDisposition[];
  }): Promise<void> {
    try {
      const candidateIsMain = a.mode === 'active';
      const alt = buildEngineInputs({ mealRows: a.mealRows, insulinRows: a.insulinRows, resolver: a.resolver, params: a.params, anchorSec: a.anchorSec, absorption: candidateIsMain ? 'legacy' : 'v2' });
      const applied = new Set(a.allDispositions.filter((d) => d.eventType === 'meal' && d.role === 'applied').map((d) => d.id));
      const v2Meals = candidateIsMain ? a.built.meals : alt.meals;
      const differs = v2Meals.some((m) => applied.has(m.id) && m.absorption && absorptionDiffersFromLegacy(m, a.params.tauMMin));
      if (!differs) return;
      const altVersion = candidateIsMain ? ENGINE_LAYER_VERSION : ABSORPTION_LAYER_VERSION;
      const altInputs: RunInputs = { ...a.inputs, layerVersion: altVersion, meals: alt.meals };
      const run = computeRun(altInputs, { forceApplyIds: a.forceApplyIds });
      await this.store.persist({
        userId: a.userId,
        inputs: altInputs,
        inputsHash: hashInputs(altInputs, { therapyProfileId: a.atAnchor.profileId, shadow: true }),
        baselineModel: a.baselineModel,
        layerModel: altVersion + SHADOW_MARKER + '+' + a.baselineModel,
        parameterLabel: a.parameterLabel,
        therapy: a.atAnchor,
        layer: { ...run.layer, dispositions: a.allDispositions },
        points: run.points,
        eligible: false,
        eventLinks: [],
        snapshot: { shadowOf: a.mainHash, inputs: altInputs },
        shadowOfInputsHash: a.mainHash,
      });
    } catch (err) {
      this.logger.warn('shadow forecast not stored ' + describeDbError(err));
    }
  }

  /** Carbohydrate coverage for one meal under the settings that applied at that time (analysis only). */
  async mealCoverage(mealId: string): Promise<MealCoverageView | null> {
    const user = await this.users.primary();
    const meal = await this.events.mealById(user.userId, mealId);
    // a cancelled meal is withdrawn from the history, and a draft is not part of it yet: there is nothing to compare
    if (!meal || meal.status === 'cancelled' || meal.status === 'draft') return null;
    const resolver = await this.therapy.resolver(user.userId, user.timezone);
    const insulin = await this.events.insulinBetween(user.userId, meal.eatenAtSec - 3600, meal.eatenAtSec + 3600);
    const meals = await this.events.mealsBetween(user.userId, meal.eatenAtSec - 3600, meal.eatenAtSec + 3600);
    const links = linkMealsToInsulin(
      meals.map((m) => ({ id: m.mealId, tSec: m.eatenAtSec })),
      insulin.map(toLinkable),
    );
    const link = links.find((l) => l.mealId === mealId);
    if (!link) return null;
    const t = resolver.at(meal.eatenAtSec);
    const coverage = carbCoverage(meal.carbsG, link.unitsTotal, t.icrGPerU);
    return {
      mealId,
      carbsG: meal.carbsG,
      carbsKind: meal.carbsProvenance ?? 'missing',
      insulinRecord:
        link.status === 'confirmed_none' ? 'confirmed_none' : link.status === 'none_recorded' ? 'none_recorded' : link.status === 'ambiguous' ? 'ambiguous' : 'linked',
      insulinUnits: link.unitsTotal,
      ratioStatus: t.icrStatus,
      expectedCoverageG: coverage ? Math.round(coverage.coverageG * 10) / 10 : null,
      carbsMinusCoverageG: coverage ? Math.round(coverage.carbsMinusCoverageG * 10) / 10 : null,
      note:
        'For understanding your history only. It compares what you logged under the ratio you entered; it is not a dose recommendation.',
    };
  }
}

export interface MealCoverageView {
  mealId: string;
  carbsG: number | null;
  carbsKind: 'estimated' | 'user_corrected' | 'user_entered' | 'missing';
  insulinRecord: 'linked' | 'confirmed_none' | 'none_recorded' | 'ambiguous';
  insulinUnits: number | null;
  ratioStatus: 'available' | 'unavailable';
  expectedCoverageG: number | null;
  carbsMinusCoverageG: number | null;
  note: string;
}

const unavailableTherapy = (): ResolvedTherapy => ({
  profileId: null,
  version: null,
  icrStatus: 'unavailable',
  icrGPerU: null,
  isfMgdlPerU: null,
  insulinType: null,
  insulinPeakMin: null,
  insulinDurationMin: null,
});

const toPointDisplay = (anchorSec: number) => (p: ForecastPoint) => ({
  minutes: p.minutes,
  time: toIso(anchorSec + p.minutes * 60),
  baseline: p.baseline,
  adjusted: p.adjusted,
  low: p.low,
  high: p.high,
  extension: p.extension,
  insulinOnBoardUnits: p.insulinOnBoardUnits,
  carbsOnBoardGrams: p.carbsOnBoardGrams,
});

export { declaredMealOf, isRapidActing, toLinkable } from './linkable.js';

/** True when a resolved absorption profile is not the incumbent single gamma(2) component (tau = tauM x speed-class ratio). */
export function absorptionDiffersFromLegacy(m: MealInput, tauMMin: number): boolean {
  const p = m.absorption;
  if (!p) return false;
  return p.phi > 0 || Math.abs(p.tauFastMin - tauMMin * TIME_CLASS_RATIO[m.timeClass]) > 0.5;
}

/** A typed meal for a preview: nothing is stored. */
const adHocMeal = (m: NonNullable<PreviewInput['meal']>, tSec: number): MealRow => ({
  mealId: 'preview-meal',
  clientUuid: 'preview',
  eatenAtSec: tSec,
  status: 'draft',
  carbsG: m.carbsG,
  carbsProvenance: 'user_entered',
  fatG: m.fatG ?? null,
  proteinG: m.proteinG ?? null,
  fiberG: null,
  glycemicIndex: null,
  aiCarbsG: null,
  aiCarbsLowG: null,
  aiCarbsHighG: null,
  eatenAtSource: 'user_entered',
  timingUncertaintyMin: 0,
  absorptionClass: m.absorptionClass ?? 'medium',
  absorptionClassUser: m.absorptionClass !== undefined,
  giConfidence: null,
  absorptionClassAi: null,
  absorptionConfidence: null,
  glycemicLoad: null,
  mealFactors: null,
  featureSchemaVersion: null,
  revision: 1,
  userEdited: false,
  note: null,
  label: null,
});

/** The insulin amount being tried: rapid-acting, taken as stated, named against the previewed meal when there is one. */
const previewDose = (units: number, tSec: number, meal: MealRow | null): InsulinRow => ({
  insulinId: 'preview-dose',
  clientUuid: 'preview',
  administeredAtSec: tSec,
  kind: meal ? 'bolus' : 'correction',
  insulinType: null,
  unitsAdministered: units,
  unitsPlanned: null,
  confirmation: 'confirmed',
  mealId: meal ? meal.mealId : null,
  timingUncertain: false,
  revision: 1,
  status: 'active',
  mealNotCounted: false,
});

interface Built {
  meals: MealInput[];
  mealInputs: Map<string, MealInput>;
  insulin: InsulinInput[];
  links: MealLink[];
  insulinHistory: 'logged' | 'confirmed_none' | 'none_recorded';
  extraDispositions: EventDisposition[];
}

/** Rows -> engine inputs. Pure (no I/O): the same rows always give the same inputs. */
export function buildEngineInputs(a: {
  mealRows: MealRow[];
  insulinRows: InsulinRow[];
  resolver: TherapyResolver | null;
  params: EngineParams;
  anchorSec: number;
  /** 'v2': resolve each meal's absorption profile (absorption.ts); 'legacy' (default): the previous single-component behaviour. The features are recorded either way. */
  absorption?: 'legacy' | 'v2';
}): Built {
  const therapyAt = (t: number): ResolvedTherapy => (a.resolver ? a.resolver.at(t) : unavailableTherapy());
  const meals: MealInput[] = a.mealRows.map((m) => {
    const t = therapyAt(m.eatenAtSec);
    const sigma =
      m.carbsG === null || m.carbsProvenance === null
        ? null
        : carbSigmaG(
            m.carbsG,
            m.carbsProvenance,
            m.carbsProvenance === 'estimated' && m.carbsG === m.aiCarbsG ? m.aiCarbsLowG : null,
            m.carbsProvenance === 'estimated' && m.carbsG === m.aiCarbsG ? m.aiCarbsHighG : null,
            a.params.cC,
          );
    const features: AbsorptionFeatures = {
      legacyClass: m.absorptionClass,
      legacyClassIsUserSet: m.absorptionClassUser,
      aiClass: m.absorptionClassAi,
      aiConfidence: m.absorptionConfidence,
      giEstimate: m.glycemicIndex,
      giConfidence: m.giConfidence,
      fatG: m.fatG,
      proteinG: m.proteinG,
      fiberG: m.fiberG,
    };
    return {
      id: m.mealId,
      revision: m.revision,
      tSec: m.eatenAtSec,
      carbsG: m.carbsG,
      carbsSigmaG: sigma,
      fatG: m.fatG,
      proteinG: m.proteinG,
      provenance: m.carbsProvenance,
      timeClass: m.absorptionClass,
      timingUncertaintyMin: m.timingUncertaintyMin,
      icrGPerU: t.icrGPerU,
      isfMgdlPerU: t.isfMgdlPerU,
      absorptionFeatures: features,
      ...(a.absorption === 'v2' ? { absorption: resolveAbsorptionProfile(features, a.params.tauMMin) } : {}),
    };
  });

  const extraDispositions: EventDisposition[] = [];
  const insulin: InsulinInput[] = [];
  for (const i of a.insulinRows) {
    const t = therapyAt(i.administeredAtSec);
    if (i.confirmation === 'planned') {
      extraDispositions.push({ eventType: 'insulin', id: i.insulinId, role: 'ignored', reason: 'planned_not_delivered' });
    } else if (i.kind !== 'bolus' && i.kind !== 'correction') {
      extraDispositions.push({
        eventType: 'insulin',
        id: i.insulinId,
        role: 'ignored',
        reason: i.unitsAdministered === 0 && i.confirmation === 'confirmed' ? 'confirmed_no_insulin' : 'not_a_meal_bolus',
      });
    } else if (!isRapidActing(i.insulinType)) {
      extraDispositions.push({ eventType: 'insulin', id: i.insulinId, role: 'ignored', reason: 'not_rapid_acting' });
    } else if (i.unitsAdministered === null || i.unitsAdministered <= 0) {
      extraDispositions.push({
        eventType: 'insulin',
        id: i.insulinId,
        role: 'ignored',
        reason: i.unitsAdministered === 0 && i.confirmation === 'confirmed' ? 'confirmed_no_insulin' : 'units_unknown',
      });
    } else {
      insulin.push({
        id: i.insulinId,
        revision: i.revision,
        tSec: i.administeredAtSec,
        units: i.unitsAdministered,
        kind: i.kind,
        ultraRapid: i.insulinType === 'ultra_rapid' || (i.insulinType === null && t.insulinType === 'ultra_rapid'),
        uncertain: i.confirmation === 'uncertain' || i.timingUncertain,
        isfMgdlPerU: t.isfMgdlPerU,
        declaredMealId: declaredMealOf(i),
      });
    }
  }

  const links = linkMealsToInsulin(
    a.mealRows.map((m) => ({ id: m.mealId, tSec: m.eatenAtSec })),
    a.insulinRows.map(toLinkable),
  );

  // Insulin history behind the anchor. "Nothing recorded" is unknown, never zero.
  const windowStart = a.anchorSec - a.params.tdMin * 60;
  const inWindow = (i: InsulinRow) => i.administeredAtSec >= windowStart;
  const hasDose = a.insulinRows.some((i) => inWindow(i) && i.confirmation !== 'planned' && (i.unitsAdministered ?? 0) > 0 && i.kind !== 'basal' && isRapidActing(i.insulinType));
  const hasZero = a.insulinRows.some((i) => inWindow(i) && i.confirmation === 'confirmed' && i.unitsAdministered === 0);
  const insulinHistory = hasDose ? 'logged' : hasZero ? 'confirmed_none' : 'none_recorded';

  return { meals, mealInputs: new Map(meals.map((m) => [m.id, m])), insulin, links, insulinHistory, extraDispositions };
}

/**
 * A run may teach the personal scales only when every logged event in it is trustworthy: carbohydrates
 * known, settings present, insulin relationship known (declared, single in-window dose, or confirmed none),
 * timing within 15 minutes, no uncertain doses, nothing left as "range only" or ignored for lack of data.
 */
export function isLearningEligible(
  layer: EventLayerResult,
  dispositions: readonly EventDisposition[],
  meals: readonly MealInput[],
  therapy: ResolvedTherapy,
  insulinHistory: 'logged' | 'confirmed_none' | 'none_recorded',
): boolean {
  if (layer.appliedMeals + layer.appliedInsulin === 0) return false;
  if (insulinHistory === 'none_recorded') return false;
  if (therapy.icrStatus !== 'available' || therapy.isfMgdlPerU === null) return false;
  if (dispositions.some((d) => d.role === 'scenario_only' || d.role === 'excluded')) return false;
  // counted in the line, but their insulin / meal relationship is a guess: never a training example
  if (dispositions.some((d) => d.reason === 'dose_without_recorded_meal' || d.reason === 'insulin_link_ambiguous')) return false;
  if (dispositions.some((d) => d.role === 'ignored' && ['carbs_unknown', 'therapy_settings_missing', 'isf_missing', 'units_unknown'].includes(d.reason))) return false;
  const applied = new Set(dispositions.filter((d) => d.role === 'applied').map((d) => d.id));
  if (meals.some((m) => applied.has(m.id) && m.timingUncertaintyMin > 15)) return false;
  return true;
}

function buildEventLinks(
  dispositions: readonly EventDisposition[],
  mealRows: readonly MealRow[],
  insulinRows: readonly InsulinRow[],
  links: readonly MealLink[],
  mealInputs: ReadonlyMap<string, MealInput>,
): EventLinkRecord[] {
  const out: EventLinkRecord[] = [];
  for (const d of dispositions) {
    if (d.eventType === 'meal') {
      const m = mealRows.find((x) => x.mealId === d.id);
      if (!m) continue;
      const link = links.find((l) => l.mealId === d.id);
      const icr = mealInputs.get(d.id)?.icrGPerU ?? null;
      out.push({
        disposition: d,
        eventTimeSec: m.eatenAtSec,
        revision: m.revision,
        carbsG: m.carbsG,
        carbsProvenance: m.carbsProvenance,
        insulinUnits: null,
        insulinConfirmation: null,
        linkStatus: link?.status ?? null,
        linkedInsulinId: link?.insulinIds[0] ?? null,
        coverage: carbCoverage(m.carbsG, link?.unitsTotal ?? null, icr),
      });
    } else {
      const i = insulinRows.find((x) => x.insulinId === d.id);
      if (!i) continue;
      out.push({
        disposition: d,
        eventTimeSec: i.administeredAtSec,
        revision: i.revision,
        carbsG: null,
        carbsProvenance: null,
        insulinUnits: i.unitsAdministered,
        insulinConfirmation: i.confirmation,
        linkStatus: null,
        linkedInsulinId: null,
        coverage: null,
      });
    }
  }
  return out;
}

/**
 * The what-if line: the same engine with every logged dose and meal counted in full. Pure; nothing is stored. Null when no entry is
 * left out of the main line, or when counting them would hardly move it (for example a dose that finished acting hours ago).
 */
export function buildAllLoggedCounted(
  inputs: RunInputs,
  main: readonly ForecastPoint[],
  dispositions: readonly EventDisposition[],
  anchorSec: number,
): AllLoggedCountedDisplay | null {
  const left = dispositions.filter((d) => d.role === 'scenario_only');
  if (left.length === 0) return null;
  const { points } = computeRun(inputs, { applyAll: true });
  if (points.length === 0) return null;
  const gap = Math.max(...points.map((p) => Math.abs(p.adjusted - (main.find((m) => m.minutes === p.minutes)?.adjusted ?? p.adjusted))));
  if (gap < ALL_COUNTED_MIN_DIFF_MGDL) return null;
  const lowest = points.reduce((a, p) => (p.adjusted < a.adjusted ? p : a), points[0] as ForecastPoint);
  const highest = points.reduce((a, p) => (p.adjusted > a.adjusted ? p : a), points[0] as ForecastPoint);
  return {
    description: ALL_LOGGED_COUNTED_DESCRIPTION,
    points: points.map((p) => ({ minutes: p.minutes, time: toIso(anchorSec + p.minutes * 60), adjusted: p.adjusted, low: p.low, high: p.high })),
    summary: {
      lowestMgdl: lowest.adjusted,
      lowestAtMin: lowest.minutes,
      highestMgdl: highest.adjusted,
      highestAtMin: highest.minutes,
      lowestRangeEdgeMgdl: Math.min(...points.map((p) => p.low)),
    },
    countedEntries: left.map((d) => ({ id: d.id, type: d.eventType, reason: d.reason })),
  };
}

/** One plain sentence about the direction in which the what-if line differs most from the main line. */
function allCountedNote(w: AllLoggedCountedDisplay, main: readonly ForecastPoint[]): string {
  const mainAt = (minutes: number): number => main.find((m) => m.minutes === minutes)?.adjusted ?? 0;
  const below = mainAt(w.summary.lowestAtMin) - w.summary.lowestMgdl;
  const above = w.summary.highestMgdl - mainAt(w.summary.highestAtMin);
  const head = 'What-if, not a prediction: if every dose and meal you logged counted in full and nothing else were eaten or taken, ';
  if (below >= above) {
    return head + 'the line would fall to about ' + Math.round(w.summary.lowestMgdl) + ' mg/dL around +' + w.summary.lowestAtMin + ' min (range down to ' + Math.round(w.summary.lowestRangeEdgeMgdl) + ').';
  }
  return head + 'the line would rise to about ' + Math.round(w.summary.highestMgdl) + ' mg/dL around +' + w.summary.highestAtMin + ' min.';
}

function buildNotes(a: {
  layer: EventLayerResult;
  allDispositions: readonly EventDisposition[];
  atAnchor: ResolvedTherapy;
  points: readonly ForecastPoint[];
  counterfactual: boolean;
  built: Built;
  eventsLoaded: boolean;
  baselineSigmaExtrapolated: boolean;
}): string[] {
  const notes: string[] = [];
  const reasons = new Set(a.allDispositions.map((d) => d.reason));
  if (a.counterfactual) {
    notes.push(
      'What-if view: the selected meals are left out. Insulin you recorded is still counted. This is not a prediction of what will happen.',
    );
  }
  if (reasons.has('therapy_settings_missing') || reasons.has('isf_missing')) {
    notes.push('Insulin-to-carbohydrate ratio or correction factor is not set, so logged meals are not added to the forecast.');
  }
  if (reasons.has('carbs_unknown')) notes.push('A logged meal has no carbohydrate amount, so it is not used.');
  if (reasons.has('insulin_not_recorded')) {
    notes.push('A meal has no insulin recorded. The forecast does not assume any was taken or not taken; the range is widened upward instead.');
  }
  if (reasons.has('insulin_link_ambiguous')) {
    notes.push('A dose could belong to more than one meal. The meals and the dose are all counted, but not matched to each other; say which meal it was for to tighten the range.');
  }
  if (reasons.has('dose_without_recorded_meal')) {
    notes.push('An insulin dose has no meal recorded with it, so it is counted as lowering glucose. If it covered food you have not logged, glucose will end higher than the line; the range reaches up to the glucose-only forecast.');
  }
  if (reasons.has('planned_not_delivered')) notes.push('A planned dose is not counted until you record that it was taken.');
  if (reasons.has('not_a_meal_bolus')) notes.push('Basal and other non-meal insulin entries are not used as a meal dose.');
  if (a.built.insulinHistory === 'none_recorded') {
    notes.push('No insulin is recorded recently, so active insulin is unknown (not zero).');
  }
  if (a.built.meals.some((m) => m.timingUncertaintyMin > 0) && a.layer.appliedMeals > 0) {
    notes.push('Meal timing is approximate, which widens the range.');
  }
  if (a.points.some((p) => p.extension)) {
    notes.push('After 2 hours the glucose model has no forecast; only logged meals and insulin change the line, and the range keeps widening.');
  }
  if (a.points.some((p) => p.clipped)) notes.push('Values are limited to 20-500 mg/dL for display.');
  if (!a.eventsLoaded) notes.push('Logged events were not available.');
  return notes;
}
