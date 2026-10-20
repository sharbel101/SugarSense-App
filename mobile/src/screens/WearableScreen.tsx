import React, { useMemo } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Avatar } from '../components/Avatar';
import { Card } from '../components/Card';
import { Icon, type IconName } from '../components/Icon';
import { useTabScreenBottomPadding } from '../components/QuickAdd';
import { TabScreenProps } from '../navigation/types';
import { formatActivity, formatSleep, formatSteps, formatValue, getWearableView, type WearableSnapshot } from '../services/wearableDemo';
import { radius, spacing, useColors } from '../theme';

type Stat = { key: string; icon: IconName; label: string; value: string; unit: string; note?: string };

/** One list of cards from a snapshot: the screen does not care whether the values are demo or real. */
function statsFor(s: WearableSnapshot): Stat[] {
  return [
    { key: 'hr', icon: 'heart', label: 'Heart rate', value: formatValue(s.heartRateBpm), unit: 'bpm' },
    { key: 'hrv', icon: 'activity', label: 'HRV', value: formatValue(s.hrvMs), unit: 'ms' },
    { key: 'steps', icon: 'steps', label: 'Steps', value: formatSteps(s.steps), unit: 'today' },
    {
      key: 'activity',
      icon: 'trendUp',
      label: 'Activity',
      value: formatActivity(s.activityLevel),
      unit: '',
      note: s.activeMinutes === null ? undefined : `${formatValue(s.activeMinutes)} active min`,
    },
    { key: 'sleep', icon: 'moon', label: 'Sleep', value: formatSleep(s.sleepMinutes), unit: 'last night' },
    { key: 'spo2', icon: 'oxygen', label: 'SpO₂', value: formatValue(s.spo2Percent), unit: '%' },
    { key: 'battery', icon: 'battery', label: 'Battery', value: formatValue(s.batteryPercent), unit: '%' },
  ];
}

/**
 * Wearable dashboard. There is no wearable connection yet: the numbers come from `getWearableView()`,
 * which returns flagged sample values, and every card says so. The layout reads a snapshot and nothing
 * else, so real data can replace the samples without changing the screen.
 */
export function WearableScreen({ navigation }: TabScreenProps<'Wearable'>) {
  const colors = useColors();
  const bottomPad = useTabScreenBottomPadding();
  const view = useMemo(() => getWearableView(), []);
  const stats = useMemo(() => (view.snapshot ? statsFor(view.snapshot) : []), [view]);
  const connected = view.connection.state === 'connected';

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.ground }} edges={['top']}>
      <View style={{ paddingHorizontal: spacing.xl, paddingTop: spacing.lg, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text accessibilityRole="header" style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 22, color: colors.ink }}>
          Wearable
        </Text>
        <Avatar onPress={() => navigation.navigate('Profile')} />
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: spacing.xl, paddingTop: spacing.md, paddingBottom: bottomPad, gap: 16 }}>
        {view.isDemo ? (
          <View accessibilityRole="alert" style={{ backgroundColor: colors.amber100, borderRadius: radius.row, padding: 14, gap: 2 }}>
            <Text style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 15, color: colors.amberDark }}>Demo data</Text>
            <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.amberDark, lineHeight: 20 }}>
              These are sample numbers to show the design. They are not your measurements.
            </Text>
          </View>
        ) : null}

        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: colors.blue100, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="watch" size={22} color={colors.blue600} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 16, color: colors.ink }}>
                {connected && view.connection.state === 'connected' ? view.connection.deviceName : 'No wearable connected'}
              </Text>
              <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, lineHeight: 20 }}>
                {connected ? 'Connected' : 'Connecting a wearable is not available yet.'}
              </Text>
            </View>
          </View>
          {!connected ? (
            <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, lineHeight: 20, marginTop: 10 }}>
              When a wearable is connected, its heart rate, sleep and activity will appear here.
            </Text>
          ) : null}
        </Card>

        {view.snapshot === null ? (
          <Card>
            <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 15, color: colors.ink }}>Nothing to show yet</Text>
            <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, lineHeight: 20, marginTop: 4 }}>
              No wearable data has been received.
            </Text>
          </Card>
        ) : (
          <View>
            <Text accessibilityRole="header" style={{ fontFamily: 'Manrope_700Bold', fontSize: 13, color: colors.ink2, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 }}>
              {view.isDemo ? 'Sample statistics (demo)' : 'Today'}
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
              {stats.map((s) => (
                <StatCard key={s.key} stat={s} demo={view.isDemo} />
              ))}
            </View>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const StatCard = React.memo(function StatCard({ stat, demo }: { stat: Stat; demo: boolean }) {
  const colors = useColors();
  return (
    <View
      accessible
      accessibilityLabel={`${stat.label}: ${stat.value} ${stat.unit}${stat.note ? `, ${stat.note}` : ''}${demo ? '. Demo data.' : ''}`}
      style={{ width: '47.5%', flexGrow: 1, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.card, padding: 14, gap: 6 }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: colors.blue100, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name={stat.icon} size={17} color={colors.blue600} />
        </View>
        {demo ? (
          <View style={{ backgroundColor: colors.amber100, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2 }}>
            <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 11, color: colors.amberDark, letterSpacing: 0.5 }}>DEMO</Text>
          </View>
        ) : null}
      </View>
      <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink2 }}>{stat.label}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 5, flexWrap: 'wrap' }}>
        <Text style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 24, color: colors.ink }}>{stat.value}</Text>
        {stat.unit ? <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink2 }}>{stat.unit}</Text> : null}
      </View>
      {stat.note ? <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2 }}>{stat.note}</Text> : null}
    </View>
  );
});
