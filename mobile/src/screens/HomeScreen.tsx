import React, { useMemo } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Avatar } from '../components/Avatar';
import { Card } from '../components/Card';
import { Chip } from '../components/Chip';
import { GlucoseChart } from '../components/GlucoseChart';
import { GlucoseStatus } from '../components/GlucoseStatus';
import { Icon } from '../components/Icon';
import { latestMeal, wearableNormal } from '../data/mockData';
import { buildGlucoseChart } from '../services/glucoseChart';
import { summariseRisk } from '../services/glucoseRisk';
import { formatAge, formatClock } from '../services/glucoseState';
import { useGlucose } from '../services/GlucoseProvider';
import { manualConfirmedMeal } from '../services/mealService';
import { radius, spacing, useColors } from '../theme';
import { TabScreenProps } from '../navigation/types';

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export function HomeScreen({ navigation }: TabScreenProps<'Home'>) {
  const colors = useColors();
  const { view, refresh, refreshing } = useGlucose();
  const okData = view.kind === 'ok' ? view.data : null;
  const chart = useMemo(() => (okData ? buildGlucoseChart(okData) : null), [okData]);
  const risk = useMemo(() => (okData ? summariseRisk(okData) : null), [okData]);
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.ground }} edges={['top']}>
      <View
        style={{
          paddingHorizontal: spacing.xl,
          paddingTop: spacing.lg,
          paddingBottom: spacing.xs,
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
        }}
      >
        <View>
          <Text accessibilityRole="header" style={{ fontFamily: 'Manrope_700Bold', fontSize: 20, color: colors.ink }}>
            {greeting()}
          </Text>
          <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 13, color: colors.ink3, marginTop: 2 }}>
            {today}
          </Text>
        </View>
        <Avatar onPress={() => navigation.navigate('Profile')} />
      </View>

      <ScrollView
        contentContainerStyle={{ paddingHorizontal: spacing.xl, paddingTop: spacing.md, paddingBottom: spacing.xxxl, gap: 14 }}
      >
        <Card elevated>
          {view.kind === 'ok' && okData && chart ? (
            <>
              <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8 }}>
                <Text
                  accessibilityLabel={`${Math.round(okData.glucoseMgdl)} milligrams per decilitre`}
                  style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 56, color: colors.ink, letterSpacing: -1.5 }}
                >
                  {Math.round(okData.glucoseMgdl)}
                </Text>
                <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 16, color: colors.ink2, marginBottom: 9 }}>
                  mg/dL
                </Text>
              </View>
              <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, marginTop: 4 }}>
                Updated {formatAge(view.ageMinutes)} · measured {formatClock(okData.measuredAt)}
              </Text>
              {view.refreshFailed ? (
                <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 13, color: colors.amberDark, marginTop: 4 }}>
                  Couldn&apos;t refresh - showing the previous reading.
                </Text>
              ) : null}

              <View style={{ marginTop: 18 }}>
                <GlucoseChart
                  viewBoxWidth={chart.viewBoxWidth}
                  viewBoxHeight={chart.viewBoxHeight}
                  actual={chart.actual}
                  predicted={chart.predicted}
                  band={chart.band}
                  nowX={chart.nowX}
                  gridLinesY={chart.gridLinesY}
                  xTicks={chart.xTicks}
                  yTicks={chart.yTicks}
                  height={150}
                  accessibilityLabel={
                    chart.hasForecast
                      ? `Glucose over the last hour with the forecast for the next 2 hours. Latest reading ${Math.round(okData.glucoseMgdl)} milligrams per decilitre.`
                      : `Glucose over the last hour. Latest reading ${Math.round(okData.glucoseMgdl)} milligrams per decilitre. No forecast available.`
                  }
                />
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 14, marginTop: 10 }}>
                  <LegendDot color={colors.blue700} label="Measured" />
                  {chart.hasForecast ? <LegendDot color={colors.blue500} label="Forecast" dashed /> : null}
                  {chart.hasBand ? (
                    <LegendDot
                      color={colors.blue500}
                      label={okData.rangesAreShadow ? 'Estimated range (not validated)' : 'Estimated range'}
                      faint
                    />
                  ) : null}
                </View>
                {!chart.hasForecast ? (
                  <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, marginTop: 8 }}>
                    Forecast unavailable
                    {okData.forecastUnavailableReason ? `: ${okData.forecastUnavailableReason}` : '.'}
                  </Text>
                ) : null}
              </View>
            </>
          ) : view.kind === 'ok' ? null : (
            <GlucoseStatus view={view} onRetry={refresh} retrying={refreshing} />
          )}
        </Card>

        <Card onPress={() => navigation.navigate('Safety')} accessibilityLabel="Open Safety">
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
            <IconChip bg={risk?.alerting ? colors.amber100 : colors.blue100}>
              <Icon
                name={risk?.alerting ? 'alertTriangle' : 'shield'}
                size={19}
                color={risk?.alerting ? colors.amber600 : colors.blue600}
              />
            </IconChip>
            <View style={{ flex: 1 }}>
              <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 15, color: colors.ink }}>Safety</Text>
              <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, marginTop: 1 }}>
                {risk ? risk.lines.join(' ') : 'Risk signal unavailable without a recent reading.'}
              </Text>
            </View>
            {risk?.alerting ? <Chip label="Alert" bg={colors.amber100} color={colors.amberDark} size="sm" /> : null}
          </View>
        </Card>

        <Card
          // "Latest meal" has no real history store yet (out of scope here) - this still just
          // reopens the mock summary below, now carrying the ConfirmedMeal shape PostMeal expects.
          onPress={() =>
            navigation.navigate('Scan', {
              screen: 'PostMeal',
              params: { meal: { ...manualConfirmedMeal(latestMeal.carbs), label: latestMeal.name } },
            })
          }
          accessibilityLabel="View latest meal"
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
            <IconChip bg={colors.amber100}>
              <Icon name="fork" size={19} color={colors.amber600} />
            </IconChip>
            <View style={{ flex: 1 }}>
              <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 15, color: colors.ink }}>Latest meal</Text>
              <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, marginTop: 1 }}>
                {latestMeal.name} · Est. {latestMeal.carbs}g carbs
              </Text>
            </View>
            <Icon name="chevronRight" size={18} color={colors.ink4} />
          </View>
        </Card>

        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
            <IconChip bg={colors.purple100}>
              <Icon name="heart" size={19} color={colors.purple600} />
            </IconChip>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 15, color: colors.ink }}>Wearable</Text>
                <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: colors.green600 }} />
                <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 12, color: colors.green600 }}>Connected</Text>
              </View>
              <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, marginTop: 1 }}>
                HR {wearableNormal.hr} bpm · Data quality good
              </Text>
            </View>
          </View>
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

function IconChip({ bg, children }: { bg: string; children: React.ReactNode }) {
  return (
    <View
      style={{
        width: 38,
        height: 38,
        borderRadius: radius.chip,
        backgroundColor: bg,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {children}
    </View>
  );
}

function LegendDot({ color, label, dashed, faint }: { color: string; label: string; dashed?: boolean; faint?: boolean }) {
  const colors = useColors();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
      <View
        style={{
          width: faint ? 10 : 14,
          height: faint ? 10 : 2,
          borderRadius: faint ? 2 : 1,
          backgroundColor: color,
          opacity: faint ? 0.35 : dashed ? 0.7 : 1,
        }}
      />
      <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 12, color: colors.ink2 }}>{label}</Text>
    </View>
  );
}
