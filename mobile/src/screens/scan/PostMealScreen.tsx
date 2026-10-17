import { useNavigation } from '@react-navigation/native';
import React, { useMemo } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BackButton, PrimaryButton, SecondaryButton } from '../../components/Buttons';
import { Card } from '../../components/Card';
import { ForecastChartBlock } from '../../components/ForecastExtras';
import { Icon } from '../../components/Icon';
import { useQuickAdd } from '../../components/QuickAdd';
import { ScanScreenProps } from '../../navigation/types';
import { useForecast } from '../../services/ForecastProvider';
import { useGlucose } from '../../services/GlucoseProvider';
import { estimateMealInsulin, LOW_GLUCOSE_MGDL, type InsulinEstimate } from '../../services/mealInsulinEstimate';
import { useSavedRatio } from '../../services/useSavedRatio';
import { radius, spacing, useColors } from '../../theme';

export function PostMealScreen({ navigation, route }: ScanScreenProps<'PostMeal'>) {
  const colors = useColors();
  const rootNav = useNavigation();
  const { meal, mealRef, forecastNote } = route.params;
  const { view } = useGlucose();
  const { view: forecastView } = useForecast();
  // Only claim the meal is in the forecast when the server's own event list says so.
  const mealInForecast =
    forecastView.kind === 'ok' && forecastView.data.mealAware.events.some((e) => e.type === 'meal' && e.id === mealRef.key);
  const { open } = useQuickAdd();
  const saved = useSavedRatio();

  const latestGlucose = view.kind === 'ok' ? view.data.glucoseMgdl : null;
  const estimate: InsulinEstimate | null = useMemo(
    () =>
      saved.loading
        ? null
        : estimateMealInsulin({
            carbsG: meal.totalCarbsG,
            ratio: saved.ratio,
            mealTime: new Date(mealRef.occurredAtUtc),
            latestGlucoseMgdl: latestGlucose,
          }),
    [saved, meal.totalCarbsG, mealRef.occurredAtUtc, latestGlucose],
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

        {mealRef.pending ? (
          <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.amberDark, lineHeight: 20 }}>
            Not sent to the server yet - the forecast does not include this meal. It is kept on this device and sent when the connection is back.
          </Text>
        ) : null}

        <Card elevated>
          <Text accessibilityRole="header" style={{ fontFamily: 'Manrope_700Bold', fontSize: 14, color: colors.ink2, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Suggested meal insulin
          </Text>
          {estimate === null ? (
            <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, marginTop: 8 }}>Reading your saved ratio...</Text>
          ) : estimate.kind === 'ok' ? (
            <>
              <Text accessibilityLiveRegion="polite" style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 34, color: colors.ink, marginTop: 4 }}>
                {estimate.unitsText} <Text style={{ fontSize: 18, fontFamily: 'Manrope_700Bold', color: colors.ink2 }}>{estimate.unitsText === '1' ? 'unit' : 'units'}</Text>
              </Text>
              <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink, marginTop: 4 }}>{estimate.explanation}</Text>
              <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, marginTop: 8, lineHeight: 20 }}>
                Suggested from your saved ratio only (1 unit : {Math.round(estimate.gramsPerUnit * 100) / 100} g). It does not include glucose correction, insulin on board,
                exercise or illness. Check before using; it is not an instruction.
              </Text>
            </>
          ) : (
            <EstimateProblem estimate={estimate} onSettings={() => rootNav.navigate('InsulinSettings' as never)} />
          )}
        </Card>

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
                ? 'Includes the meal you just saved. Until insulin for it is recorded, the line stays put and the range is wider.'
                : 'The forecast will include this meal on the next update.')}
          </Text>
        </Card>

        <Card>
          <Text accessibilityRole="header" style={{ fontFamily: 'Manrope_700Bold', fontSize: 16, color: colors.ink }}>
            Did you take insulin for this meal?
          </Text>
          <View style={{ gap: 10, marginTop: 12 }}>
            <PrimaryButton label="Record insulin taken" onPress={() => open({ mode: 'insulin', meal: mealRef })} />
            <SecondaryButton label="I took none" onPress={() => open({ mode: 'none', meal: mealRef })} />
          </View>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, backgroundColor: colors.amber100, borderRadius: radius.row, padding: 12 }}>
            <Icon name="alertTriangle" size={16} color={colors.amber600} />
            <Text style={{ flex: 1, fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.amberDark, lineHeight: 20 }}>
              Not medical advice. SugarSense never delivers insulin automatically.
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

function EstimateProblem({ estimate, onSettings }: { estimate: Exclude<InsulinEstimate, { kind: 'ok' }>; onSettings: () => void }) {
  const colors = useColors();
  const text = (() => {
    switch (estimate.kind) {
      case 'ratio_not_set':
        return 'No insulin-to-carb ratio is saved yet, so there is nothing to calculate from.';
      case 'ratio_unavailable':
        return 'Your saved ratio could not be read right now. No estimate is shown.';
      case 'ratio_invalid':
        return 'The saved ratio has no valid value for this time of day. Check it in Insulin settings.';
      case 'low_glucose':
        return `Your latest glucose is ${Math.round(estimate.glucoseMgdl)} mg/dL (below ${LOW_GLUCOSE_MGDL}). No estimate is shown. Deal with the low first.`;
      case 'too_high':
        return `The calculation gives ${estimate.units} units, which is above the safety limit this app will show. Check the carbs and your ratio.`;
      case 'no_carbs':
        return 'There are no carbohydrates to calculate from.';
    }
  })();
  const needsSettings = estimate.kind === 'ratio_not_set' || estimate.kind === 'ratio_invalid' || estimate.kind === 'too_high';
  return (
    <View style={{ gap: 10, marginTop: 8 }}>
      <Text accessibilityLiveRegion="polite" style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink, lineHeight: 20 }}>
        {text}
      </Text>
      {needsSettings ? <SecondaryButton label="Open insulin settings" onPress={onSettings} /> : null}
    </View>
  );
}
