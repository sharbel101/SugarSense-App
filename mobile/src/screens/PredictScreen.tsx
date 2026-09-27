import React, { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Avatar } from '../components/Avatar';
import { Card } from '../components/Card';
import { Chip } from '../components/Chip';
import { GhostButton } from '../components/Buttons';
import { GlucoseChart } from '../components/GlucoseChart';
import { Icon, IconName } from '../components/Icon';
import { advancedForecastDetails, currentGlucose, forecastFactors, predictChart } from '../data/mockData';
import { TabScreenProps } from '../navigation/types';
import { ColorPalette, radius, spacing, useColors } from '../theme';

function factorPalette(colors: ColorPalette): Record<string, { bg: string; fg: string }> {
  return {
    blue: { bg: colors.blue100, fg: colors.blue600 },
    amber: { bg: colors.amber100, fg: colors.amber600 },
    purple: { bg: colors.purple100, fg: colors.purple600 },
    green: { bg: colors.green100, fg: colors.green600 },
  };
}

export function PredictScreen({ navigation }: TabScreenProps<'Predict'>) {
  const colors = useColors();
  const [showAdvanced, setShowAdvanced] = useState(false);
  const { tooltip } = predictChart;
  const tooltipLeftPct = (predictChart.highlightPoint.x / predictChart.viewBoxWidth) * 100;

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
          Predict
        </Text>
        <Avatar onPress={() => navigation.navigate('Profile')} />
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: spacing.xl, paddingTop: spacing.md, paddingBottom: spacing.xxxl, gap: 16 }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
          <Text style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 30, color: colors.ink }}>{currentGlucose.value}</Text>
          <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink2 }}>mg/dL · steady · now</Text>
        </View>

        <Card elevated>
          <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 13, color: colors.ink2, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Your forecast
          </Text>
          <View style={{ marginTop: 6, position: 'relative' }}>
            <GlucoseChart
              viewBoxWidth={predictChart.viewBoxWidth}
              viewBoxHeight={predictChart.viewBoxHeight}
              actual={predictChart.actual}
              predicted={predictChart.predicted}
              band={predictChart.band}
              nowX={predictChart.nowX}
              highlightPoint={predictChart.highlightPoint}
              gridLinesY={predictChart.gridLinesY}
              height={predictChart.viewBoxHeight}
              accessibilityLabel="Predicted glucose range for the next 2 hours. The shaded band shows the uncertainty and widens further out."
            />
            <View
              style={{
                position: 'absolute',
                left: `${tooltipLeftPct + 4}%`,
                top: 4,
                backgroundColor: colors.ink,
                borderRadius: 14,
                paddingHorizontal: 14,
                paddingVertical: 10,
                width: 152,
              }}
            >
              <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 13, color: colors.onInk }}>{tooltip.minutes} minutes</Text>
              <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 12, color: colors.onInk2, marginTop: 2 }}>
                Median: {tooltip.median} mg/dL
              </Text>
              <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 12, color: colors.onInk2 }}>
                Range: {tooltip.low}–{tooltip.high} mg/dL
              </Text>
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 2, marginTop: 4 }}>
              {predictChart.axisLabels.map((label) => (
                <Text key={label} style={{ fontFamily: 'Manrope_500Medium', fontSize: 11, color: colors.ink3 }}>
                  {label}
                </Text>
              ))}
            </View>
          </View>
          <GhostButton
            label="Why this forecast?"
            onPress={() => setShowAdvanced((v) => !v)}
            icon={<Icon name="chevronDown" size={14} color={colors.blue600} />}
          />
        </Card>

        <Chip label="Prediction confidence: High" bg={colors.blue100} color={colors.blue600} />

        <Card style={{ padding: 6 }}>
          <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 15, color: colors.ink, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 2 }}>
            Why this forecast?
          </Text>
          {forecastFactors.map((factor) => (
            <FactorRow key={factor.label} icon={factor.icon} bg={factor.bg} label={factor.label} value={factor.value} />
          ))}

          <View style={{ borderTopWidth: 1, borderTopColor: colors.divider, paddingHorizontal: 12, paddingBottom: 2 }}>
            <GhostButton
              label={showAdvanced ? 'Hide advanced details' : 'Advanced details'}
              onPress={() => setShowAdvanced((v) => !v)}
            />
            {showAdvanced ? (
              <View style={{ backgroundColor: colors.ground, borderRadius: radius.row, padding: 14, marginTop: 6 }}>
                <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, lineHeight: 21 }}>
                  {advancedForecastDetails}
                </Text>
              </View>
            ) : null}
          </View>
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

function FactorRow({ icon, bg, label, value }: { icon: IconName; bg: string; label: string; value: string }) {
  const colors = useColors();
  const palettes = factorPalette(colors);
  const palette = palettes[bg] ?? palettes.blue;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingVertical: 9 }}>
      <View style={{ width: 30, height: 30, borderRadius: 10, backgroundColor: palette.bg, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={icon} size={15} color={palette.fg} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink }}>{label}</Text>
        <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 13, color: colors.ink2 }}>{value}</Text>
      </View>
    </View>
  );
}
