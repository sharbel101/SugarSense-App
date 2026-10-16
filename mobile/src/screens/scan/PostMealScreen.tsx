import React from 'react';
import { ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BackButton, PrimaryButton } from '../../components/Buttons';
import { Card } from '../../components/Card';
import { Icon } from '../../components/Icon';
import { ScanScreenProps } from '../../navigation/types';
import { spacing, useColors } from '../../theme';

export function PostMealScreen({ navigation, route }: ScanScreenProps<'PostMeal'>) {
  const colors = useColors();
  const { meal } = route.params;
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

        <Card>
          <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 16, color: colors.ink }}>Forecast and dose suggestion</Text>
          <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, marginTop: 8, lineHeight: 20 }}>
            A forecast for this meal and a dose suggestion are not available yet.
          </Text>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, backgroundColor: colors.amber100, borderRadius: 12, padding: 12 }}>
            <Icon name="alertTriangle" size={16} color={colors.amber600} />
            <Text style={{ flex: 1, fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.amberDark, lineHeight: 20 }}>
              Decision support only — not medical advice. SugarSense never delivers insulin automatically.
            </Text>
          </View>
        </Card>
      </ScrollView>

      {/* The primary action sits in the thumb zone, pinned above the home indicator. */}
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
