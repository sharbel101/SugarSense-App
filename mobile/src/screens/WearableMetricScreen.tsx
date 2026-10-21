import { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useMemo, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BackButton } from '../components/Buttons';
import { Card } from '../components/Card';
import { SegmentedControl } from '../components/SegmentedControl';
import { BarChart, LineChart } from '../components/wearable/Charts';
import { RangeBar } from '../components/wearable/Gauges';
import { garminErrorText } from '../api/garminContract';
import { BigValue, FreshnessLine, SectionLabel, StateMessage, StatusChip, SyncBanner } from '../components/wearable/Parts';
import { RootStackParamList } from '../navigation/types';
import { useWearable } from '../services/useWearable';
import {
  availableRanges,
  DAY,
  formatNumber,
  formatSleep,
  gapLimit,
  hasGap,
  HOUR,
  minMax,
  RANGE_LABEL,
  RANGE_MS,
  summaryOf,
  trendText,
  windowOf,
  type MetricKey,
  METRICS,
  type RangeKey,
  type WearableData,
} from '../services/wearableModel';
import { radius, spacing, useColors } from '../theme';

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * One metric in detail: latest value and freshness, a chart with a range control (only the ranges that have
 * real data), the person's own usual range when it exists, a trend line computed from the data, and what the
 * metric measures. Gaps in the data are left as gaps. Nothing is interpolated or estimated.
 */
export function WearableMetricScreen({ navigation, route }: NativeStackScreenProps<RootStackParamList, 'WearableMetric'>) {
  const colors = useColors();
  const { data, now, error, loading, refresh } = useWearable();
  if (data === null) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.ground }}>
        <View style={{ paddingHorizontal: spacing.xl, paddingTop: spacing.lg, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <BackButton onPress={() => navigation.goBack()} accessibilityLabel="Back to Wearable" />
          <Text accessibilityRole="header" style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 20, color: colors.ink }}>
            {METRICS[route.params.metric].label}
          </Text>
        </View>
        <View style={{ padding: spacing.xl }}>
          {error ? <StateMessage title="Garmin data unavailable" text={garminErrorText(error)} onRetry={refresh} busy={loading} /> : <StateMessage title="Loading" text="Reading your latest measurements." busy />}
        </View>
      </SafeAreaView>
    );
  }
  return <MetricBody metric={route.params.metric} data={data} now={now} onBack={() => navigation.goBack()} />;
}

