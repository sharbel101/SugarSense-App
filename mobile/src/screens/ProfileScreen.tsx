import { NativeStackScreenProps } from '@react-navigation/native-stack';
import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BackButton } from '../components/Buttons';
import { Icon, IconName } from '../components/Icon';
import { AlertsControlCard } from '../components/PredictedRiskCards';
import { PullToRefreshScrollView } from '../components/PullToRefreshScrollView';
import { SegmentedControl, SegmentOption } from '../components/SegmentedControl';
import { RootStackParamList } from '../navigation/types';
import { useGlucose } from '../services/GlucoseProvider';
import { setToastPref, useToastPref } from '../services/toastPrefs';
import { CheckRow } from '../components/FormField';
import { radius, spacing, ThemePreference, useColors, useTheme } from '../theme';

type Row = { icon: IconName; label: string; badge?: string };

const THEME_OPTIONS: SegmentOption<ThemePreference>[] = [
  { value: 'system', label: 'System', accessibilityLabel: 'Use the device appearance' },
  { value: 'light', label: 'Light', accessibilityLabel: 'Use light appearance' },
  { value: 'dark', label: 'Dark', accessibilityLabel: 'Use dark appearance' },
];

const SECTIONS: { title?: string; rows: Row[] }[] = [
  { title: 'Account', rows: [{ icon: 'person', label: 'Personal information' }, { icon: 'bell', label: 'Notifications' }] },
  {
    title: 'Diabetes',
    rows: [
      { icon: 'droplet', label: 'Diabetes settings' },
      { icon: 'target', label: 'Glucose targets' },
      { icon: 'droplet', label: 'Insulin settings' },
    ],
  },
  {
    title: 'Devices',
    rows: [
      { icon: 'wifi', label: 'Connected CGM', badge: 'Connected' },
      { icon: 'heart', label: 'Connected wearable', badge: 'Connected' },
    ],
  },
  {
    title: 'Data & privacy',
    rows: [
      { icon: 'sparkle', label: 'Personalization' },
      { icon: 'lock', label: 'Privacy' },
      { icon: 'download', label: 'Data' },
    ],
  },
  { rows: [{ icon: 'info', label: 'About SugarSense' }] },
];

export function ProfileScreen({ navigation }: NativeStackScreenProps<RootStackParamList, 'Profile'>) {
  const { colors, preference, setPreference } = useTheme();
  const toastsOn = useToastPref();
  const { refresh, refreshing } = useGlucose();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.ground }}>
      <View
        style={{
          paddingHorizontal: spacing.xl,
          paddingTop: spacing.lg,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <BackButton onPress={() => navigation.goBack()} accessibilityLabel="Close" />
        <Text accessibilityRole="header" style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 20, color: colors.ink }}>
          Profile & settings
        </Text>
      </View>

      <PullToRefreshScrollView onRefresh={refresh} refreshing={refreshing} contentContainerStyle={{ paddingHorizontal: spacing.xl, paddingTop: spacing.sm, paddingBottom: spacing.xxxl, gap: 20 }}>
        <View style={{ alignItems: 'center', gap: 8, paddingVertical: 8 }}>
          <View style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: colors.blue100, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="person" size={32} color={colors.blue600} strokeWidth={1.6} />
          </View>
          <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 16, color: colors.ink }}>Your account</Text>
          <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 13, color: colors.ink3 }}>
            Managed by you · Connected to SugarSense
          </Text>
        </View>

        <View>
          <SectionTitle>Appearance</SectionTitle>
          <SegmentedControl options={THEME_OPTIONS} value={preference} onChange={setPreference} />
          <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 13, color: colors.ink3, paddingHorizontal: 4, marginTop: 8 }}>
            System follows the light or dark setting of your device.
          </Text>
        </View>

        <View>
          <SectionTitle>Alerts</SectionTitle>
          <AlertsControlCard />
          <View style={{ marginTop: 12 }}>
            <CheckRow checked={toastsOn} onChange={setToastPref} label="Show in-app toasts (saved entries, forecast updates, alerts)" />
          </View>
        </View>

        {SECTIONS.map((section, sIndex) => (
          <View key={section.title ?? `section-${sIndex}`}>
            {section.title ? <SectionTitle>{section.title}</SectionTitle> : null}
            <View style={{ backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.row }}>
              {section.rows.map((row, index) => (
                <Pressable
                  key={row.label}
                  onPress={() => {
                    if (row.label === 'Insulin settings') navigation.navigate('InsulinSettings');
                  }}
                  accessibilityRole="button"
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 12,
                    paddingHorizontal: 16,
                    paddingVertical: 14,
                    borderBottomWidth: index === section.rows.length - 1 ? 0 : 1,
                    borderBottomColor: colors.divider,
                  }}
                >
                  <View style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: colors.blue100, alignItems: 'center', justifyContent: 'center' }}>
                    <Icon name={row.icon} size={16} color={colors.blue600} />
                  </View>
                  <Text style={{ flex: 1, fontFamily: 'Manrope_600SemiBold', fontSize: 15, color: colors.ink }}>{row.label}</Text>
                  {row.badge ? (
                    <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 13, color: colors.green600 }}>{row.badge}</Text>
                  ) : null}
                  <Icon name="chevronRight" size={16} color={colors.ink4} />
                </Pressable>
              ))}
            </View>
          </View>
        ))}
      </PullToRefreshScrollView>
    </SafeAreaView>
  );
}

function SectionTitle({ children }: { children: string }) {
  const colors = useColors();
  return (
    <Text
      accessibilityRole="header"
      style={{
        fontFamily: 'Manrope_700Bold',
        fontSize: 12,
        color: colors.ink3,
        textTransform: 'uppercase',
        letterSpacing: 0.6,
        paddingHorizontal: 4,
        marginBottom: 8,
      }}
    >
      {children}
    </Text>
  );
}
