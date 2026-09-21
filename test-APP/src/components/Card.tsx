import React from 'react';
import { Pressable, StyleProp, View, ViewStyle } from 'react-native';
import { colors, radius, shadow } from '../theme';

type Point = { x: number; y: number };

type Props = {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  onPress?: () => void;
  elevated?: boolean;
  accessibilityLabel?: string;
};

export function Card({ children, style, onPress, elevated, accessibilityLabel }: Props) {
  const base = [
    {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.card,
      padding: 18,
    },
    elevated ? shadow.card : null,
    style,
  ];

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        style={({ pressed }) => [base, pressed ? { opacity: 0.85 } : null]}
      >
        {children}
      </Pressable>
    );
  }

  return <View style={base}>{children}</View>;
}

export type { Point };