function MetricBody({ metric, data, now, onBack }: { metric: MetricKey; data: WearableData; now: number; onBack: () => void }) {
  const colors = useColors();
  const key: MetricKey = metric;
  const sum = useMemo(() => summaryOf(data, key, now), [data, key, now]);
  const info = sum.info;
  const isSteps = key === 'steps';
  const isSleep = key === 'sleep';
  const today = startOfDay(now);

  const ranges = useMemo<RangeKey[]>(() => {
    if (isSteps) {
      const r: RangeKey[] = [];
      if (data.stepBars.length > 0) r.push('day');
      return [...r, ...availableRanges(info, data.series.steps, now)];
    }
    return availableRanges(info, data.series[key], now);
  }, [data, info, isSteps, key, now]);
  const [picked, setPicked] = useState<RangeKey | null>(null);
  const range: RangeKey | null = picked && ranges.includes(picked) ? picked : ranges.includes('week') ? 'week' : (ranges[0] ?? null);

  const windowSamples = useMemo(() => (range ? (isSteps && range === 'day' ? data.stepBars : windowOf(data.series[key], range, now)) : []), [data, isSteps, key, now, range]);
  const valueText = sum.latest ? (isSleep ? formatSleep(sum.latest.v) : formatNumber(sum.latest.v, info.decimals)) : '-';
  const stats = useMemo(() => minMax(isSteps ? windowSamples.filter((s) => s.t < today || range === 'day') : windowSamples), [isSteps, windowSamples, today, range]);
  const fmt = (v: number) => (isSleep ? formatSleep(v) : `${formatNumber(v, info.decimals)} ${info.unit}`);
  const gap = range && !isSteps && !isSleep ? hasGap(windowSamples, gapLimit(info)) : false;
  const trend = trendText(sum.latest ? sum.latest.v : null, sum.baseline, info);
  const rangeSpan = range ? RANGE_MS[range] : DAY;
  const t0 = isSteps ? (range === 'day' ? today : startOfDay(now - rangeSpan + DAY)) : now - rangeSpan;
  const t1 = isSteps ? today + DAY : now;
  const axis = range === 'day' ? 'time' : 'date';
  const subtitle =
    range === 'day' ? (isSteps ? (data.stepsSlotMs === HOUR ? 'Steps in each hour of today' : 'Steps in each 15 minutes of today') : 'Last 24 hours') : range === 'week' ? 'Last 7 days' : range === 'month' ? 'Last 30 days' : '';

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.ground }}>
      <View style={{ paddingHorizontal: spacing.xl, paddingTop: spacing.lg, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <BackButton onPress={onBack} accessibilityLabel="Back to Wearable" />
        <Text accessibilityRole="header" style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 20, color: colors.ink }}>
          {info.label}
        </Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: spacing.xl, paddingTop: spacing.md, paddingBottom: spacing.xxl ?? 40, gap: 14 }}>
        {data.isDemo ? (
          <View accessibilityRole="alert" style={{ backgroundColor: colors.amber100, borderRadius: radius.row, padding: 12 }}>
            <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 14, color: colors.amberDark }}>Demo data: sample numbers, not your measurements.</Text>
          </View>
        ) : null}

        {data.sync ? <SyncBanner notice={data.sync} /> : null}

        <Card elevated>
          {sum.latest ? (
            <View style={{ gap: 6 }}>
              <BigValue value={valueText} unit={isSleep ? undefined : info.unit} size={48} />
              <FreshnessLine f={sum.freshness} derived={data.derived[key]} />
              <StatusChip status={sum.status} />
              {isSteps ? <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 13, color: colors.ink3 }}>Running total since midnight</Text> : null}
            </View>
          ) : (
            <View style={{ gap: 6 }}>
              <Text accessibilityRole="header" style={{ fontFamily: 'Manrope_700Bold', fontSize: 16, color: colors.ink }}>
                No measurement yet
              </Text>
              <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2 }}>This appears once the wearable has reported it.</Text>
            </View>
          )}
        </Card>

        {sum.baseline && sum.latest && info.kind === 'daily' && !isSteps && !isSleep ? (
          <Card>
            <View style={{ gap: 8 }}>
              <SectionLabel>Against your usual range</SectionLabel>
              <RangeBar value={sum.latest.v} baseline={sum.baseline} />
              <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 13, color: colors.ink3 }}>The green part is your usual range. It says nothing about good or bad.</Text>
            </View>
          </Card>
        ) : null}

        {range ? (
          <Card>
            <View style={{ gap: 12 }}>
              {ranges.length > 1 ? (
                <SegmentedControl options={ranges.map((r) => ({ value: r, label: RANGE_LABEL[r] }))} value={range} onChange={setPicked} />
              ) : null}
              <SectionLabel>{subtitle}</SectionLabel>
              {isSteps || isSleep ? (
                <BarChart
                  samples={windowSamples}
                  t0={t0}
                  t1={t1}
                  slotMs={range === 'day' ? data.stepsSlotMs : DAY}
                  height={150}
                  unit={info.unit}
                  axis={axis}
                  format={isSleep ? formatSleep : undefined}
                  endLabel={isSteps && range === 'day' ? 'Midnight' : undefined}
                  label={`${info.label}, ${subtitle.toLowerCase()}${stats ? `. Lowest ${fmt(stats.min)}, highest ${fmt(stats.max)}` : ''}`}
                />
              ) : (
                <LineChart
                  samples={windowSamples}
                  t0={t0}
                  t1={t1}
                  height={170}
                  unit={info.unit}
                  decimals={info.decimals}
                  axis={axis}
                  gapMs={gapLimit(info)}
                  baseline={range === 'day' ? null : sum.baseline}
                  label={`${info.label}, ${subtitle.toLowerCase()}${stats ? `. Lowest ${fmt(stats.min)}, highest ${fmt(stats.max)}, average ${fmt(stats.mean)}` : ''}`}
                />
              )}
              {gap ? (
                <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 13, color: colors.ink3 }}>Breaks in the line are times the wearable sent no data.</Text>
              ) : null}
              {range !== 'day' && sum.baseline ? (
                <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 13, color: colors.ink3 }}>The shaded band is your usual range.</Text>
              ) : null}
            </View>
          </Card>
        ) : (
          <Card>
            <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 15, color: colors.ink }}>Not enough history to chart</Text>
            <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, marginTop: 4, lineHeight: 20 }}>
              A chart appears after a few days of data. Nothing is estimated in the meantime.
            </Text>
          </Card>
        )}

        {stats && range ? (
          <View style={{ flexDirection: 'row', gap: 10 }}>
            {(isSteps
              ? [{ label: range === 'day' ? 'Busiest hour' : 'Highest day', value: fmt(stats.max) }, ...(range !== 'day' ? [{ label: 'Average day', value: fmt(stats.mean) }] : [])]
              : [
                  { label: 'Lowest', value: fmt(stats.min) },
                  { label: 'Average', value: fmt(stats.mean) },
                  { label: 'Highest', value: fmt(stats.max) },
                ]
            ).map((s) => (
              <View key={s.label} style={{ flex: 1, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.card, padding: 12, gap: 2 }}>
                <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 13, color: colors.ink3 }}>{s.label}</Text>
                <Text style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 16, color: colors.ink }}>{s.value}</Text>
              </View>
            ))}
          </View>
        ) : null}

        <Card>
          <View style={{ gap: 10 }}>
            {info.kind === 'daily' && !isSteps ? (
              <View style={{ gap: 4 }}>
                <SectionLabel>Your usual range</SectionLabel>
                <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, lineHeight: 21 }}>
                  {sum.baseline
                    ? `${isSleep ? formatSleep(sum.baseline.low) : formatNumber(sum.baseline.low, info.decimals)} to ${isSleep ? formatSleep(sum.baseline.high) : formatNumber(sum.baseline.high, info.decimals)}${isSleep ? '' : ` ${info.unit}`}, from your previous ${sum.baseline.n} days.${trend ? ` ${trend}` : ''}`
                    : 'Your usual range appears after 7 days of data. Until then no status is shown.'}
                </Text>
              </View>
            ) : null}
            <View style={{ gap: 4 }}>
              <SectionLabel>What this measures</SectionLabel>
              <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, lineHeight: 21 }}>{info.about}</Text>
            </View>
            <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 13, color: colors.ink3, lineHeight: 19 }}>
              Observations about your own data. Not medical advice, and the wearable does not measure glucose.
            </Text>
          </View>
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}
