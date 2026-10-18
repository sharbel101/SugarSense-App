import { useNavigation } from '@react-navigation/native';
import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { buildGlucoseChart } from '../services/glucoseChart';
import { GlucoseChart } from './GlucoseChart';
import type { ForecastOkDisplay } from '../api/forecastContract';
import type { GlucoseOk } from '../api/glucoseContract';
import { describeForecastForScreenReader, buildForecastChart, type EventMarker, type ForecastChartModel } from '../services/forecastChart';
import { useEvents } from '../services/EventsProvider';
import { useForecast } from '../services/ForecastProvider';
import { forecastPrompts, formatCarbsOnBoard, formatInsulinOnBoard, type OnBoardChip } from '../services/forecastView';
import { formatTime12 } from '../services/clock12';
import { findMealRef } from '../services/mealRefs';
import { insulinSourceRows, mealSourceRows, SOURCE_WINDOW_HOURS, type SourceRow } from '../services/onBoardSources';
import { formatClock } from '../services/glucoseState';
import { radius, touch, useColors } from '../theme';
import { useQuickAdd } from './QuickAdd';

export type ForecastChartState = {
  /** The server's 3-hour forecast, when it is usable. */
  forecast: ForecastOkDisplay | null;
  chart: ForecastChartModel | null;
  /** Set when the forecast shown is an earlier one (the latest refresh failed). */
  asOf: string | null;
  /** The server cannot give a meal-aware forecast: the caller draws the glucose-only line. */
  fallback: boolean;
  /** Server reason when there is no forecast line but the history still shows. */
  noForecastReason: string | null;
  markerLabel: (m: EventMarker) => string;
  accessibilityLabel: string | null;
};

/** Builds the forecast chart from GET /glucose (history) + GET /forecast, with matching marker text. */
export function useForecastChart(data: GlucoseOk | null): ForecastChartState {
  const { view } = useForecast();
  const { recent, records } = useEvents();

  const forecast = view.kind === 'ok' ? view.data : null;
  const chart = useMemo(() => (data && forecast ? buildForecastChart(data, forecast) : null), [data, forecast]);

  const markerLabel = useCallback(
    (m: EventMarker): string => {
      const ev = forecast?.mealAware.events.find((e) => e.id === m.id);
      const meals = recent.kind === 'ok' ? recent.meals : [];
      const insulin = recent.kind === 'ok' ? recent.insulin : [];
      if (m.type === 'meal') {
        const ref = findMealRef(records, meals, m.id);
        const grams = ref?.carbsG != null ? `${Math.round(ref.carbsG)} g` : 'carbs unknown';
        const note = ev?.reason === 'insulin_not_recorded' ? ' - insulin not recorded' : ev?.role === 'used' ? ' - used' : ev?.role === 'range_only' ? ' - widens the range only' : ' - not used';
        return `Meal, ${grams}${note}`;
      }
      const v = insulin.find((i) => i.id === m.id);
      const units = v?.unitsTaken != null ? `${v.unitsTaken} U` : 'amount unknown';
      return `Insulin ${units} - ${ev?.role === 'used' ? 'used' : ev?.role === 'range_only' ? 'widens the range only' : 'not used'}`;
    },
    [forecast, recent, records],
  );

  return {
    forecast,
    chart,
    asOf: view.kind === 'ok' ? view.asOf : null,
    fallback: view.kind === 'fallback' || view.kind === 'loading',
    noForecastReason: view.kind === 'baseline_unavailable' ? view.data.reason : view.kind === 'stale' || view.kind === 'unavailable' ? view.reason : null,
    markerLabel,
    accessibilityLabel: forecast ? describeForecastForScreenReader(forecast) : null,
  };
}

