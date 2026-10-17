import { useNavigation } from '@react-navigation/native';
import React from 'react';
import { ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BackButton, PrimaryButton } from '../../components/Buttons';
import { Card } from '../../components/Card';
import { DoseConfirmCard } from '../../components/DoseConfirmCard';
import { ForecastChartBlock } from '../../components/ForecastExtras';
import { Icon } from '../../components/Icon';
import { ScanScreenProps } from '../../navigation/types';
import { useEvents } from '../../services/EventsProvider';
import { useForecast } from '../../services/ForecastProvider';
import { useGlucose } from '../../services/GlucoseProvider';
import { spacing, useColors } from '../../theme';

export function PostMealScreen({ navigation, route }: ScanScreenProps<'PostMeal'>) {
  const colors = useColors();
  const rootNav = useNavigation();
  const { meal, mealRef, forecastNote } = route.params;
  const { view } = useGlucose();
  const { view: forecastView } = useForecast();
  // Only claim the meal is in the forecast when the server's own event list says so.
  const mealInForecast =
    forecastView.kind === 'ok' && forecastView.data.mealAware.events.some((e) => e.type === 'meal' && e.id === mealRef.key);
  const { records } = useEvents();
  // The meal may have been queued when the person confirmed it: read whether the server has it NOW.
  const mealRecord = records.find((r) => r.event.id === mealRef.key);
  const mealPending = mealRecord ? mealRecord.status !== 'saved' : mealRef.pending;
  // Insulin the person recorded for THIS meal on this device (taken, or an explicit 0 U).
  const insulinForMeal = records.find(
    (r) => r.event.kind === 'insulin' && r.event.mealId === mealRef.key && r.status !== 'failed',
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.ground }}>
      <View style={{ paddingHorizontal: spacing.xl, paddingTop: spacing.md, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <BackButton onPress={() => navigation.goBack()} accessibilityLabel="Back to meal review" />
        <Text accessibilityRole="header" style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 20, color: colors.ink }}>
          Meal saved
        </Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: spacing.xl, paddingTop: spacing.md, paddingBottom: spacing.lg, gap: 16 }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            backgroundColor: colors.green100,
            paddingHorizontal: 14,
            paddingVertical: 8,
            borderRadius: 14,
            alignSelf: 'flex-start',
          }}
        >
          <Icon name="check" size={15} color={colors.green600} />
          <Text style={{ flexShrink: 1, fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.green600 }}>
            {meal.label} · {Math.round(meal.totalCarbsG)} g carbs{meal.edited ? ' (edited)' : ''}
          </Text>
        </View>

        {mealPending ? (
          <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.amberDark, lineHeight: 20 }}>
            Not sent to the server yet - the forecast does not include this meal. It is kept on this device and sent when the connection is back.
          </Text>
        ) : null}

        <DoseConfirmCard
          carbsG={meal.totalCarbsG}
          mealTimeIso={mealRef.occurredAtUtc}
          mealKey={mealRef.key}
          onOpenSettings={() => rootNav.navigate('InsulinSettings' as never)}
          onDone={() => navigation.getParent()?.navigate('Home')}
          hideDone
        />

        <Card>
          <Text accessibilityRole="header" style={{ fontFamily: 'Manrope_700Bold', fontSize: 14, color: colors.ink2, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Predicted glucose
          </Text>
          <View style={{ marginTop: 8 }}>
            {view.kind === 'ok' ? (
              <ForecastChartBlock data={view.data} height={150} compact />
            ) : (
              <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, lineHeight: 20 }}>
                The forecast is not available right now because there is no recent glucose reading.
              </Text>
            )}
          </View>
          <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, marginTop: 8, lineHeight: 20 }}>
            {forecastNote ??
              (mealInForecast
                ? insulinForMeal
                  ? 'Includes the meal and the insulin you recorded for it.'
                  : 'Includes the meal you just saved. Until insulin for it is recorded, the line stays put and the range is wider.'
                : 'The forecast will include this meal on the next update.')}
          </Text>
        </Card>

      </ScrollView>

      <View
        style={{
          paddingHorizontal: spacing.xl,
          paddingTop: spacing.md,
          paddingBottom: spacing.md,
          borderTopWidth: 1,
          borderTopColor: colors.divider,
          backgroundColor: colors.ground,
        }}
      >
        <PrimaryButton label="Done" onPress={() => navigation.getParent()?.navigate('Home')} />
      </View>
    </SafeAreaView>
  );
}

