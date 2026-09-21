import { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, shadow } from '../theme';
import { Icon, IconName } from './Icon';

const TAB_META: Record<string, { label: string; icon: IconName }> = {
  Home: { label: 'Home', icon: 'home' },
  Predict: { label: 'Predict', icon: 'trending' },
  Scan: { label: 'Scan', icon: 'camera' },
  Safety: { label: 'Safety', icon: 'shield' },
  Insights: { label: 'Insights', icon: 'sparkle' },
};

/**
 * Bottom navigation matching the SugarSense design: five destinations with
 * the Scan action raised and emphasized, and an active-item pill borrowed
 * from Material 3's navigation bar.
 */
export function CustomTabBar({ state, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[
        {
          flexDirection: 'row',
          justifyContent: 'space-around',
          alignItems: 'flex-start',
          backgroundColor: colors.surface,
          borderTopWidth: 1,
          borderTopColor: colors.border,
          paddingTop: 8,
          paddingBottom: insets.bottom + 6,
        },
        shadow.nav,
      ]}
    >
      {state.routes.map((route, index) => {
        const isFocused = state.index === index;
        const meta = TAB_META[route.name] ?? { label: route.name, icon: 'home' as IconName };

        const onPress = () => {
          const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
          if (!isFocused && !event.defaultPrevented) {
            navigation.navigate(route.name);
          }
        };

        if (route.name === 'Scan') {
          return (
            <Pressable
              key={route.key}
              onPress={onPress}
              accessibilityRole="button"
              accessibilityLabel="Scan a meal"
              style={{ width: 60, alignItems: 'center' }}
            >
              <View
                style={[
                  {
                    width: 60,
                    height: 60,
                    borderRadius: 30,
                    backgroundColor: colors.blue600,
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginTop: -30,
                  },
                  shadow.fab,
                ]}
              >
                <Icon name="camera" size={26} color="#FFFFFF" strokeWidth={1.8} />
              </View>
              <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 11, color: colors.ink3, marginTop: 2 }}>
                {meta.label}
              </Text>
            </Pressable>
          );
        }

        return (
          <Pressable
            key={route.key}
            onPress={onPress}
            accessibilityRole="button"
            accessibilityState={isFocused ? { selected: true } : {}}
            accessibilityLabel={meta.label}
            style={{ width: 60, alignItems: 'center', gap: 4 }}
          >
            <View
              style={{
                width: 56,
                height: 30,
                borderRadius: 15,
                backgroundColor: isFocused ? colors.blue100 : 'transparent',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icon name={meta.icon} size={21} color={isFocused ? colors.blue600 : colors.ink3} strokeWidth={isFocused ? 2 : 1.8} />
            </View>
            <Text
              style={{
                fontFamily: isFocused ? 'Manrope_700Bold' : 'Manrope_600SemiBold',
                fontSize: 11,
                color: isFocused ? colors.blue600 : colors.ink3,
              }}
            >
              {meta.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
