import { useFocusEffect } from '@react-navigation/native';
import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { garminErrorText, type GarminError } from '../api/garminContract';
import { Avatar } from '../components/Avatar';
import { Card } from '../components/Card';
import { Icon } from '../components/Icon';
import { PullToRefreshScrollView } from '../components/PullToRefreshScrollView';
import { useTabScreenBottomPadding } from '../components/QuickAdd';
import { BarChart, LineChart, StageBar } from '../components/wearable/Charts';
import { BandBar, RangeBar, RingGauge } from '../components/wearable/Gauges';
import { BigValue, FreshnessLine, MetricRow, SectionLabel, StateMessage, StatusChip, SyncBanner } from '../components/wearable/Parts';
import { TabScreenProps } from '../navigation/types';
import { formatIsoTime12 } from '../services/clock12';
import { useWearable } from '../services/useWearable';
import {
  DAY,
  formatNumber,
  formatSleep,
  gapLimit,
  METRICS,
  minMax,
  stressBand,
  summaryOf,
  windowOf,
  type MetricKey,
  type WearableData,
} from '../services/wearableModel';
import { radius, spacing, touch, useColors } from '../theme';

const SECONDARY: MetricKey[] = ['spo2', 'respiratory', 'skinTemp'];

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Wearable overview. Data comes from `useWearable()`: your Garmin data from our own backend when it is
 * configured, otherwise clearly labelled demo data. Heart rate, activity and stress are shown as MEASUREMENTS with
 * their age; nothing here is a glucose reading or a hypoglycaemia risk, and no recovery or strain score is invented.
 */
export function WearableScreen({ navigation }: TabScreenProps<'Wearable'>) {
  const colors = useColors();
  const bottomPad = useTabScreenBottomPadding();
  const { data, now, refresh, loading, error, live, historyIncomplete, syncProblem } = useWearable();
  const [refreshing, setRefreshing] = useState(false);

  // Demo data re-reads when the tab opens so ages are current; live data refreshes itself while the screen is focused.
  useFocusEffect(
    useCallback(() => {
      if (!live) refresh();
    }, [live, refresh]),
  );
  // Pulling down makes the server read Garmin right now (every pull is a new Garmin call).
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    refresh();
    setTimeout(() => setRefreshing(false), 700);
  }, [refresh]);

  const dateText = new Date(now).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

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
        {syncProblem ? (
          <View accessibilityRole="alert" style={{ backgroundColor: colors.divider, borderRadius: radius.row, padding: 12 }}>
            <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink }}>{syncProblem}</Text>
          </View>
        ) : null}
        {data === null ? (
          error ? (
            <StateMessage title="Garmin data unavailable" text={garminErrorText(error)} onRetry={() => void refresh()} busy={loading} />
          ) : loading ? (
            <StateMessage title="Loading your Garmin data" text="Reading your latest measurements." busy />
          ) : (
            <StateMessage title="Garmin data has not loaded yet" text="Nothing is loading right now. Try again." onRetry={() => void refresh()} />
          )
        ) : (
          <>
            {historyIncomplete && !loading ? (
              <View accessibilityRole="alert" style={{ backgroundColor: colors.divider, borderRadius: radius.row, padding: 12 }}>
                <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink }}>The charts are still loading. Pull down to try again.</Text>
              </View>
            ) : null}
          <Overview data={data} now={now} error={error} loading={loading} onRetry={() => void refresh()} open={(metric) => navigation.getParent()?.navigate('WearableMetric', { metric })} />
          </>
        )}
      </PullToRefreshScrollView>
    </SafeAreaView>
  );
}

