import React from 'react';
import { Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Avatar } from '../components/Avatar';
import { useTabScreenBottomPadding } from '../components/QuickAdd';
import { Card } from '../components/Card';
import { Icon } from '../components/Icon';
import { AlertsControlCard, PredictedRiskCard } from '../components/PredictedRiskCards';
import { PullToRefreshScrollView } from '../components/PullToRefreshScrollView';
import { TabScreenProps } from '../navigation/types';
import { useGlucose } from '../services/GlucoseProvider';
import { spacing, useColors } from '../theme';

export function SafetyScreen({ navigation }: TabScreenProps<'Safety'>) {
  const colors = useColors();
  const bottomPad = useTabScreenBottomPadding();
  const { refresh, refreshing } = useGlucose();
  // Opens Predict scrolled to the graph of blood sugar, insulin and carbs (a new number each tap).
  const showGraph = () => navigation.navigate('Predict', { showGraph: Date.now() });

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

      <PullToRefreshScrollView onRefresh={refresh} refreshing={refreshing} contentContainerStyle={{ paddingHorizontal: spacing.xl, paddingTop: spacing.md, paddingBottom: bottomPad, gap: 14 }}>
        <PredictedRiskCard kind="low" onPress={showGraph} />
        <PredictedRiskCard kind="high" onPress={showGraph} />
        <AlertsControlCard />

        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <View style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: colors.blue100, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="shield" size={16} color={colors.blue600} />
            </View>
            <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 15, color: colors.ink }}>No safety details yet</Text>
          </View>
          <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, lineHeight: 21 }}>
            The glucose risk signal is shown on Home. Wearable and data-quality details will appear here once they are connected.
          </Text>
        </Card>
      </PullToRefreshScrollView>
    </SafeAreaView>
  );
}
