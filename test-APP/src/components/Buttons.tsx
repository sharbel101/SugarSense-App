import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { colors, radius, shadow } from '../theme';

type ButtonProps = {
  label: string;
  onPress: () => void;
  style?: object;
  disabled?: boolean;
};

export function PrimaryButton({ label, onPress, style, disabled }: ButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={({ pressed }) => [
        {
          backgroundColor: disabled ? colors.ink4 : colors.blue600,
          borderRadius: radius.row,
          paddingVertical: 16,
          alignItems: 'center',
          justifyContent: 'center',
        },
        !disabled ? shadow.fab : null,
        pressed ? { opacity: 0.9 } : null,
        style,
      ]}
    >
      <Text style={{ color: '#FFFFFF', fontFamily: 'Manrope_700Bold', fontSize: 15 }}>{label}</Text>
    </Pressable>
  );
}

export function SecondaryButton({ label, onPress, style, disabled }: ButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={({ pressed }) => [
        {
          backgroundColor: colors.surface,
          borderWidth: 1.5,
          borderColor: colors.ink4,
          borderRadius: radius.row,
          paddingVertical: 15,
          alignItems: 'center',
          justifyContent: 'center',
        },
        pressed ? { opacity: 0.85 } : null,
        style,
      ]}
    >
      <Text style={{ color: colors.ink, fontFamily: 'Manrope_700Bold', fontSize: 15 }}>{label}</Text>
    </Pressable>
  );
}

export function GhostButton({
  label,
  onPress,
  icon,
  style,
}: {
  label: string;
  onPress: () => void;
  icon?: React.ReactNode;
  style?: object;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [
        { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 6 },
        pressed ? { opacity: 0.6 } : null,
        style,
      ]}
    >
      <Text style={{ color: colors.blue600, fontFamily: 'Manrope_700Bold', fontSize: 13 }}>{label}</Text>
      {icon}
    </Pressable>
  );
}

export function IconButton({
  onPress,
  children,
  bg = colors.blue100,
  size = 40,
  accessibilityLabel,
}: {
  onPress: () => void;
  children: React.ReactNode;
  bg?: string;
  size?: number;
  accessibilityLabel: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: bg,
          alignItems: 'center',
          justifyContent: 'center',
        },
        pressed ? { opacity: 0.8 } : null,
      ]}
    >
      {children}
    </Pressable>
  );
}
