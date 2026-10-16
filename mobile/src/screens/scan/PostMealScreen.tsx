import React from 'react';
import { ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BackButton, PrimaryButton, SecondaryButton } from '../../components/Buttons';
import { Card } from '../../components/Card';
import { ForecastChartBlock } from '../../components/ForecastExtras';
import { Icon } from '../../components/Icon';
import { useQuickAdd } from '../../components/QuickAdd';
import { ScanScreenProps } from '../../navigation/types';
import { useGlucose } from '../../services/GlucoseProvider';
import { spacing, useColors } from '../../theme';

export function PostMealScreen({ navigation, route }: ScanScreenProps<'PostMeal'>) {
  const colors = useColors();
  const { meal, mealRef, forecastNote } = route.params;
  const { view } = useGlucose();
  const { open } = useQuickAdd();

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.ground }}>
      <View style={{ paddingHorizontal: spacing.xl, paddingTop: spacing.md, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <BackButton onPress={() => navigation.goBack()} accessibilityLabel="Back to meal review" />
        <Text accessibilityRole="header" style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 20, color: colors.ink }}>
          Meal forecast
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
          <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 13, color: colors.green600 }}>
            Meal confirmed · {meal.label}, {Math.round(meal.totalCarbsG)}g carbs{meal.edited ? ' (edited)' : ''}
          </Text>
        </View>

        {mealRef.pending ? (
          <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.amberDark, lineHeight: 20 }}>
            Not sent to the server yet - the forecast does not include this meal. It is kept on this device and sent when the connection is back.
          </Text>
        ) : null}

        <Card elevated>
          <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 16, color: colors.ink }}>Forecast based on what you logged</Text>
          <View style={{ marginTop: 10 }}>
            {view.kind === 'ok' ? (
              <ForecastChartBlock data={view.data} height={170} />
            ) : (
              <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, lineHeight: 20 }}>
                The forecast is not available right now because there is no recent glucose reading.
              </Text>
            )}
          </View>
          {forecastNote ? (
            <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, marginTop: 10, lineHeight: 20 }}>{forecastNote}</Text>
          ) : null}
        </Card>

        <Card>
          <Text accessibilityRole="header" style={{ fontFamily: 'Manrope_700Bold', fontSize: 16, color: colors.ink }}>
            Did you take insulin for this meal?
          </Text>
          <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, marginTop: 6, lineHeight: 20 }}>
            Without an insulin record the forecast line does not move for this meal, and the range is wider. SugarSense never tells you how much to
            take.
          </Text>
          <View style={{ gap: 10, marginTop: 12 }}>
            <PrimaryButton label="Record insulin taken" onPress={() => open({ mode: 'insulin', meal: mealRef })} />
            <SecondaryButton label="I took none" onPress={() => open({ mode: 'none', meal: mealRef })} />
            <SecondaryButton label="Not yet" onPress={() => navigation.getParent()?.navigate('Home')} />
          </View>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, backgroundColor: colors.amber100, borderRadius: 12, padding: 12 }}>
            <Icon name="alertTriangle" size={16} color={colors.amber600} />
            <Text style={{ flex: 1, fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.amberDark, lineHeight: 20 }}>
              Decision support only — not medical advice. SugarSense never delivers insulin automatically.
            </Text>
          </View>
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
