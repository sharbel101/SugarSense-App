import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Icon, type IconName } from '../Icon';
import { STATUS_TEXT, type Freshness, type Status } from '../../services/wearableModel';
import { radius, touch, useColors } from '../../theme';

/** Short status next to a metric. Always text + icon, never colour alone; neutral wording (no "good"/"bad"). */
export function StatusChip({ status }: { status: Status }) {
  const colors = useColors();
  if (status === 'none') return null;
  const look: Record<Exclude<Status, 'none'>, { icon: IconName; bg: string; fg: string }> = {
    within: { icon: 'check', bg: colors.green100, fg: colors.greenDark },
    above: { icon: 'trendUp', bg: colors.amber100, fg: colors.amberDark },
    below: { icon: 'trendDown', bg: colors.amber100, fg: colors.amberDark },
    building: { icon: 'info', bg: colors.divider, fg: colors.ink2 },
  };
  const l = look[status];
  return (
    <View
      accessible
      accessibilityLabel={STATUS_TEXT[status]}
      style={{ flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 5, backgroundColor: l.bg, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4 }}
    >
      <Icon name={l.icon} size={13} color={l.fg} />
      <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 13, color: l.fg }}>{STATUS_TEXT[status]}</Text>
    </View>
  );
}

/** "Updated 4 min ago" / "Data delayed · last 45 min ago" / "Stale · last 5 h ago". */
export function FreshnessLine({ f }: { f: Freshness }) {
  const colors = useColors();
  const warn = f.state === 'delayed' || f.state === 'stale';
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
      {warn ? <Icon name="alertTriangle" size={13} color={colors.amberDark} /> : null}
      <Text style={{ fontFamily: warn ? 'Manrope_700Bold' : 'Manrope_500Medium', fontSize: 13, color: warn ? colors.amberDark : colors.ink3 }}>{f.text}</Text>
    </View>
  );
}

/** The big number + unit used by the tiles and the detail screen. */
export function BigValue({ value, unit, size = 40 }: { value: string; unit?: string; size?: number }) {
  const colors = useColors();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 5, flexWrap: 'wrap' }}>
      <Text style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: size, color: colors.ink, letterSpacing: -1 }}>{value}</Text>
      {unit ? <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 16, color: colors.ink2 }}>{unit}</Text> : null}
    </View>
  );
}

export function SectionLabel({ children }: { children: string }) {
  const colors = useColors();
  return (
    <Text accessibilityRole="header" style={{ fontFamily: 'Manrope_700Bold', fontSize: 13, color: colors.ink2, textTransform: 'uppercase', letterSpacing: 0.6 }}>
      {children}
    </Text>
  );
}

/** A compact tappable row (label, value, status) for the secondary measurements. */
export function MetricRow({
  label,
  value,
  unit,
  status,
  onPress,
}: {
  label: string;
  value: string;
  unit: string;
  status: Status;
  onPress?: () => void;
}) {
  const colors = useColors();
  const body = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: touch.min, paddingVertical: 6 }}>
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink2 }}>{label}</Text>
        <StatusChip status={status} />
      </View>
      <Text style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 20, color: colors.ink }}>
        {value}
        <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink2 }}> {unit}</Text>
      </Text>
      {onPress ? <Icon name="chevronRight" size={18} color={colors.ink4} /> : null}
    </View>
  );
  if (!onPress) return <View accessible accessibilityLabel={`${label} ${value} ${unit}`}>{body}</View>;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${label} ${value} ${unit}. ${STATUS_TEXT[status]}. Open details`} style={({ pressed }) => (pressed ? { opacity: 0.8 } : null)}>
      {body}
    </Pressable>
  );
}
