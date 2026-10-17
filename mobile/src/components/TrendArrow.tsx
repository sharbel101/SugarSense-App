import React from 'react';
import { View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useColors } from '../theme';

/**
 * Glucose trend as a drawn arrow (not a text character: iOS turns the arrow characters into
 * colourful emoji with a box around them). Points right when steady and tilts up or down with the
 * rate of change, using the server-supplied rate in mg/dL per minute.
 */
export function TrendArrow({ ratePerMin, size = 34 }: { ratePerMin: number; size?: number }) {
  const colors = useColors();
  const angle = -Math.max(-75, Math.min(75, ratePerMin * 40));
  return (
    <View style={{ width: size, height: size, transform: [{ rotate: `${Math.round(angle)}deg` }] }}>
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <Path
          d="M4 12h16M14 6l6 6-6 6"
          fill="none"
          stroke={colors.ink}
          strokeWidth={2.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>
    </View>
  );
}
