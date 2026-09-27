import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { radius, touch, useColors } from '../theme';

export type SegmentOption<T extends string> = {
  value: T;
  label: string;
  /** Read by screen readers instead of `label` when the label alone is ambiguous. */
  accessibilityLabel?: string;
};

/** A pill-shaped single-choice control. Each segment is a full-size (>= 48 dp) touch target. */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  const colors = useColors();
  return (
    <View
      accessibilityRole="radiogroup"
      style={{ flexDirection: 'row', backgroundColor: colors.divider, borderRadius: radius.pill, padding: 3 }}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            accessibilityRole="radio"
            accessibilityLabel={option.accessibilityLabel ?? option.label}
            aria-checked={selected}
            style={{
              flex: 1,
              minHeight: touch.min,
              justifyContent: 'center',
              alignItems: 'center',
              borderRadius: radius.pill,
              backgroundColor: selected ? colors.surface : 'transparent',
            }}
          >
            <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 13, color: selected ? colors.ink : colors.ink3 }}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
