import React from 'react';
import { Text, View } from 'react-native';
import { radius } from '../theme';

type Props = {
  label: string;
  bg: string;
  color: string;
  size?: 'sm' | 'md';
};

export function Chip({ label, bg, color, size = 'md' }: Props) {
  return (
    <View
      style={{
        backgroundColor: bg,
        borderRadius: radius.pill,
        paddingHorizontal: size === 'md' ? 12 : 9,
        paddingVertical: size === 'md' ? 4 : 3,
        alignSelf: 'flex-start',
      }}
    >
      <Text
        style={{
          color,
          fontFamily: 'Manrope_700Bold',
          fontSize: size === 'md' ? 13 : 11.5,
        }}
      >
        {label}
      </Text>
    </View>
  );
}