function Overview({
  data,
  now,
  error,
  loading,
  onRetry,
  open,
}: {
  data: WearableData;
  now: number;
  error: GarminError | null;
  loading: boolean;
  onRetry: () => void;
  open: (metric: MetricKey) => void;
}) {
  const colors = useColors();
  const [more, setMore] = useState(false);
  const hr = summaryOf(data, 'heartRate', now);
  const hrv = summaryOf(data, 'hrv', now);
  const rhr = summaryOf(data, 'restingHr', now);
  const sleep = summaryOf(data, 'sleep', now);
  const steps = summaryOf(data, 'steps', now);
  const stress = summaryOf(data, 'stress', now);
  const battery = summaryOf(data, 'bodyBattery', now);
  const device = summaryOf(data, 'battery', now);
  const hr24 = useMemo(() => windowOf(data.series.heartRate, 'day', now), [data, now]);
  const range = useMemo(() => minMax(hr24), [hr24]);
  const hasAny = Object.values(data.series).some((s) => s && s.length > 0);
  const today = startOfDay(now);
  const secondary = SECONDARY.map((k) => summaryOf(data, k, now)).filter((s) => s.latest !== null);
  const slotLabel = data.stepsSlotMs === 15 * 60_000 ? 'Steps in each 15 minutes of today' : 'Steps in each hour of today';

  return (
    <>
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
          Sample numbers to show the design. They are not your measurements, and Garmin data is not connected in this build.
        </Text>
      ) : null}
      {data.sync ? <SyncBanner notice={data.sync} /> : null}
      {error ? (
        <StateMessage title="Couldn't refresh" text={`${garminErrorText(error)} Showing the last data received.`} onRetry={onRetry} busy={loading} />
      ) : null}

      {!hasAny ? (
        <StateMessage
          title="No wearable data yet"
          text={data.isDemo ? 'Heart rate, sleep and activity appear here once a wearable is connected and has synced.' : 'No data yet. Your Garmin watch sends data in batches, so the first values can take a while.'}
        />
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
              <FreshnessLine f={hr.freshness} derived={data.derived.heartRate} />
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

          {/* HRV and resting heart rate: small tiles, each with a slim bar against the person's OWN usual range */}
          {hrv.latest || rhr.latest ? (
            <View style={{ flexDirection: 'row', gap: 12 }}>
              {([hrv, rhr] as const).map((m) =>
                m.latest ? (
                  <Pressable
                    key={m.info.key}
                    onPress={() => open(m.info.key)}
                    accessibilityRole="button"
                    accessibilityLabel={`${m.info.label} ${formatNumber(m.latest.v, m.info.decimals)} ${m.info.unit}. ${m.freshness.text}. Open details`}
                    style={({ pressed }) => [
                      { flex: 1, minHeight: touch.min, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.card, padding: 14, gap: 8 },
                      pressed ? { opacity: 0.85 } : null,
                    ]}
                  >
                    <SectionLabel>{m.info.key === 'restingHr' ? 'Resting HR' : m.info.label}</SectionLabel>
                    <BigValue value={formatNumber(m.latest.v, m.info.decimals)} unit={m.info.unit} size={32} />
                    {m.baseline ? <RangeBar value={m.latest.v} baseline={m.baseline} /> : null}
                    <StatusChip status={m.status} />
                    <FreshnessLine f={m.freshness} derived={data.derived[m.info.key]} />
                  </Pressable>
                ) : (
                  <View key={m.info.key} style={{ flex: 1 }} />
                ),
              )}
            </View>
          ) : null}

          {/* Stress (Garmin ranges) and body battery: gauges */}
          {stress.latest || battery.latest ? (
            <Card>
              <SectionLabel>Stress and body battery</SectionLabel>
              <View style={{ flexDirection: 'row', gap: 12, marginTop: 10 }}>
                <Pressable
                  onPress={() => (stress.latest ? open('stress') : undefined)}
                  accessibilityRole="button"
                  accessibilityLabel={stress.latest ? `Stress ${Math.round(stress.latest.v)} out of 100, ${stressBand(stress.latest.v).label}. ${stress.freshness.text}. Calculated by Garmin. Open details` : 'Stress: no data yet'}
                  style={({ pressed }) => [{ flex: 1, alignItems: 'center', gap: 4 }, pressed ? { opacity: 0.85 } : null]}
                >
                  <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink2 }}>Stress</Text>
                  {stress.latest ? (
                    <>
                      <BandBar value={stress.latest.v} />
                      <BigValue value={formatNumber(stress.latest.v)} unit="/ 100" size={26} />
                      <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 14, color: colors.ink }}>{stressBand(stress.latest.v).label}</Text>
                      <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 12, color: colors.ink3, textAlign: 'center' }}>Garmin range</Text>
                    </>
                  ) : (
                    <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink3 }}>No data yet</Text>
                  )}
                </Pressable>
                <Pressable
                  onPress={() => (battery.latest ? open('bodyBattery') : undefined)}
                  accessibilityRole="button"
                  accessibilityLabel={battery.latest ? `Body battery ${Math.round(battery.latest.v)} out of 100. ${battery.freshness.text}. Calculated by Garmin. Open details` : 'Body battery: no data yet'}
                  style={({ pressed }) => [{ flex: 1, alignItems: 'center', gap: 4 }, pressed ? { opacity: 0.85 } : null]}
                >
                  <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink2 }}>Body battery</Text>
                  {battery.latest ? (
                    <>
                      <RingGauge size={112} fraction={battery.latest.v / 100} color={colors.blue600} label={`Body battery ${Math.round(battery.latest.v)} out of 100`}>
                        <Text style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 26, color: colors.ink }}>{formatNumber(battery.latest.v)}</Text>
                        <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 12, color: colors.ink3 }}>/ 100</Text>
                      </RingGauge>
                      <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 12, color: colors.ink3, textAlign: 'center' }}>Energy estimate</Text>
                    </>
                  ) : (
                    <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink3 }}>No data yet</Text>
                  )}
                </Pressable>
              </View>
              <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 13, color: colors.ink3, marginTop: 10 }}>
                {(stress.latest ? stress : battery).freshness.text} · Calculated by Garmin
              </Text>
            </Card>
          ) : null}

          {/* Sleep */}
          {sleep.latest ? (
            <Card onPress={() => open('sleep')} accessibilityLabel={`Sleep ${formatSleep(sleep.latest.v)}. Open details`}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <SectionLabel>Last night</SectionLabel>
                <Icon name="chevronRight" size={18} color={colors.ink4} />
              </View>
              <View style={{ marginTop: 6, gap: 6 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                  <View style={{ flex: 1, gap: 4 }}>
                    <BigValue value={formatSleep(sleep.latest.v)} size={30} />
                    {data.sleepScore !== null ? <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink2 }}>Sleep score · Calculated by Garmin</Text> : null}
                  </View>
                  {data.sleepScore !== null ? (
                    <RingGauge size={84} fraction={data.sleepScore / 100} color={colors.purple600} label={`Sleep score ${Math.round(data.sleepScore)} out of 100`}>
                      <Text style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 22, color: colors.ink }}>{Math.round(data.sleepScore)}</Text>
                    </RingGauge>
                  ) : null}
                </View>
                <StatusChip status={sleep.status} />
                <FreshnessLine f={sleep.freshness} derived={data.derived.sleep} />
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
                {hrv.latest ? (
                  <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 13, color: colors.ink3 }}>Overnight HRV {formatNumber(hrv.latest.v)} ms</Text>
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
              <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 13, color: colors.ink3, marginTop: 2 }}>Total so far today · {steps.freshness.text}</Text>
              {data.stepBars.length > 0 ? (
                <View style={{ marginTop: 10 }}>
                  <BarChart compact samples={data.stepBars} t0={today} t1={today + DAY} slotMs={data.stepsSlotMs} height={56} unit="steps" axis="time" label={slotLabel} />
                </View>
              ) : null}
            </Card>
          ) : null}

          {/* Workouts */}
          {data.exercises.length > 0 ? (
            <Card>
              <SectionLabel>Recent workouts</SectionLabel>
              <View style={{ marginTop: 4 }}>
                {data.exercises.slice(0, 5).map((e, i) => (
                  <View key={`${e.t}-${i}`} style={[{ paddingVertical: 10, gap: 2 }, i > 0 ? { borderTopWidth: 1, borderTopColor: colors.divider } : null]}>
                    <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 15, color: colors.ink }}>{exerciseName(e.type)}</Text>
                    <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2 }}>
                      {new Date(e.t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · {formatIsoTime12(new Date(e.t).toISOString())} · {Math.round(e.durationMin)} min
                      {e.distanceM !== null ? ` · ${(e.distanceM / 1000).toFixed(1)} km` : ''}
                      {e.avgHr !== null ? ` · avg ${Math.round(e.avgHr)} bpm` : ''}
                    </Text>
                  </View>
                ))}
              </View>
              <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 13, color: colors.ink3 }}>Calculated by Garmin</Text>
            </Card>
          ) : null}

          {/* Secondary measurements */}
          {secondary.length > 0 || device.latest ? (
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
                      <MetricRow label={s.info.label} value={formatNumber(s.latest ? s.latest.v : null, s.info.decimals)} unit={s.info.unit} status={s.status} onPress={() => open(s.info.key)} extra={s.baseline && s.latest ? <RangeBar value={s.latest.v} baseline={s.baseline} /> : undefined} />
                    </View>
                  ))}
                  {device.latest ? (
                    <View style={secondary.length > 0 ? { borderTopWidth: 1, borderTopColor: colors.divider } : null}>
                      <MetricRow label="Battery" value={formatNumber(device.latest.v)} unit="%" status="none" />
                    </View>
                  ) : null}
                </View>
              ) : null}
            </Card>
          ) : null}

          <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 13, color: colors.ink3, lineHeight: 19 }}>
            {data.source === 'garmin' ? 'Measured by your Garmin watch. ' : ''}Heart rate, activity and stress are measurements. They do not show your glucose, and none of this is medical advice.
          </Text>
        </>
      )}
    </>
  );
}

function exerciseName(type: string | null): string {
  if (!type) return 'Workout';
  const t = type.replace(/_/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}
