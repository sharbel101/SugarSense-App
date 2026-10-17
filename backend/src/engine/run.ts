import { createHash } from 'node:crypto';
import { composeForecast, type BaselinePoint, type ForecastPoint } from './compose.js';
import { computeEventLayer } from './event-layer.js';
import { ENGINE_LAYER_VERSION, STEP_MIN } from './params.js';
import type { EngineParams, EventLayerResult, InsulinInput, MealInput, MealLink } from './types.js';

/**
 * Everything a forecast depends on, as plain serialisable data. Stored verbatim with each forecast run
 * (CLAUDE.md section 3, invariant 4): replaying it later gives the identical forecast, which is also how
 * late, edited and excluded events are handled - nothing is patched, the window is recomputed.
 */
export interface RunInputs {
  layerVersion: string;
  anchorSec: number;
  horizonMin: number;
  /** Glucose-only model output, 5-minute grid from the anchor. */
  baseline: BaselinePoint[];
  /** Knots (minutes, 1-sigma mg/dL) of the baseline error curve used for this run. */
  baselineSigmaKnots: [number, number][];
  meals: MealInput[];
  insulin: InsulinInput[];
  links: MealLink[];
  params: EngineParams;
  excludeMealIds: string[];
  insulinHistory: 'logged' | 'confirmed_none' | 'none_recorded';
}

export function sigmaFromKnots(knots: readonly [number, number][]): (minutes: number) => number {
  return (minutes) => {
    if (knots.length === 0) return 0;
    const first = knots[0] as [number, number];
    if (minutes <= first[0]) return first[1];
    for (let i = 1; i < knots.length; i += 1) {
      const [x1, y1] = knots[i] as [number, number];
      const [x0, y0] = knots[i - 1] as [number, number];
      if (minutes <= x1) return y0 + ((y1 - y0) * (minutes - x0)) / (x1 - x0);
    }
    return (knots[knots.length - 1] as [number, number])[1];
  };
}

/** Pure: same RunInputs, same output. `applyAll` is the what-if view (see LayerInput); it is not part of RunInputs and is never stored. */
export function computeRun(inputs: RunInputs, opts: { applyAll?: boolean } = {}): { layer: EventLayerResult; points: ForecastPoint[] } {
  const layer = computeEventLayer({
    anchorSec: inputs.anchorSec,
    horizonMin: inputs.horizonMin,
    stepMin: STEP_MIN,
    meals: inputs.meals,
    insulin: inputs.insulin,
    links: inputs.links,
    params: inputs.params,
    excludeMealIds: new Set(inputs.excludeMealIds),
    insulinHistory: inputs.insulinHistory,
    ...(opts.applyAll ? { applyAll: true } : {}),
  });
  const points = composeForecast({
    baseline: inputs.baseline,
    layer,
    sigmaBaseline: sigmaFromKnots(inputs.baselineSigmaKnots),
    horizonMin: inputs.horizonMin,
  });
  return { layer, points };
}

/** Stable identity of a run's inputs: retries and unchanged polls hash the same, any real change differs. */
export function hashInputs(inputs: RunInputs, extra: Record<string, unknown> = {}): string {
  const canonical = JSON.stringify({ ...inputs, ...extra });
  return createHash('sha256').update(canonical).digest('hex');
}

export { ENGINE_LAYER_VERSION };
