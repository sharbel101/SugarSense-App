import { useFocusEffect } from '@react-navigation/native';
import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Avatar } from '../components/Avatar';
import { Card } from '../components/Card';
import { Icon } from '../components/Icon';
import { PullToRefreshScrollView } from '../components/PullToRefreshScrollView';
import { useTabScreenBottomPadding } from '../components/QuickAdd';
import { BarChart, LineChart, StageBar } from '../components/wearable/Charts';
import { BigValue, FreshnessLine, MetricRow, SectionLabel, StatusChip } from '../components/wearable/Parts';
import { TabScreenProps } from '../navigation/types';
import { useWearable } from '../services/useWearable';
import {
  DAY,
  formatNumber,
  formatSleep,
  gapLimit,
  METRICS,
  minMax,
  summaryOf,
  windowOf,
  type MetricKey,
} from '../services/wearableModel';
import { radius, spacing, touch, useColors } from '../theme';

const SECONDARY: MetricKey[] = ['spo2', 'respiratory', 'skinTemp'];

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Wearable overview: what the body is doing now (heart rate), how it compares with the person's own usual
 * (HRV, resting heart rate), last night's sleep and today's movement, then the secondary measurements.
 * Every value comes from `useWearable()`; today that is clearly flagged demo data (there is no device
 * connection yet). No recovery or strain score is shown: none exists, and none is invented.
 */
