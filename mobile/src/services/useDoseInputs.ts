import { useMemo } from 'react';
import type { GlucoseInput, SavedTherapy } from './doseEstimate';
import { useForecast } from './ForecastProvider';
import { useGlucose } from './GlucoseProvider';
import { useTargetGlucose } from './targetGlucose';
import { useSavedTherapy } from './useSavedRatio';

export type DoseInputs = {
  loading: boolean;
  therapy: SavedTherapy;
  /** Insulin type saved in settings (rapid / ultra_rapid), or null. */
  insulinType: 'rapid' | 'ultra_rapid' | null;
  targetMgdl: number | null;
  glucose: GlucoseInput | null;
  /** IOB the server reports for the LOGGED doses; null = unknown. */
  iobUnits: number | null;
};

/** Everything the dose calculation reads, from where each value really lives (nothing defaulted). */
export function useDoseInputs(): DoseInputs {
  const therapyState = useSavedTherapy();
  const target = useTargetGlucose();
  const { view } = useGlucose();
  const { view: forecast } = useForecast();

  const glucose = useMemo<GlucoseInput | null>(
    () => (view.kind === 'ok' ? { mgdl: view.data.glucoseMgdl, ageMinutes: view.ageMinutes, trendMgdlPerMin: view.data.trendMgdlPerMin } : null),
    [view],
  );
  const iobUnits = forecast.kind === 'ok' ? forecast.data.mealAware.availability.insulinOnBoardUnits : null;

  return {
    loading: therapyState.loading || target.loading,
    therapy: therapyState.loading ? null : therapyState.therapy,
    insulinType: therapyState.loading ? null : therapyState.insulinType,
    targetMgdl: target.target,
    glucose,
    iobUnits,
  };
}
