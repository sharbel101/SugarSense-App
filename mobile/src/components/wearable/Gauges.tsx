import React from 'react';
import { View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { STRESS_BANDS, usualGauge, type Baseline } from '../../services/wearableModel';
import { radius, useColors } from '../../theme';

/** A full ring that fills from 0 to `fraction` (body battery, sleep score). The number sits in the middle. */
export function RingGauge({ fraction, size, color, label, children }: { fraction: number; size: number; color: string; label: string; children?: React.ReactNode }) {
  const colors = useColors();
  const stroke = Math.max(8, Math.round(size / 11));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const f = Math.min(1, Math.max(0, fraction));
  return (
    <View accessible accessibilityLabel={label} style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={{ position: 'absolute' }}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={colors.divider} strokeWidth={stroke} fill="none" />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={`${c * f} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      {children}
    </View>
  );
}

/**
 * A horizontal bar showing where today's value sits against the person's usual range (the middle band).
 * Compact enough for a list row. Text and the status chip carry the meaning, not the colour.
 */
export function RangeBar({ value, baseline }: { value: number; baseline: Baseline }) {
  const colors = useColors();
  const g = usualGauge(value, baseline);
  const pct = (f: number) => `${Math.round(f * 1000) / 10}%` as `${number}%`;
  return (
    <View accessible accessibilityLabel={`Position against your usual range: ${g.zone}`} style={{ height: 14, justifyContent: 'center' }}>
      <View style={{ height: 6, borderRadius: radius.pill, backgroundColor: colors.divider }}>
        <View style={{ position: 'absolute', left: pct(g.usualFrom), width: pct(g.usualTo - g.usualFrom), top: 0, bottom: 0, borderRadius: radius.pill, backgroundColor: colors.green600, opacity: 0.55 }} />
      </View>
      <View
        style={{
          position: 'absolute',
          left: pct(g.fraction),
          marginLeft: -7,
          width: 14,
          height: 14,
          borderRadius: 7,
          backgroundColor: colors.ink,
          borderWidth: 2,
          borderColor: colors.surface,
        }}
      />
    </View>
  );
}

/** Garmin's four stress ranges as one slim bar with a marker at the current value. The range name is shown in text next to it. */
export function BandBar({ value }: { value: number }) {
  const colors = useColors();
  const tones = [colors.green600, colors.blue500, colors.amber600, colors.red600];
  const left = `${Math.min(100, Math.max(0, value))}%` as `${number}%`;
  return (
    <View accessible accessibilityLabel={`Stress ${Math.round(value)} out of 100`} style={{ width: '100%', height: 14, justifyContent: 'center' }}>
      <View style={{ flexDirection: 'row', height: 6, borderRadius: radius.pill, overflow: 'hidden', gap: 2 }}>
        {STRESS_BANDS.map((band, i) => (
          <View key={band.key} style={{ flex: 1, backgroundColor: tones[i] }} />
        ))}
      </View>
      <View style={{ position: 'absolute', left, marginLeft: -7, width: 14, height: 14, borderRadius: 7, backgroundColor: colors.ink, borderWidth: 2, borderColor: colors.surface }} />
    </View>
  );
}
