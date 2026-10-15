import React from 'react';
import { Text, View } from 'react-native';
import { formatClock, type GlucoseView } from '../services/glucoseState';
import { useColors } from '../theme';
import { SecondaryButton } from './Buttons';
import { Icon } from './Icon';

type Props = {
  view: Exclude<GlucoseView, { kind: 'ok' }>;
  onRetry: () => void;
  retrying: boolean;
};

/**
 * The three non-reading states, kept visually and verbally distinct. None of them draws a number
 * or a chart, and none falls back to mock or "last known" glucose.
 */
export function GlucoseStatus({ view, onRetry, retrying }: Props) {
  const colors = useColors();

  if (view.kind === 'loading') {
    return (
      <View aria-busy accessibilityLabel="Loading glucose" style={{ paddingVertical: 8, gap: 6 }}>
        <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 18, color: colors.ink }}>Loading glucose…</Text>
        <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2 }}>
          Fetching your latest reading.
        </Text>
      </View>
    );
  }

  if (view.kind === 'stale') {
    const at = view.lastMeasuredAt ? formatClock(view.lastMeasuredAt) : '';
    return (
      <View style={{ paddingVertical: 8, gap: 6 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Icon name="alertTriangle" size={20} color={colors.amber600} />
          <Text accessibilityRole="header" style={{ fontFamily: 'Manrope_700Bold', fontSize: 18, color: colors.ink }}>
            {at ? `No recent reading - last at ${at}` : 'No recent reading'}
          </Text>
        </View>
        <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2 }}>{view.reason}</Text>
      </View>
    );
  }

  return (
    <View style={{ paddingVertical: 8, gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon name="wifi" size={20} color={colors.ink3} />
        <Text accessibilityRole="header" style={{ fontFamily: 'Manrope_700Bold', fontSize: 18, color: colors.ink }}>
          Can&apos;t load glucose right now
        </Text>
      </View>
      <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2 }}>{view.reason}</Text>
      <SecondaryButton label={retrying ? 'Retrying…' : 'Retry'} onPress={onRetry} disabled={retrying} />
    </View>
  );
}
