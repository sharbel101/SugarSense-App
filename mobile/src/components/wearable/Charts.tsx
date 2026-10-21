import React, { useMemo, useState } from 'react';
import { LayoutChangeEvent, Text, View } from 'react-native';
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';
import { formatIsoTime12 } from '../../services/clock12';
import {
  buildBars,
  buildLine,
  formatNumber,
  nearestByX,
  type Baseline,
  type Sample,
} from '../../services/wearableModel';
import { useColors } from '../../theme';

const font = { fontFamily: 'Manrope_500Medium', fontSize: 13 } as const;

function dateLabel(t: number): string {
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function hourLabel(t: number): string {
  return formatIsoTime12(new Date(t).toISOString());
}
/** "3:15 PM" for a time axis, "Oct 14" for a date axis. */
export const axisLabel = (kind: 'time' | 'date') => (t: number) => (kind === 'time' ? hourLabel(t) : dateLabel(t));

type Common = {
  samples: Sample[];
  t0: number;
  t1: number;
  height: number;
  unit: string;
  decimals?: number;
  /** Text alternative for screen readers: what the chart shows. */
  label: string;
  axis: 'time' | 'date';
  /** Custom value text for the readout (e.g. "7 h 20 min"); default is the number and unit. */
  format?: (v: number) => string;
};

/** Press / drag to read a value. Works with touch and mouse; the text alternative covers everything else. */
function useScrub(onPick: (x: number) => void) {
  return {
    onStartShouldSetResponder: () => true,
    onResponderGrant: (e: { nativeEvent: { locationX: number } }) => onPick(e.nativeEvent.locationX),
    onResponderMove: (e: { nativeEvent: { locationX: number } }) => onPick(e.nativeEvent.locationX),
    onResponderTerminationRequest: () => true,
  };
}

function Readout({ text, hint }: { text: string | null; hint: string }) {
  const colors = useColors();
  return (
    <Text style={{ ...font, color: text ? colors.ink : colors.ink3, minHeight: 20, fontFamily: text ? 'Manrope_700Bold' : 'Manrope_500Medium' }}>
      {text ?? hint}
    </Text>
  );
}

/**
 * Line chart for a metric. Time with no data is left EMPTY (a break in the line), never joined or interpolated.
 * `baseline` draws the person's usual range as a quiet band. `compact` = a sparkline (no readout, no axis).
 */
export function LineChart({
  samples,
  t0,
  t1,
  height,
  unit,
  decimals = 0,
  label,
  axis,
  gapMs,
  baseline,
  compact,
  format,
}: Common & { gapMs: number; baseline?: Baseline | null; compact?: boolean }) {
  const colors = useColors();
  const [w, setW] = useState(0);
  const [sel, setSel] = useState<number | null>(null);
  const geom = useMemo(() => (w > 0 ? buildLine(samples, { t0, t1, w, h: height }, gapMs, baseline) : null), [samples, t0, t1, w, height, gapMs, baseline]);
  const onLayout = (e: LayoutChangeEvent) => setW(Math.round(e.nativeEvent.layout.width));
  const scrub = useScrub((x) => {
    if (geom) setSel(nearestByX(geom.points, x));
  });
  const picked = geom && sel !== null && sel >= 0 ? geom.points[sel] : null;
  const fmt = axisLabel(axis === 'time' ? 'time' : 'date');
  const readout = picked ? `${format ? format(picked.v) : `${formatNumber(picked.v, decimals)} ${unit}`} · ${axis === 'time' ? hourLabel(picked.t) : dateLabel(picked.t)}` : null;

  return (
    <View accessible accessibilityLabel={label} style={{ gap: 6 }}>
      {compact ? null : <Readout text={readout} hint="Touch the chart to read a value" />}
      <View onLayout={onLayout} style={{ height }} {...(compact ? {} : scrub)}>
        {geom ? (
          <Svg width={w} height={height}>
            {geom.band ? <Rect x={0} y={geom.band.y1} width={w} height={Math.max(1, geom.band.y2 - geom.band.y1)} fill={colors.blue600} opacity={0.12} /> : null}
            {geom.segments.map((d, i) => (
              <Path key={i} d={d} stroke={colors.blue600} strokeWidth={compact ? 2 : 2.5} fill="none" strokeLinejoin="round" strokeLinecap="round" />
            ))}
            {geom.singles.map((p) => (
              <Circle key={p.t} cx={p.x} cy={p.y} r={2.5} fill={colors.blue600} />
            ))}
            {picked ? (
              <>
                <Line x1={picked.x} x2={picked.x} y1={0} y2={height} stroke={colors.ink4} strokeWidth={1} />
                <Circle cx={picked.x} cy={picked.y} r={5} fill={colors.blue600} stroke={colors.surface} strokeWidth={2} />
              </>
            ) : geom.points.length > 0 ? (
              <Circle cx={geom.points[geom.points.length - 1].x} cy={geom.points[geom.points.length - 1].y} r={4} fill={colors.blue600} stroke={colors.surface} strokeWidth={2} />
            ) : null}
          </Svg>
        ) : null}
      </View>
      {compact ? null : (
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Text style={{ ...font, color: colors.ink3 }}>{fmt(t0)}</Text>
          <Text style={{ ...font, color: colors.ink3 }}>{axis === 'time' ? 'Now' : fmt(t1 - 1)}</Text>
        </View>
      )}
    </View>
  );
}

/** Bar chart for totals (steps per hour / per day). A slot with no data has no bar: unknown is not zero. */
export function BarChart({ samples, t0, t1, height, unit, decimals = 0, label, axis, slotMs, compact, format, endLabel }: Common & { slotMs: number; compact?: boolean; endLabel?: string }) {
  const colors = useColors();
  const [w, setW] = useState(0);
  const [sel, setSel] = useState<number | null>(null);
  const geom = useMemo(() => (w > 0 ? buildBars(samples, { t0, t1, w, h: height }, slotMs) : null), [samples, t0, t1, w, height, slotMs]);
  const scrub = useScrub((x) => {
    if (!geom) return;
    setSel(nearestByX(geom.bars.map((b) => ({ x: b.x + b.w / 2 })), x));
  });
  const picked = geom && sel !== null && sel >= 0 ? geom.bars[sel] : null;
  const fmt = axisLabel(axis);
  const readout = picked ? `${format ? format(picked.v) : `${formatNumber(picked.v, decimals)} ${unit}`} · ${axis === 'time' ? hourLabel(picked.t) : dateLabel(picked.t)}` : null;
  return (
    <View accessible accessibilityLabel={label} style={{ gap: 6 }}>
      {compact ? null : <Readout text={readout} hint="Touch the chart to read a value" />}
      <View onLayout={(e) => setW(Math.round(e.nativeEvent.layout.width))} style={{ height }} {...(compact ? {} : scrub)}>
        {geom ? (
          <Svg width={w} height={height}>
            <Line x1={0} x2={w} y1={height - 1} y2={height - 1} stroke={colors.border} strokeWidth={1} />
            {geom.bars.map((b, i) => (
              <Rect key={b.t} x={b.x} y={b.y} width={b.w} height={b.h} rx={Math.min(3, b.w / 2)} fill={picked && sel !== i ? colors.blue500 : colors.blue600} opacity={picked && sel !== i ? 0.55 : 1} />
            ))}
          </Svg>
        ) : null}
      </View>
      {compact ? null : (
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Text style={{ ...font, color: colors.ink3 }}>{fmt(t0)}</Text>
          <Text style={{ ...font, color: colors.ink3 }}>{axis === 'time' ? (endLabel ?? 'Now') : fmt(t1 - 1)}</Text>
        </View>
      )}
    </View>
  );
}

/** Sleep stages as one stacked bar. Every stage is named with its minutes, so colour is never the only cue. */
export function StageBar({ stages }: { stages: { key: string; label: string; minutes: number }[] }) {
  const colors = useColors();
  const palette = [colors.blue700, colors.purple600, colors.blue500, colors.ink4];
  const total = stages.reduce((a, s) => a + s.minutes, 0);
  if (total <= 0) return null;
  return (
    <View style={{ gap: 8 }}>
      <View
        accessible
        accessibilityLabel={`Sleep stages: ${stages.map((s) => `${s.label} ${Math.round(s.minutes)} minutes`).join(', ')}`}
        style={{ flexDirection: 'row', height: 10, borderRadius: 5, overflow: 'hidden', gap: 2 }}
      >
        {stages.map((s, i) => (
          <View key={s.key} style={{ flex: s.minutes, backgroundColor: palette[i % palette.length] }} />
        ))}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14 }}>
        {stages.map((s, i) => (
          <View key={s.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: palette[i % palette.length] }} />
            <Text style={{ ...font, color: colors.ink2 }}>
              {s.label} {Math.round(s.minutes)} min
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}