export function WearableScreen({ navigation }: TabScreenProps<'Wearable'>) {
  const colors = useColors();
  const bottomPad = useTabScreenBottomPadding();
  const { data, now, refresh } = useWearable();
  const [more, setMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Re-read when the tab is opened so ages (and "stale") are current.
  useFocusEffect(useCallback(() => refresh(), [refresh]));
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    refresh();
    setTimeout(() => setRefreshing(false), 600);
  }, [refresh]);

  const open = (metric: MetricKey) => navigation.getParent()?.navigate('WearableMetric', { metric });

  const hr = summaryOf(data, 'heartRate', now);
  const hrv = summaryOf(data, 'hrv', now);
  const rhr = summaryOf(data, 'restingHr', now);
  const sleep = summaryOf(data, 'sleep', now);
  const steps = summaryOf(data, 'steps', now);
  const battery = summaryOf(data, 'battery', now);
  const hr24 = useMemo(() => windowOf(data.series.heartRate, 'day', now), [data, now]);
  const range = useMemo(() => minMax(hr24), [hr24]);
  const hasAny = Object.values(data.series).some((s) => s && s.length > 0);
  const today = startOfDay(now);
  const dateText = new Date(now).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const secondary = SECONDARY.map((k) => summaryOf(data, k, now)).filter((s) => s.latest !== null);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.ground }} edges={['top']}>
      <View style={{ paddingHorizontal: spacing.xl, paddingTop: spacing.lg, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <View style={{ flex: 1 }}>
          <Text accessibilityRole="header" style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 22, color: colors.ink }}>
            Wearable
          </Text>
          <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink3, marginTop: 2 }}>{dateText}</Text>
        </View>
        <Avatar onPress={() => navigation.navigate('Profile')} />
      </View>

      <PullToRefreshScrollView
        onRefresh={onRefresh}
        refreshing={refreshing}
        contentContainerStyle={{ paddingHorizontal: spacing.xl, paddingTop: spacing.md, paddingBottom: bottomPad, gap: 14 }}
      >
        {/* Connection and honesty about the data */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 6 }}>
            <Icon name="watch" size={14} color={colors.ink2} />
            <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 13, color: colors.ink2 }}>{data.device ?? 'No device connected'}</Text>
          </View>
          {data.isDemo ? (
            <View style={{ backgroundColor: colors.amber100, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 6 }}>
              <Text style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 13, color: colors.amberDark, letterSpacing: 0.4 }}>DEMO DATA</Text>
            </View>
          ) : null}
        </View>
        {data.isDemo ? (
          <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, lineHeight: 20 }}>
            Sample numbers to show the design. They are not your measurements, and connecting a wearable is not available yet.
          </Text>
        ) : null}

        {!hasAny ? (
          <Card>
            <Text accessibilityRole="header" style={{ fontFamily: 'Manrope_700Bold', fontSize: 16, color: colors.ink }}>
              No wearable data yet
            </Text>
            <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, lineHeight: 21, marginTop: 6 }}>
              Heart rate, sleep and activity appear here once a wearable is connected and has synced.
            </Text>
          </Card>
        ) : (
          <>
            {/* Heart rate: the main anchor */}
            {hr.latest ? (
              <Card elevated onPress={() => open('heartRate')} accessibilityLabel={`Heart rate ${Math.round(hr.latest.v)} beats per minute. ${hr.freshness.text}. Open details`}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <SectionLabel>Heart rate</SectionLabel>
                  <Icon name="chevronRight" size={18} color={colors.ink4} />
                </View>
                <View style={{ marginTop: 6 }}>
                  <BigValue value={formatNumber(hr.latest.v)} unit="bpm" size={52} />
                </View>
                <FreshnessLine f={hr.freshness} />
                <View style={{ marginTop: 12 }}>
                  <LineChart
                    compact
                    samples={hr24}
                    t0={now - DAY}
                    t1={now}
                    height={76}
                    unit="bpm"
                    axis="time"
                    gapMs={gapLimit(METRICS.heartRate)}
                    label={`Heart rate over the last 24 hours${range ? `, lowest ${Math.round(range.min)}, highest ${Math.round(range.max)} beats per minute` : ''}`}
                  />
                </View>
                {range ? (
                  <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 13, color: colors.ink3, marginTop: 8 }}>
                    Last 24 h: lowest {Math.round(range.min)} · highest {Math.round(range.max)} bpm
                  </Text>
                ) : null}
              </Card>
            ) : null}

            {/* HRV and resting heart rate against the person's own usual */}
            <View style={{ flexDirection: 'row', gap: 12 }}>
              {([hrv, rhr] as const).map((m) =>
                m.latest ? (
                  <Pressable
                    key={m.info.key}
                    onPress={() => open(m.info.key)}
                    accessibilityRole="button"
                    accessibilityLabel={`${m.info.label} ${formatNumber(m.latest.v, m.info.decimals)} ${m.info.unit}. ${m.freshness.text}. Open details`}
                    style={({ pressed }) => [
                      { flex: 1, minHeight: touch.min, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.card, padding: 14, gap: 6 },
                      pressed ? { opacity: 0.85 } : null,
                    ]}
                  >
                    <SectionLabel>{m.info.key === 'restingHr' ? 'Resting HR' : m.info.label}</SectionLabel>
                    <BigValue value={formatNumber(m.latest.v, m.info.decimals)} unit={m.info.unit} size={32} />
                    <StatusChip status={m.status} />
                    <FreshnessLine f={m.freshness} />
                  </Pressable>
                ) : null,
              )}
            </View>

            {/* Sleep */}
            {sleep.latest ? (
              <Card onPress={() => open('sleep')} accessibilityLabel={`Sleep ${formatSleep(sleep.latest.v)}. Open details`}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <SectionLabel>Last night</SectionLabel>
                  <Icon name="chevronRight" size={18} color={colors.ink4} />
                </View>
                <View style={{ marginTop: 6, gap: 6 }}>
                  <BigValue value={formatSleep(sleep.latest.v)} size={30} />
                  <StatusChip status={sleep.status} />
                  {data.lastNight ? (
                    <View style={{ marginTop: 6 }}>
                      <StageBar
                        stages={[
                          { key: 'deep', label: 'Deep', minutes: data.lastNight.deepMin },
                          { key: 'rem', label: 'REM', minutes: data.lastNight.remMin },
                          { key: 'light', label: 'Light', minutes: data.lastNight.lightMin },
                          { key: 'awake', label: 'Awake', minutes: data.lastNight.awakeMin },
                        ]}
                      />
                    </View>
                  ) : null}
                </View>
              </Card>
            ) : null}

            {/* Activity */}
            {steps.latest ? (
              <Card onPress={() => open('steps')} accessibilityLabel={`Steps today ${formatNumber(steps.latest.v)}. Open details`}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <SectionLabel>Activity today</SectionLabel>
                  <Icon name="chevronRight" size={18} color={colors.ink4} />
                </View>
                <View style={{ marginTop: 6, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
                  <BigValue value={formatNumber(steps.latest.v)} unit="steps" size={30} />
                  {data.activeMinutes !== null ? (
                    <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink2, marginBottom: 4 }}>{data.activeMinutes} active min</Text>
                  ) : null}
                </View>
                <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 13, color: colors.ink3, marginTop: 2 }}>Total so far today</Text>
                {data.hourlySteps.length > 0 ? (
                  <View style={{ marginTop: 10 }}>
                    <BarChart
                      compact
                      samples={data.hourlySteps}
                      t0={today}
                      t1={today + DAY}
                      slotMs={3_600_000}
                      height={56}
                      unit="steps"
                      axis="time"
                      label="Steps in each hour of today"
                    />
                  </View>
                ) : null}
              </Card>
            ) : null}

            {/* Secondary measurements */}
            {secondary.length > 0 || battery.latest ? (
              <Card>
                <Pressable
                  onPress={() => setMore((v) => !v)}
                  accessibilityRole="button"
                  aria-expanded={more}
                  accessibilityLabel={more ? 'Hide more measurements' : 'Show more measurements'}
                  style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: touch.min }}
                >
                  <SectionLabel>More measurements</SectionLabel>
                  <Icon name={more ? 'chevronDown' : 'chevronRight'} size={18} color={colors.ink4} />
                </Pressable>
                {more ? (
                  <View style={{ marginTop: 4 }}>
                    {secondary.map((s, i) => (
                      <View key={s.info.key} style={i > 0 ? { borderTopWidth: 1, borderTopColor: colors.divider } : null}>
                        <MetricRow
                          label={s.info.label}
                          value={formatNumber(s.latest ? s.latest.v : null, s.info.decimals)}
                          unit={s.info.unit}
                          status={s.status}
                          onPress={() => open(s.info.key)}
                        />
                      </View>
                    ))}
                    {battery.latest ? (
                      <View style={secondary.length > 0 ? { borderTopWidth: 1, borderTopColor: colors.divider } : null}>
                        <MetricRow label="Battery" value={formatNumber(battery.latest.v)} unit="%" status="none" />
                      </View>
                    ) : null}
                  </View>
                ) : null}
              </Card>
            ) : null}
          </>
        )}
      </PullToRefreshScrollView>
    </SafeAreaView>
  );
}
