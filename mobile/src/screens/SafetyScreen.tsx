import React from 'react';
import { Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Avatar } from '../components/Avatar';
import { useTabScreenBottomPadding } from '../components/QuickAdd';
import { AlertsControlCard, PredictedRiskCard } from '../components/PredictedRiskCards';
import { PullToRefreshScrollView } from '../components/PullToRefreshScrollView';
import { TabScreenProps } from '../navigation/types';
import { useGlucose } from '../services/GlucoseProvider';
import { useRiskAlerts } from '../services/RiskAlertsProvider';
import { spacing, useColors } from '../theme';

export function SafetyScreen({ navigation }: TabScreenProps<'Safety'>) {
  const colors = useColors();
  const bottomPad = useTabScreenBottomPadding();
  const { refresh, refreshing } = useGlucose();
  const { enabled, permission } = useRiskAlerts();
  // Opens the Predict page at its top (a new number each tap, so it also resets a page scrolled down earlier).
  const showPredictions = () => navigation.navigate('Predict', { toTop: Date.now() });

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
          Safety
        </Text>
        <Avatar onPress={() => navigation.navigate('Profile')} />
      </View>

      <PullToRefreshScrollView onRefresh={refresh} refreshing={refreshing} contentContainerStyle={{ flexGrow: 1, paddingHorizontal: spacing.xl, paddingTop: spacing.md, paddingBottom: bottomPad, gap: 14 }}>
        <PredictedRiskCard kind="low" onPress={showPredictions} />
        <PredictedRiskCard kind="high" onPress={showPredictions} />
        {/* Once alerts are on there is nothing left to set up here; test and turn off live in Profile. */}
        {enabled && permission === 'granted' ? null : <AlertsControlCard />}
      </PullToRefreshScrollView>
    </SafeAreaView>
  );
}
