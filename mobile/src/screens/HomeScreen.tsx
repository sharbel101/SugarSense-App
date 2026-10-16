import React, { useEffect, useMemo } from 'react';
import { Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Avatar } from '../components/Avatar';
import { Card } from '../components/Card';
import { Chip } from '../components/Chip';
import { ForecastChartBlock } from '../components/ForecastExtras';
import { GlucoseStatus } from '../components/GlucoseStatus';
import { Icon } from '../components/Icon';
import { PullToRefreshScrollView } from '../components/PullToRefreshScrollView';
import { buildGlucoseChart } from '../services/glucoseChart';
import { summariseRisk } from '../services/glucoseRisk';
import { formatAge, formatClock } from '../services/glucoseState';
import { useGlucose } from '../services/GlucoseProvider';
import { useQuickAdd } from '../components/QuickAdd';
import { useEvents } from '../services/EventsProvider';
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
  const { recent, refreshRecent, pendingCount } = useEvents();
  const { open: openQuickAdd } = useQuickAdd();
  useEffect(() => {
    refreshRecent();
  }, [refreshRecent]);
  const summary = (() => {
    const meals = recent.kind === 'ok' ? recent.meals.filter((m) => m.status !== 'cancelled').length : 0;
    const doses = recent.kind === 'ok' ? recent.insulin.length : 0;
    const parts: string[] = [];
    if (recent.kind === 'ok') parts.push(meals + doses === 0 ? 'Nothing logged in the last 12 hours.' : `${meals} meal${meals === 1 ? '' : 's'}, ${doses} insulin record${doses === 1 ? '' : 's'} in the last 12 hours.`);
    else if (recent.kind === 'unavailable') parts.push('The list from the server is not available right now.');
    else parts.push('Use + to add carbs or insulin.');
    if (pendingCount > 0) parts.push(`${pendingCount} not sent yet.`);
    return parts.join(' ');
  })();
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

      <PullToRefreshScrollView
        onRefresh={refresh}
        refreshing={refreshing}
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
                <ForecastChartBlock data={okData} height={150} />
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

        <Card onPress={() => openQuickAdd({ mode: 'list' })} accessibilityLabel="Open what you logged today">
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
            <IconChip bg={colors.amber100}>
              <Icon name="fork" size={19} color={colors.amber600} />
            </IconChip>
            <View style={{ flex: 1 }}>
              <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 15, color: colors.ink }}>Logged today</Text>
              <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, marginTop: 1 }}>
                {summary}
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
              <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 15, color: colors.ink }}>Wearable</Text>
              <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, marginTop: 1 }}>
                No wearable connected.
              </Text>
            </View>
          </View>
        </Card>
      </PullToRefreshScrollView>

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
