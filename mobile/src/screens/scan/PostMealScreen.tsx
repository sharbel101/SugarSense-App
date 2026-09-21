import React, { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { GhostButton, PrimaryButton } from '../../components/Buttons';
import { Card } from '../../components/Card';
import { Chip } from '../../components/Chip';
import { GlucoseChart } from '../../components/GlucoseChart';
import { Icon } from '../../components/Icon';
import { bolusSuggestion, latestMeal, postMealChart } from '../../data/mockData';
import { ScanScreenProps } from '../../navigation/types';
import { colors, radius, spacing } from '../../theme';

export function PostMealScreen({ navigation }: ScanScreenProps<'PostMeal'>) {
  const [showCalc, setShowCalc] = useState(false);
  const peakLeftPct = (postMealChart.highlightPoint.x / postMealChart.viewBoxWidth) * 100;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.ground }}>
      <View style={{ paddingHorizontal: spacing.xl, paddingTop: spacing.md, flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <Pressable
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel="Back to meal review"
          style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' }}
        >
          <Icon name="back" size={16} color={colors.ink} />
        </Pressable>
        <Text style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 19, color: colors.ink }}>Meal forecast</Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: spacing.xl, paddingTop: spacing.md, paddingBottom: spacing.xxxl, gap: 16 }}>
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
            Meal confirmed · {latestMeal.name}, {latestMeal.carbs}g carbs
          </Text>
        </View>

        <Card elevated>
          <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 16, color: colors.ink }}>What this could do to your glucose</Text>
          <View style={{ marginTop: 10, position: 'relative' }}>
            <GlucoseChart
              viewBoxWidth={postMealChart.viewBoxWidth}
              viewBoxHeight={postMealChart.viewBoxHeight}
              actual={postMealChart.actual}
              predicted={postMealChart.predicted}
              band={postMealChart.band}
              highlightPoint={postMealChart.highlightPoint}
              height={postMealChart.viewBoxHeight}
            />
            <View
              style={{
                position: 'absolute',
                left: `${Math.max(peakLeftPct - 8, 0)}%`,
                top: 0,
                backgroundColor: colors.ink,
                borderRadius: 12,
                paddingHorizontal: 10,
                paddingVertical: 7,
              }}
            >
              <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 11, color: '#FFFFFF' }}>Peak ~180 mg/dL · 45m</Text>
            </View>
            <View
              style={{
                position: 'absolute',
                right: 4,
                top: 130,
                backgroundColor: colors.surface,
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: 12,
                paddingHorizontal: 9,
                paddingVertical: 6,
              }}
            >
              <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 10.5, color: colors.ink2 }}>~126 by 2h30m</Text>
            </View>
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 2, marginTop: 4 }}>
            {postMealChart.axisLabels.map((label) => (
              <Text key={label} style={{ fontFamily: 'Manrope_500Medium', fontSize: 11, color: colors.ink3 }}>
                {label}
              </Text>
            ))}
          </View>
          <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 13, color: colors.ink2, marginTop: 10, lineHeight: 19 }}>
            Expected rise, peaking near <Text style={{ fontFamily: 'Manrope_700Bold', color: colors.ink }}>180 mg/dL</Text>, then a
            gradual recovery. Range widens further out as certainty naturally decreases.
          </Text>
        </Card>

        <Card>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <View>
              <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 13, color: colors.ink2, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                Suggested bolus
              </Text>
              <Text style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 30, color: colors.ink, marginTop: 4 }}>
                {bolusSuggestion.units} U
              </Text>
            </View>
            <Chip label="Review required" bg={colors.purple100} color={colors.purple600} size="sm" />
          </View>

          <GhostButton
            label="Review calculation"
            onPress={() => setShowCalc((v) => !v)}
            icon={<Icon name="chevronDown" size={13} color={colors.blue600} />}
            style={{ marginTop: 8 }}
          />

          {showCalc ? (
            <View style={{ backgroundColor: colors.ground, borderRadius: radius.row, padding: 14, marginTop: 6, gap: 6 }}>
              {bolusSuggestion.breakdown.map((row) => (
                <View key={row.label} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 13, color: colors.ink2 }}>{row.label}</Text>
                  <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 13, color: colors.ink }}>{row.value}</Text>
                </View>
              ))}
            </View>
          ) : null}

          <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, backgroundColor: colors.amber100, borderRadius: 12, padding: 12 }}>
            <Icon name="alertTriangle" size={16} color={colors.amber600} />
            <Text style={{ flex: 1, fontFamily: 'Manrope_500Medium', fontSize: 12.5, color: colors.amberDark, lineHeight: 18 }}>
              Decision support only — review before dosing. SugarSense never delivers insulin automatically.
            </Text>
          </View>
        </Card>

        <PrimaryButton label="Done" onPress={() => navigation.getParent()?.navigate('Home')} />
      </ScrollView>
    </SafeAreaView>
  );
}
