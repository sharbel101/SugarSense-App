import { useFocusEffect } from '@react-navigation/native';
import React, { useCallback, useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Avatar } from '../components/Avatar';
import { Card } from '../components/Card';
import { FallbackForecast } from '../components/FallbackForecast';
import { ForecastChartBlock } from '../components/ForecastExtras';
import { TrendArrow } from '../components/TrendArrow';
import { GlucoseStatus } from '../components/GlucoseStatus';
import { Icon, IconName } from '../components/Icon';
import { PullToRefreshScrollView } from '../components/PullToRefreshScrollView';
import { useQuickAdd, useTabScreenBottomPadding } from '../components/QuickAdd';
import { TabScreenProps } from '../navigation/types';
import { useEvents } from '../services/EventsProvider';
import { formatEventTime } from '../services/events';
import { buildGlucoseChart } from '../services/glucoseChart';
import { useForecast } from '../services/ForecastProvider';
import { formatAge, formatClock } from '../services/glucoseState';
import { useGlucose } from '../services/GlucoseProvider';
import { insulinRows, mealRows, type EntryRow } from '../services/homeEntries';
import { dayKey, trendDisplay } from '../services/mealHistory';
import { radius, spacing, touch, useColors } from '../theme';

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

const ROWS_SHOWN = 4;

/** Home: current glucose with the predicted graph and on-board amounts, quick actions, then recent carbs and insulin. */
export function HomeScreen({ navigation, route }: TabScreenProps<'Home'>) {
  const colors = useColors();
  const bottomPad = useTabScreenBottomPadding();
  const { view, refresh, refreshing } = useGlucose();
  const { recent, refreshRecent } = useEvents();
  const { open: openQuickAdd } = useQuickAdd();
  const { view: forecastView } = useForecast();
  // Another screen (the Safety cards) can ask for the top of this page: `toTop` is a new number each time.
  const toTop = route.params?.toTop;

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
  const chart = useMemo(() => (okData ? buildGlucoseChart(okData) : null), [okData]);
  const trend = okData ? trendDisplay(okData.trendMgdlPerMin) : null;
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

  // What the server has plus what was just entered on this phone: an entry shows the moment it is typed.
  const { records } = useEvents();
  const meals = useMemo(() => {
    const key = dayKey(new Date());
    return mealRows(recent.kind === 'ok' ? recent.meals : [], records).filter((r) => dayKey(new Date(r.timeIso)) === key);
  }, [recent, records]);
  const doses = useMemo(() => {
    const key = dayKey(new Date());
    return insulinRows(recent.kind === 'ok' ? recent.insulin : [], records).filter((r) => dayKey(new Date(r.timeIso)) === key);
  }, [recent, records]);
  const todaysCarbs = useMemo(() => {
    const g = meals.map((m) => Number.parseFloat(m.amount)).filter((n) => Number.isFinite(n));
    return g.length > 0 ? g.reduce((x, y) => x + y, 0) : null;
  }, [meals]);

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
        scrollRequest={toTop !== undefined ? { y: 0, id: toTop } : undefined}
        contentContainerStyle={{ paddingHorizontal: spacing.xl, paddingTop: spacing.md, paddingBottom: bottomPad, gap: 14 }}
      >
        {/* 1-2. Current glucose, the predicted glucose graph, and insulin / carbs on board right below it */}
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
              {trend ? <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink, marginTop: 2 }}>{trend.text}</Text> : null}
              <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, marginTop: 2 }}>
                Updated {formatAge(view.ageMinutes)} · measured {formatClock(okData.measuredAt)}
              </Text>
              {view.refreshFailed ? (
                <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.amberDark, marginTop: 4 }}>
                  Couldn&apos;t refresh - showing the previous reading.
                </Text>
              ) : null}
              <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 13, color: colors.ink2, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 14 }}>
                Predicted range · next 3 hours
              </Text>
              <View style={{ marginTop: 6 }}>
                <ForecastChartBlock data={okData} height={chart.viewBoxHeight} />
              </View>
            </>
          ) : view.kind === 'ok' ? null : (
            <GlucoseStatus view={view} onRetry={refresh} retrying={refreshing} />
          )}
        </Card>
        {okData && chart && forecastView.kind !== 'ok' ? <FallbackForecast data={okData} hasBand={chart.hasBand} /> : null}

        {/* 5 (moved up for reach). Quick actions */}
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <ActionButton label="Add meal" icon="fork" primary onPress={() => openQuickAdd({ mode: 'meal' })} />
          <ActionButton label="Log insulin" icon="droplet" onPress={() => openQuickAdd({ mode: 'insulin' })} />
        </View>

        <Text accessibilityRole="header" style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 18, color: colors.ink, marginTop: 4 }}>
          Recent activity
        </Text>
        <EntriesCard
          title="Recent carbs"
          total={todaysCarbs !== null ? Math.round(todaysCarbs) + ' g today' : null}
          rows={meals}
          empty="No carbs logged today."
          loading={recent.kind === 'loading' || recent.kind === 'idle'}
          onPress={() => navigation.navigate('MealHistory')}
          label="Open meal history"
        />
        <EntriesCard
          title="Recent insulin"
          total={null}
          rows={doses}
          empty="No insulin logged today."
          loading={recent.kind === 'loading' || recent.kind === 'idle'}
          onPress={() => navigation.navigate('InsulinHistory')}
          label="Open insulin history"
        />
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

function EntriesCard({ title, total, rows, empty, loading, onPress, label }: { title: string; total: string | null; rows: EntryRow[]; empty: string; loading: boolean; onPress: () => void; label: string }) {
  const colors = useColors();
  return (
    <Card onPress={onPress} accessibilityLabel={label}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text accessibilityRole="header" style={{ fontFamily: 'Manrope_700Bold', fontSize: 16, color: colors.ink }}>{title}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {total ? <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 14, color: colors.ink2 }}>{total}</Text> : null}
          <Icon name="chevronRight" size={18} color={colors.ink4} />
        </View>
      </View>
      {rows.length === 0 ? (
        <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, marginTop: 6 }}>{loading ? 'Loading...' : empty}</Text>
      ) : (
        <View style={{ marginTop: 8, gap: 10 }}>
          {rows.slice(0, ROWS_SHOWN).map((r) => (
            <View key={r.key} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 15, color: colors.ink }} numberOfLines={1}>{r.title}</Text>
                <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: r.state === 'failed' ? colors.red600 : r.state === 'sending' ? colors.amberDark : colors.ink2 }}>
                  {formatEventTime(r.timeIso)}
                  {r.state === 'sending' ? ' · Sending...' : r.state === 'failed' ? ' · Not saved' : ''}
                </Text>
              </View>
              <Text style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 20, color: colors.ink }}>{r.amount}</Text>
            </View>
          ))}
          {rows.length > ROWS_SHOWN ? <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.blue600 }}>+{rows.length - ROWS_SHOWN} more</Text> : null}
        </View>
      )}
    </Card>
  );
}
