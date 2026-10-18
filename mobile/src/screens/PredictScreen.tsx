import React, { useMemo } from 'react';
import { Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Avatar } from '../components/Avatar';
import { useTabScreenBottomPadding } from '../components/QuickAdd';
import { Card } from '../components/Card';
import { Chip } from '../components/Chip';
import { ForecastChartBlock } from '../components/ForecastExtras';
import { GlucoseStatus } from '../components/GlucoseStatus';
import { OnBoardChartCard } from '../components/OnBoardChart';
import { PullToRefreshScrollView } from '../components/PullToRefreshScrollView';
import { TabScreenProps } from '../navigation/types';
import { buildGlucoseChart } from '../services/glucoseChart';
import { formatAge, formatClock } from '../services/glucoseState';
import { useForecast } from '../services/ForecastProvider';
import { useGlucose } from '../services/GlucoseProvider';
import { spacing, useColors } from '../theme';

const FORECAST_MARKS = [30, 60, 120] as const;

export function PredictScreen({ navigation, route }: TabScreenProps<'Predict'>) {
  const colors = useColors();
  // Another screen (the Safety cards) can ask for the top of this page: `toTop` is a new number each time.
  const toTop = route.params?.toTop;
  const bottomPad = useTabScreenBottomPadding();
  const { view, refresh, refreshing } = useGlucose();
  const { view: forecastView } = useForecast();
  const mealAware = forecastView.kind === 'ok';
  const data = view.kind === 'ok' ? view.data : null;
  const chart = useMemo(() => (data ? buildGlucoseChart(data) : null), [data]);

  // Forecast value nearest each mark (the endpoint emits every 5 min up to +120).
  const marks = useMemo(() => {
    if (!data || !data.forecastAvailable) return [];
    const t0 = Date.parse(data.measuredAt);
    return FORECAST_MARKS.flatMap((m) => {
      const target = t0 + m * 60000;
      let best: { dt: number; value: number } | null = null;
      for (const p of data.predictions) {
        const dt = Math.abs(Date.parse(p.time) - target);
        if (best === null || dt < best.dt) best = { dt, value: p.value };
      }
      return best && best.dt <= 5 * 60000 ? [{ minutes: m, value: best.value }] : [];
    });
  }, [data]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.ground }} edges={['top']}>
      <View
        style={{
          paddingHorizontal: spacing.xl,
          paddingTop: spacing.lg,
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <Text accessibilityRole="header" style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 22, color: colors.ink }}>
          Predict
        </Text>
        <Avatar onPress={() => navigation.navigate('Profile')} />
      </View>

      <PullToRefreshScrollView
        onRefresh={refresh}
        refreshing={refreshing}
        scrollRequest={toTop !== undefined ? { y: 0, id: toTop } : undefined}
        contentContainerStyle={{ paddingHorizontal: spacing.xl, paddingTop: spacing.md, paddingBottom: bottomPad, gap: 16 }}>
        {view.kind === 'ok' && data && chart ? (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <Text style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 30, color: colors.ink }}>
                {Math.round(data.glucoseMgdl)}
              </Text>
              <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink2 }}>
                mg/dL · updated {formatAge(view.ageMinutes)} · measured {formatClock(data.measuredAt)}
              </Text>
            </View>
            {view.refreshFailed ? (
              <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 13, color: colors.amberDark }}>
                Couldn&apos;t refresh - showing the previous reading.
              </Text>
            ) : null}

            <Card elevated>
              <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 13, color: colors.ink2, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                Predicted range · next 3 hours
              </Text>
              <View style={{ marginTop: 6 }}>
                <ForecastChartBlock data={data} height={chart.viewBoxHeight} />
              </View>
            </Card>

            {mealAware ? <OnBoardChartCard data={data} /> : null}

            {!mealAware && chart.hasBand && data.rangesAreShadow ? (
              <Chip label="Estimated ranges: shadow mode, not validated" bg={colors.amber100} color={colors.amberDark} />
            ) : null}

            {!mealAware && data.ranges ? (
              <Card>
                <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 15, color: colors.ink }}>Estimated ranges</Text>
                {data.ranges.map((r) => (
                  <View key={r.minutes} style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 }}>
                    <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink }}>
                      In {r.minutes} min
                    </Text>
                    <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2 }}>
                      {Math.round(r.low)}–{Math.round(r.high)} mg/dL
                    </Text>
                  </View>
                ))}
              </Card>
            ) : null}

            {!mealAware && marks.length > 0 ? (
              <Card>
                <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 15, color: colors.ink }}>Forecast line</Text>
                {marks.map((m) => (
                  <View key={m.minutes} style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 }}>
                    <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink }}>
                      In {m.minutes} min
                    </Text>
                    <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2 }}>
                      {Math.round(m.value)} mg/dL
                    </Text>
                  </View>
                ))}
                <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, marginTop: 10 }}>
                  A single forecast value is an estimate and can be wrong. It carries no range beyond 45 minutes.
                </Text>
              </Card>
            ) : null}

            {!mealAware ? (
            <Card>
              <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 15, color: colors.ink }}>About this forecast</Text>
              <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, marginTop: 6, lineHeight: 21 }}>
                Estimates only. Not medical advice.
                {data.modelVersion ? ` Model ${data.modelVersion}.` : ''}
                {data.generatedAt ? ` Generated at ${formatClock(data.generatedAt)}.` : ''}
              </Text>
            </Card>
            ) : null}
          </>
        ) : view.kind === 'ok' ? null : (
          <Card elevated>
            <GlucoseStatus view={view} onRetry={refresh} retrying={refreshing} />
          </Card>
        )}
      </PullToRefreshScrollView>
    </SafeAreaView>
  );
}