function Chip({ chip, onPress, active }: { chip: OnBoardChip; onPress: () => void; active: boolean }) {
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${chip.label}: ${chip.value}, ${chip.caption}. Tap to see where it comes from.`}
      aria-expanded={active}
      style={{
        flex: 1,
        minHeight: touch.min,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: radius.row,
        backgroundColor: colors.surface,
        borderWidth: active ? 2 : 1,
        borderColor: active ? colors.blue600 : colors.border,
      }}
    >
      <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 13, color: colors.ink2 }}>{chip.label}</Text>
      <Text style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 17, color: chip.known ? colors.ink : colors.ink3 }}>{chip.value}</Text>
      <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 13, color: colors.ink2 }}>{chip.caption}</Text>
    </Pressable>
  );
}

/**
 * Insulin and carbs on board at the latest reading, straight from the server (null = unknown, never 0).
 * Tapping a chip lists where the number comes from: the doses taken and the carbs entered in the last
 * 12 hours, newest first, with how the forecast used each one.
 */
export function OnBoardChips({ forecast }: { forecast: ForecastOkDisplay }) {
  const colors = useColors();
  const { recent, refreshRecent } = useEvents();
  const { open: openSheet } = useQuickAdd();
  const [openChip, setOpenChip] = useState<'insulin' | 'carbs' | null>(null);
  // The moment the list was opened: "3 h ago" is worked out from it, and it is set from the tap, not from render.
  const [openedAtMs, setOpenedAtMs] = useState(() => Date.now());
  const a = forecast.mealAware.availability;
  const toggle = (which: 'insulin' | 'carbs') => {
    if (openChip !== which) {
      refreshRecent();
      setOpenedAtMs(Date.now());
    }
    setOpenChip((current) => (current === which ? null : which));
  };

  const rows: SourceRow[] =
    openChip === null || recent.kind !== 'ok'
      ? []
      : openChip === 'insulin'
        ? insulinSourceRows(recent.insulin, forecast.mealAware.events, openedAtMs)
        : mealSourceRows(recent.meals, forecast.mealAware.events, openedAtMs);
  const insulinChip = formatInsulinOnBoard(a);
  const carbsChip = formatCarbsOnBoard(a);
  const noun = openChip === 'insulin' ? 'doses' : 'meals';

  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Chip chip={insulinChip} onPress={() => toggle('insulin')} active={openChip === 'insulin'} />
        <Chip chip={carbsChip} onPress={() => toggle('carbs')} active={openChip === 'carbs'} />
      </View>
      {openChip !== null ? (
        <View style={{ backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.row, padding: 14, gap: 10 }}>
          <Text accessibilityRole="header" style={{ fontFamily: 'Manrope_700Bold', fontSize: 15, color: colors.ink }}>
            {openChip === 'insulin' ? 'Doses you logged' : 'Carbs you entered'} · last {SOURCE_WINDOW_HOURS} hours
          </Text>
          <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, lineHeight: 20 }}>
            {openChip === 'insulin'
              ? 'Insulin on board is the part of the doses you logged that is still to act, estimated by the server from a standard action curve.'
              : 'Carbs on board is the part of the meals you entered that is not yet absorbed, estimated by the server from your entries.'}
          </Text>
          {recent.kind === 'ok' && rows.length === 0 ? (
            <Text accessibilityLiveRegion="polite" style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink, lineHeight: 20 }}>
              {`No ${noun} logged in the last ${SOURCE_WINDOW_HOURS} hours.${(openChip === 'insulin' ? !insulinChip.known : !carbsChip.known) ? ' So the amount on board is unknown.' : ''}`}
            </Text>
          ) : null}
          {recent.kind === 'loading' || recent.kind === 'idle' ? (
            <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2 }}>Loading what you logged...</Text>
          ) : null}
          {recent.kind === 'unavailable' ? (
            <Text accessibilityLiveRegion="polite" style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink, lineHeight: 20 }}>
              The list of what you logged could not be loaded right now. Nothing is shown rather than guessing.
            </Text>
          ) : null}
          {rows.map((row, i) => (
            <SourceRowView key={row.id} row={row} first={i === 0} />
          ))}
          <Pressable
            onPress={() => openSheet({ mode: 'list' })}
            accessibilityRole="button"
            accessibilityLabel="See everything you logged"
            style={{ minHeight: touch.min, justifyContent: 'center' }}
          >
            <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 14, color: colors.blue600 }}>See everything you logged</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function SourceRowView({ row, first }: { row: SourceRow; first: boolean }) {
  const colors = useColors();
  return (
    <View
      accessible
      accessibilityLabel={`${row.title}, ${row.detail}, ${formatTime12(new Date(row.timeIso))}, ${row.ago}${row.status ? `, ${row.status}` : ''}`}
      style={{ gap: 2, paddingTop: first ? 0 : 10, borderTopWidth: first ? 0 : 1, borderTopColor: colors.divider }}
    >
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <Text style={{ flexShrink: 1, fontFamily: 'Manrope_800ExtraBold', fontSize: 16, color: colors.ink }}>{row.title}</Text>
        <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 14, color: colors.ink }}>{formatTime12(new Date(row.timeIso))}</Text>
      </View>
      <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, lineHeight: 20 }} numberOfLines={3}>
        {row.detail}
      </Text>
      <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink2 }}>
        {row.ago}
        {row.status ? ` · ${row.status}` : ''}
      </Text>
    </View>
  );
}

/** What the model is missing, with the action that fixes it. */
export function ForecastPrompts({ forecast }: { forecast: ForecastOkDisplay }) {
  const colors = useColors();
  const nav = useNavigation();
  const { open } = useQuickAdd();
  const { records, recent } = useEvents();
  const prompts = forecastPrompts(forecast);
  if (prompts.length === 0) return null;
  const mealFor = (id: string | null) => (id ? findMealRef(records, recent.kind === 'ok' ? recent.meals : [], id, -new Date().getTimezoneOffset()) : null);

  return (
    <View style={{ gap: 8 }}>
      {prompts.map((p) => {
        const warning = p.kind === 'meal_without_insulin';
        const meal = warning ? mealFor(p.eventId) : null;
        const action: { label: string; run: () => void } | null =
          p.kind === 'set_ratio'
            ? { label: 'Settings', run: () => nav.navigate('InsulinSettings' as never) }
            : warning
              ? { label: 'Add insulin', run: () => open(meal ? { mode: 'insulin', meal } : { mode: 'insulin' }) }
              : null;
        return (
          <View
            key={p.kind}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
              backgroundColor: warning ? colors.red100 : colors.amber100,
              borderRadius: radius.row,
              paddingLeft: 14,
              paddingRight: 6,
              minHeight: touch.min,
            }}
          >
            <Text
              accessibilityRole={warning ? 'alert' : undefined}
              style={{ flex: 1, paddingVertical: 8, fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: warning ? colors.red600 : colors.amberDark, lineHeight: 20 }}
            >
              {p.text}
            </Text>
            {action ? (
              <Pressable
                onPress={action.run}
                accessibilityRole="button"
                accessibilityLabel={`${action.label}: ${p.text}`}
                style={{ minHeight: touch.min, paddingHorizontal: 10, justifyContent: 'center' }}
              >
                <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 14, color: warning ? colors.red600 : colors.amberDark, textDecorationLine: 'underline' }}>
                  {action.label}
                </Text>
              </Pressable>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

/** Legend for the lines actually drawn. */
export function ForecastLegend({ chart }: { chart: ForecastChartModel }) {
  const colors = useColors();
  const item = (color: string, label: string, kind: 'line' | 'dash' | 'band') => (
    <View key={label} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
      <View
        style={{
          width: kind === 'band' ? 10 : 14,
          height: kind === 'band' ? 10 : 2,
          borderRadius: 2,
          backgroundColor: color,
          opacity: kind === 'band' ? 0.35 : kind === 'dash' ? 0.7 : 1,
        }}
      />
      <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 13, color: colors.ink2 }}>{label}</Text>
    </View>
  );
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 14, rowGap: 4, marginTop: 8 }}>
      {item(colors.blue700, 'Measured', 'line')}
      {item(colors.blue500, 'Forecast', 'dash')}
      {chart.hasBaselineLine ? item(colors.ink4, 'Glucose-only', 'line') : null}
      {chart.hasBand ? item(colors.blue500, '80% range', 'band') : null}
    </View>
  );
}

/** "Based on 1 meal and 1 insulin dose you logged." - counts straight from the server's availability. */
function basedOn(f: ForecastOkDisplay): string {
  const a = f.mealAware.availability;
  const meals = a.mealsUsed + a.mealsRangeOnly;
  const doses = a.insulinDosesUsed + a.insulinDosesRangeOnly;
  if (meals + doses === 0) return 'Based on your glucose history. Nothing logged is included.';
  const parts: string[] = [];
  if (meals > 0) parts.push(`${meals} meal${meals === 1 ? '' : 's'}`);
  if (doses > 0) parts.push(`${doses} insulin dose${doses === 1 ? '' : 's'}`);
  return `Based on ${parts.join(' and ')} you logged.`;
}

/** Quiet status lines, notes and the disclaimer under the chart. */
export function ForecastFooter({ state }: { state: ForecastChartState }) {
  const colors = useColors();
  const [showNotes, setShowNotes] = useState(false);
  const f = state.forecast;
  const small = { fontFamily: 'Manrope_500Medium', fontSize: 13, color: colors.ink3, lineHeight: 18 } as const;
  return (
    <View style={{ gap: 8, marginTop: 8 }}>
      {state.asOf ? <Text style={small}>Forecast as of {formatClock(state.asOf)}. The latest refresh did not come through.</Text> : null}
      {state.fallback ? <Text style={small}>Meal and insulin entries are not included right now.</Text> : null}
      {state.noForecastReason ? <Text style={small}>{state.noForecastReason}</Text> : null}
      {f && f.saved === false && !f.mealAware.counterfactual ? <Text style={small}>This forecast was not saved to your history.</Text> : null}
      {f ? <Text style={small}>{basedOn(f)} As of {formatClock(f.anchor.measuredAt)}.</Text> : null}
      {f && state.chart?.hasExtension ? <Text style={small}>After 2 h only what you logged moves the line.</Text> : null}
      {f && f.notes.length > 0 ? (
        <>
          <Pressable
            onPress={() => setShowNotes((v) => !v)}
            accessibilityRole="button"
            aria-expanded={showNotes}
            accessibilityLabel={`About this forecast, ${f.notes.length} notes`}
            style={{ minHeight: touch.min, justifyContent: 'center' }}
          >
            <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.blue600 }}>
              About this forecast ({f.notes.length}) {showNotes ? '▲' : '▼'}
            </Text>
          </Pressable>
          {showNotes ? f.notes.map((n, i) => <Text key={i} style={small}>{n}</Text>) : null}
        </>
      ) : null}
      {f ? <Text style={small}>{f.disclaimer}</Text> : null}
    </View>
  );
}

/**
 * Chart + prompts + on-board chips + legend + notes for one screen. Uses the server's meal-aware
 * 3-hour forecast when it is usable; otherwise falls back to the glucose-only line from GET /glucose
 * (the previous behaviour) and says that meal and insulin entries are not included.
 */
export function ForecastChartBlock({ data, height, compact = false }: { data: GlucoseOk; height: number; compact?: boolean }) {
  const colors = useColors();
  const state = useForecastChart(data);
  const old = useMemo(() => buildGlucoseChart(data), [data]);
  const fc = state.chart;

  const common = { viewBoxWidth: old.viewBoxWidth, viewBoxHeight: old.viewBoxHeight, height };
  return (
    <View>
      {state.forecast && !compact ? <ForecastPrompts forecast={state.forecast} /> : null}
      <View style={{ marginTop: state.forecast && !compact ? 12 : 0 }}>
        {fc && state.forecast ? (
          <GlucoseChart
            {...common}
            actual={fc.actual}
            predicted={fc.predicted}
            extension={fc.extension}
            baselineLine={fc.hasBaselineLine ? fc.baselineLine : undefined}
            band={fc.band}
            nowX={fc.nowX}
            gridLinesY={fc.gridLinesY}
            xTicks={fc.xTicks}
            yTicks={fc.yTicks}
            forecastPoints={fc.forecastPoints}
            markers={fc.markers}
            markerLabel={state.markerLabel}
            accessibilityLabel={`Glucose over the last hour. ${state.accessibilityLabel ?? ''}`}
          />
        ) : (
          <GlucoseChart
            {...common}
            actual={old.actual}
            predicted={old.predicted}
            band={old.band}
            nowX={old.nowX}
            gridLinesY={old.gridLinesY}
            xTicks={old.xTicks}
            yTicks={old.yTicks}
            forecastPoints={old.forecastPoints}
            accessibilityLabel={
              old.hasForecast
                ? `Glucose over the last hour with the forecast for the next 2 hours. Latest reading ${Math.round(data.glucoseMgdl)} milligrams per decilitre. Meal and insulin entries are not included.`
                : `Glucose over the last hour. Latest reading ${Math.round(data.glucoseMgdl)} milligrams per decilitre. No forecast available.`
            }
          />
        )}
      </View>
      {fc ? (
        <ForecastLegend chart={fc} />
      ) : (
        <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 13, color: colors.ink2, marginTop: 10 }}>
          {old.hasForecast
            ? 'Measured, and a glucose-only forecast line.'
            : `Forecast unavailable${data.forecastUnavailableReason ? `: ${data.forecastUnavailableReason}` : '.'}`}
        </Text>
      )}
      {state.forecast && !compact ? (
        <View style={{ marginTop: 12 }}>
          <OnBoardChips forecast={state.forecast} />
        </View>
      ) : null}
      <ForecastFooter state={state} />
    </View>
  );
}
