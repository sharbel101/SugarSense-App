import { useFocusEffect } from '@react-navigation/native';
import React, { useCallback, useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Avatar } from '../components/Avatar';
import { Card } from '../components/Card';
import { GlucoseChart } from '../components/GlucoseChart';
import { TrendArrow } from '../components/TrendArrow';
import { GlucoseStatus } from '../components/GlucoseStatus';
import { Icon, IconName } from '../components/Icon';
import { PullToRefreshScrollView } from '../components/PullToRefreshScrollView';
import { useQuickAdd, useTabScreenBottomPadding } from '../components/QuickAdd';
import { TabScreenProps } from '../navigation/types';
import { useEvents } from '../services/EventsProvider';
import { formatEventTime } from '../services/events';
import { buildHistoryChart } from '../services/glucoseChart';
import { summariseRisk } from '../services/glucoseRisk';
import { formatAge, formatClock } from '../services/glucoseState';
import { useGlucose } from '../services/GlucoseProvider';
import { activeMeals, carbsText, dayKey, mealTitle, trendDisplay } from '../services/mealHistory';
import { radius, spacing, touch, useColors } from '../theme';

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

const MEALS_SHOWN = 3;
const ACTIVITY_SHOWN = 4;

/** Home = what is happening right now: glucose, alerts, quick actions, today's meals, recent activity. */
export function HomeScreen({ navigation }: TabScreenProps<'Home'>) {
  const colors = useColors();
  const bottomPad = useTabScreenBottomPadding();
  const { view, refresh, refreshing } = useGlucose();
  const { recent, refreshRecent, pendingCount } = useEvents();
  const { open: openQuickAdd } = useQuickAdd();

  // The list of what you logged is fetched every time Home is shown and then once a minute while it stays
  // open (it used to be fetched only the first time, so new meals and doses did not appear).
  useFocusEffect(
    useCallback(() => {
      refreshRecent();
      const timer = setInterval(refreshRecent, 60_000);
      return () => clearInterval(timer);
    }, [refreshRecent]),
  );
  const refreshAll = useCallback(() => {
    refresh();
    refreshRecent();
  }, [refresh, refreshRecent]);

  const okData = view.kind === 'ok' ? view.data : null;
  const chart = useMemo(() => (okData ? buildHistoryChart(okData) : null), [okData]);
  const risk = useMemo(() => (okData ? summariseRisk(okData) : null), [okData]);
  const trend = okData ? trendDisplay(okData.trendMgdlPerMin) : null;
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

  const todaysMeals = useMemo(() => {
    if (recent.kind !== 'ok') return [];
    const key = dayKey(new Date());
    return activeMeals(recent.meals)
      .filter((m) => dayKey(new Date(m.eatenAt)) === key)
      .sort((a, b) => Date.parse(b.eatenAt) - Date.parse(a.eatenAt));
  }, [recent]);
  const todaysCarbs = useMemo(() => {
    const known = todaysMeals.filter((m) => m.carbs.grams !== null);
    return known.length > 0 ? known.reduce((s, m) => s + (m.carbs.grams as number), 0) : null;
  }, [todaysMeals]);

  const activity = useMemo(() => {
    if (recent.kind !== 'ok') return [];
    const rows: { key: string; icon: IconName; title: string; time: string }[] = [];
    for (const m of activeMeals(recent.meals)) {
      rows.push({ key: m.id, icon: 'fork', title: `${mealTitle(m)} · ${carbsText(m)}`, time: m.eatenAt });
    }
    for (const i of recent.insulin) {
      if (i.status === 'cancelled') continue;
      const title = i.confirmation === 'planned' ? 'Insulin planned (not taken)' : i.unitsTaken === 0 ? 'No insulin taken' : i.unitsTaken === null ? 'Insulin' : `Insulin ${i.unitsTaken} U`;
      rows.push({ key: i.id, icon: 'droplet', title, time: i.administeredAt });
    }
    return rows.sort((a, b) => Date.parse(b.time) - Date.parse(a.time)).slice(0, ACTIVITY_SHOWN);
  }, [recent]);

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
          <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink3, marginTop: 2 }}>{today}</Text>
        </View>
        <Avatar onPress={() => navigation.navigate('Profile')} />
      </View>

      <PullToRefreshScrollView
        onRefresh={refreshAll}
        refreshing={refreshing}
        contentContainerStyle={{ paddingHorizontal: spacing.xl, paddingTop: spacing.md, paddingBottom: bottomPad, gap: 14 }}
      >
        {/* 1. Current glucose */}
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
                <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 16, color: colors.ink2, marginBottom: 9 }}>mg/dL</Text>
                {trend && okData.trendMgdlPerMin !== null ? (
                  <View accessible accessibilityLabel={trend.text} style={{ marginBottom: 6, marginLeft: 4 }}>
                    <TrendArrow ratePerMin={okData.trendMgdlPerMin} />
                  </View>
                ) : null}
              </View>
              {trend ? (
                <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink, marginTop: 2 }}>{trend.text}</Text>
              ) : null}
              <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, marginTop: 2 }}>
                Updated {formatAge(view.ageMinutes)} · measured {formatClock(okData.measuredAt)}
              </Text>
              {view.refreshFailed ? (
                <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.amberDark, marginTop: 4 }}>
                  Couldn&apos;t refresh - showing the previous reading.
                </Text>
              ) : null}
              <View style={{ marginTop: 12 }}>
                <GlucoseChart
                  viewBoxWidth={chart.viewBoxWidth}
                  viewBoxHeight={chart.viewBoxHeight}
                  actual={chart.actual}
                  predicted={[]}
                  nowX={chart.nowX}
                  gridLinesY={chart.gridLinesY}
                  xTicks={chart.xTicks}
                  yTicks={chart.yTicks}
                  height={150}
                  forecastPoints={chart.scrubPoints}
                  scrubKind="history"
                  accessibilityLabel={`Glucose over the last hour. Latest reading ${Math.round(okData.glucoseMgdl)} milligrams per decilitre. Press and drag to read earlier values.`}
                />
                <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 13, color: colors.ink3, marginTop: 4 }}>Press and drag on the graph to see earlier readings.</Text>
              </View>
            </>
          ) : view.kind === 'ok' ? null : (
            <GlucoseStatus view={view} onRetry={refresh} retrying={refreshing} />
          )}
        </Card>

        {/* 2. Important alerts - only when there is one */}
        {risk?.alerting ? (
          <Card onPress={() => navigation.navigate('Safety')} accessibilityLabel="Open Safety">
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <IconChip bg={colors.amber100}>
                <Icon name="alertTriangle" size={19} color={colors.amber600} />
              </IconChip>
              <Text style={{ flex: 1, fontFamily: 'Manrope_700Bold', fontSize: 15, color: colors.ink, lineHeight: 21 }}>{risk.lines.join(' ')}</Text>
              <Icon name="chevronRight" size={18} color={colors.ink4} />
            </View>
          </Card>
        ) : null}

        {/* 5 (moved up for reach). Quick actions */}
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <ActionButton label="Add meal" icon="fork" primary onPress={() => openQuickAdd({ mode: 'meal' })} />
          <ActionButton label="Log insulin" icon="droplet" onPress={() => openQuickAdd({ mode: 'insulin' })} />
        </View>

        {/* 3. Today's meals */}
        <Card onPress={() => navigation.navigate('MealHistory')} accessibilityLabel="Open meal history">
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text accessibilityRole="header" style={{ fontFamily: 'Manrope_700Bold', fontSize: 16, color: colors.ink }}>
              Today&apos;s meals
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              {todaysCarbs !== null ? (
                <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 14, color: colors.ink2 }}>{Math.round(todaysCarbs)} g</Text>
              ) : null}
              <Icon name="chevronRight" size={18} color={colors.ink4} />
            </View>
          </View>
          {recent.kind === 'loading' || recent.kind === 'idle' ? (
            <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, marginTop: 6 }}>Loading...</Text>
          ) : recent.kind === 'unavailable' ? (
            <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, marginTop: 6 }}>
              Meals are not available right now.
            </Text>
          ) : todaysMeals.length === 0 ? (
            <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, marginTop: 6 }}>No meals logged today.</Text>
          ) : (
            <View style={{ marginTop: 8, gap: 8 }}>
              {todaysMeals.slice(0, MEALS_SHOWN).map((m) => (
                <View key={m.id} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 15, color: colors.ink }} numberOfLines={1}>
                      {mealTitle(m)}
                    </Text>
                    <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2 }}>{formatEventTime(m.eatenAt)}</Text>
                  </View>
                  <Text style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 16, color: colors.ink }}>
                    {m.carbs.grams === null ? '? g' : `${Math.round(m.carbs.grams)} g`}
                  </Text>
                </View>
              ))}
              {todaysMeals.length > MEALS_SHOWN ? (
                <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.blue600 }}>
                  +{todaysMeals.length - MEALS_SHOWN} more
                </Text>
              ) : null}
            </View>
          )}
        </Card>

        {/* 4. Recent activity */}
        <Card onPress={() => openQuickAdd({ mode: 'list' })} accessibilityLabel="Open what you logged">
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text accessibilityRole="header" style={{ fontFamily: 'Manrope_700Bold', fontSize: 16, color: colors.ink }}>
              Recent activity
            </Text>
            <Icon name="chevronRight" size={18} color={colors.ink4} />
          </View>
          {pendingCount > 0 ? (
            <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.amberDark, marginTop: 6 }}>
              {pendingCount} not sent yet - the forecast does not include {pendingCount === 1 ? 'it' : 'them'}.
            </Text>
          ) : null}
          {activity.length === 0 ? (
            <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, marginTop: 6 }}>
              {recent.kind === 'unavailable' ? 'Not available right now.' : recent.kind === 'ok' ? 'Nothing logged recently.' : 'Loading...'}
            </Text>
          ) : (
            <View style={{ marginTop: 8, gap: 8 }}>
              {activity.map((a) => (
                <View key={a.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <Icon name={a.icon} size={16} color={colors.ink3} />
                  <Text style={{ flex: 1, fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink }} numberOfLines={1}>
                    {a.title}
                  </Text>
                  <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2 }}>{formatEventTime(a.time)}</Text>
                </View>
              ))}
            </View>
          )}
        </Card>
      </PullToRefreshScrollView>
    </SafeAreaView>
  );
}

function ActionButton({ label, icon, onPress, primary }: { label: string; icon: IconName; onPress: () => void; primary?: boolean }) {
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        {
          flex: 1,
          minHeight: touch.min + 8,
          borderRadius: radius.row,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          backgroundColor: primary ? colors.blue600 : colors.surface,
          borderWidth: primary ? 0 : 1,
          borderColor: colors.border,
        },
        pressed ? { opacity: 0.85 } : null,
      ]}
    >
      <Icon name={icon} size={20} color={primary ? colors.onBlue : colors.blue600} />
      <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 16, color: primary ? colors.onBlue : colors.ink }}>{label}</Text>
    </Pressable>
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
