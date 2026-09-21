import React, { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Avatar } from '../components/Avatar';
import { Card } from '../components/Card';
import { Chip } from '../components/Chip';
import { Icon } from '../components/Icon';
import { safetyAttention, safetyNormal, wearableAttention, wearableNormal } from '../data/mockData';
import { TabScreenProps } from '../navigation/types';
import { colors, radius, spacing } from '../theme';

type Severity = 'normal' | 'attention';

export function SafetyScreen({ navigation }: TabScreenProps<'Safety'>) {
  const [severity, setSeverity] = useState<Severity>('normal');

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
        <Text style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 22, color: colors.ink }}>Safety</Text>
        <Avatar onPress={() => navigation.navigate('Profile')} />
      </View>

      <View style={{ paddingHorizontal: spacing.xl, marginTop: spacing.sm }}>
        <SeveritySwitch value={severity} onChange={setSeverity} />
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: spacing.xl, paddingTop: spacing.md, paddingBottom: spacing.xxxl, gap: 14 }}>
        {severity === 'normal' ? (
          <View style={{ backgroundColor: colors.green100, borderRadius: radius.hero, padding: 22, gap: 10 }}>
            <IconBadge>
              <Icon name="shield" size={26} color={colors.green600} />
            </IconBadge>
            <Text style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 22, color: colors.greenDark, letterSpacing: 0.4 }}>
              {safetyNormal.headline}
            </Text>
            <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.greenDark2, lineHeight: 20 }}>
              {safetyNormal.message}
            </Text>
          </View>
        ) : (
          <View style={{ backgroundColor: colors.amber100, borderRadius: radius.hero, padding: 22, gap: 10 }}>
            <IconBadge>
              <Icon name="alertTriangle" size={26} color={colors.amber600} />
            </IconBadge>
            <Text style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 22, color: colors.amberDark, letterSpacing: 0.4 }}>
              {safetyAttention.headline}
            </Text>
            <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.amberDark, lineHeight: 20 }}>
              {safetyAttention.message}
            </Text>
          </View>
        )}

        {severity === 'normal' ? (
          <Card>
            <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 13, color: colors.ink2, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 }}>
              Short-term risk window
            </Text>
            <View style={{ height: 10, borderRadius: 6, backgroundColor: colors.green100 }}>
              <View
                style={{
                  position: 'absolute',
                  left: 0,
                  top: -3,
                  width: 16,
                  height: 16,
                  borderRadius: 8,
                  backgroundColor: colors.green600,
                  borderWidth: 3,
                  borderColor: colors.surface,
                }}
              />
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 }}>
              <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 11.5, color: colors.ink3 }}>Now</Text>
              <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 11.5, color: colors.ink3 }}>+1h</Text>
              <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 11.5, color: colors.ink3 }}>+2h</Text>
            </View>
          </Card>
        ) : (
          <Card>
            <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 15, color: colors.ink, marginBottom: 10 }}>Why?</Text>
            {safetyAttention.factors.map((factor) => (
              <View key={factor.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 9 }}>
                <View style={{ width: 30, height: 30, borderRadius: 10, backgroundColor: colors.amber100, alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name={factor.icon} size={15} color={colors.amber600} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink }}>{factor.label}</Text>
                  <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 12.5, color: colors.ink2 }}>{factor.value}</Text>
                </View>
              </View>
            ))}
            <View style={{ flexDirection: 'row', marginTop: 6, borderTopWidth: 1, borderTopColor: colors.divider, paddingTop: 12 }}>
              <Chip label={`Data quality: ${safetyAttention.dataQuality}`} bg={colors.green100} color={colors.green600} />
            </View>
          </Card>
        )}

        {severity === 'normal' ? (
          <Card style={{ padding: 0 }}>
            <DetailRow label="Hypoglycemia risk" value={safetyNormal.hypoRisk} valueColor={colors.green600} />
            <DetailRow label="Current glucose trend" value={safetyNormal.trend} />
            <DetailRow label="Wearable status" value={safetyNormal.wearableStatus} valueColor={colors.green600} />
            <DetailRow label="Data quality" value={safetyNormal.dataQuality} last />
          </Card>
        ) : (
          <Card>
            <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink }}>
              {safetyAttention.suggestion.title}
            </Text>
            <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 12.5, color: colors.ink2, marginTop: 4, lineHeight: 18 }}>
              {safetyAttention.suggestion.body}
            </Text>
          </Card>
        )}

        <Card>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 15, color: colors.ink }}>Wearable</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: colors.green600 }} />
              <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 12.5, color: colors.green600 }}>Connected</Text>
            </View>
          </View>
          <View style={{ flexDirection: 'row' }}>
            <Metric label="HR" value={`${severity === 'normal' ? wearableNormal.hr : wearableAttention.hr} bpm`} />
            <Metric label="HRV" value={`${severity === 'normal' ? wearableNormal.hrv : wearableAttention.hrv} ms`} />
            <Metric label="Movement" value={severity === 'normal' ? wearableNormal.movement : wearableAttention.movement} />
            <Metric label="Coverage" value={severity === 'normal' ? wearableNormal.coverage : wearableAttention.coverage} />
          </View>
          <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 12, color: colors.ink3, marginTop: 12, borderTopWidth: 1, borderTopColor: colors.divider, paddingTop: 10, lineHeight: 17 }}>
            Wearable context is contributing to your risk assessment.
          </Text>
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

function SeveritySwitch({ value, onChange }: { value: Severity; onChange: (v: Severity) => void }) {
  return (
    <View style={{ flexDirection: 'row', backgroundColor: colors.divider, borderRadius: radius.pill, padding: 3 }}>
      {(['normal', 'attention'] as Severity[]).map((option) => (
        <Pressable
          key={option}
          onPress={() => onChange(option)}
          accessibilityRole="button"
          accessibilityLabel={`Preview ${option} state`}
          style={{
            flex: 1,
            paddingVertical: 8,
            borderRadius: radius.pill,
            alignItems: 'center',
            backgroundColor: value === option ? colors.surface : 'transparent',
          }}
        >
          <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 12.5, color: value === option ? colors.ink : colors.ink3 }}>
            Preview: {option === 'normal' ? 'Normal' : 'Attention'}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function IconBadge({ children }: { children: React.ReactNode }) {
  return (
    <View style={{ width: 52, height: 52, borderRadius: 16, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' }}>
      {children}
    </View>
  );
}

function DetailRow({ label, value, valueColor, last }: { label: string; value: string; valueColor?: string; last?: boolean }) {
  return (
    <View
      style={{
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: 18,
        paddingVertical: 14,
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: colors.divider,
      }}
    >
      <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2 }}>{label}</Text>
      <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 14, color: valueColor ?? colors.ink }}>{value}</Text>
    </View>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flex: 1 }}>
      <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 11.5, color: colors.ink3 }}>{label}</Text>
      <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 15, color: colors.ink, marginTop: 2 }}>{value}</Text>
    </View>
  );
}
