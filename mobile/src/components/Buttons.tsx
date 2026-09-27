import React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { radius, shadow, touch, useColors } from '../theme';
import { Icon } from './Icon';

type ButtonProps = {
  label: string;
  onPress: () => void;
  style?: object;
  disabled?: boolean;
  loading?: boolean;
};

export function PrimaryButton({ label, onPress, style, disabled, loading }: ButtonProps) {
  const colors = useColors();
  const inactive = disabled || loading;
  return (
    <Pressable
      onPress={onPress}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityLabel={label}
      aria-disabled={!!inactive}
      aria-busy={!!loading}
      style={({ pressed }) => [
        {
          backgroundColor: disabled ? colors.ink4 : colors.blue600,
          borderRadius: radius.row,
          minHeight: touch.min,
          paddingVertical: 16,
          alignItems: 'center',
          justifyContent: 'center',
        },
        !disabled ? shadow.fab : null,
        pressed ? { opacity: 0.9 } : null,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={colors.onBlue} />
      ) : (
        <Text style={{ color: colors.onBlue, fontFamily: 'Manrope_700Bold', fontSize: 15 }}>{label}</Text>
      )}
    </Pressable>
  );
}

export function SecondaryButton({ label, onPress, style, disabled }: ButtonProps) {
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      aria-disabled={!!disabled}
      style={({ pressed }) => [
        {
          backgroundColor: colors.surface,
          borderWidth: 1.5,
          borderColor: colors.ink4,
          borderRadius: radius.row,
          minHeight: touch.min,
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
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [
        { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: touch.min },
        pressed ? { opacity: 0.6 } : null,
        style,
      ]}
    >
      <Text style={{ color: colors.blue600, fontFamily: 'Manrope_700Bold', fontSize: 13 }}>{label}</Text>
      {icon}
    </Pressable>
  );
}

/**
 * A round control with a small visual inside a full-size (>= 48 dp) touch box, so the tappable
 * area is real on every platform. `edge` pulls the empty part of the box into the parent's padding
 * so the visible circle stays aligned with the content edge.
 */
export function RoundButton({
  onPress,
  accessibilityLabel,
  size,
  bg,
  borderColor,
  edge,
  children,
}: {
  onPress?: () => void;
  accessibilityLabel: string;
  size: number;
  bg: string;
  borderColor?: string;
  edge?: 'start' | 'end';
  children: React.ReactNode;
}) {
  const box = Math.max(size, touch.min);
  const bleed = -(box - size) / 2;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [
        { width: box, height: box, alignItems: 'center', justifyContent: 'center' },
        edge === 'start' ? { marginLeft: bleed } : null,
        edge === 'end' ? { marginRight: bleed } : null,
        pressed ? { opacity: 0.8 } : null,
      ]}
    >
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: bg,
          borderWidth: borderColor ? 1 : 0,
          borderColor,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {children}
      </View>
    </Pressable>
  );
}

export function IconButton({
  onPress,
  children,
  bg,
  size = 40,
  edge,
  accessibilityLabel,
}: {
  onPress: () => void;
  children: React.ReactNode;
  bg?: string;
  size?: number;
  edge?: 'start' | 'end';
  accessibilityLabel: string;
}) {
  const colors = useColors();
  return (
    <RoundButton onPress={onPress} accessibilityLabel={accessibilityLabel} size={size} bg={bg ?? colors.blue100} edge={edge}>
      {children}
    </RoundButton>
  );
}

/** Round back/close control for sub-screen headers (top-left, per platform convention). */
export function BackButton({ onPress, accessibilityLabel }: { onPress: () => void; accessibilityLabel: string }) {
  const colors = useColors();
  return (
    <RoundButton
      onPress={onPress}
      accessibilityLabel={accessibilityLabel}
      size={36}
      bg={colors.surface}
      borderColor={colors.border}
      edge="start"
    >
      <Icon name="back" size={16} color={colors.ink} />
    </RoundButton>
  );
}
