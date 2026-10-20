import React, { useMemo } from 'react';
import { Text, View } from 'react-native';
import type { GlucoseOk } from '../api/glucoseContract';
import { formatClock } from '../services/glucoseState';
import { useColors } from '../theme';
import { Card } from './Card';
import { Chip } from './Chip';

const FORECAST_MARKS = [30, 60, 120] as const;

/**
 * What Home shows UNDER the graph only when the meal-aware forecast is not available and the older
 * glucose-only forecast is drawn instead: its estimated ranges, a few forecast values and a plain
 * "about this forecast" note. (Moved here from the old Predict screen; nothing about it changed.)
 */
export function FallbackForecast({ data, hasBand }: { data: GlucoseOk; hasBand: boolean }) {
  const colors = useColors();
  // Forecast value nearest each mark (the endpoint emits every 5 min up to +120).
  const marks = useMemo(() => {
    if (!data.forecastAvailable) return [];
    const t0 = Date.parse(data.measuredAt);
    return FORECAST_MARKS.flatMap((m) => {
      const target = t0 + m * 60000;
      let best: { dt: number; value: number } | null = null;
      for (const p of data.predictions) {
        const dt = Math.abs(Date.parse(p.time) - target);
        if (best === null || dt < best.dt) best = { dt, value: p.value };
      }
      return best && best.dt <= 5 * 60000 ? [{ minutes: m, value: best.value }] : [];
    });
  }, [data]);
  const row = { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 } as const;

  return (
    <>
      {hasBand && data.rangesAreShadow ? <Chip label="Estimated ranges: shadow mode, not validated" bg={colors.amber100} color={colors.amberDark} /> : null}
      {data.ranges ? (
        <Card>
          <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 15, color: colors.ink }}>Estimated ranges</Text>
          {data.ranges.map((r) => (
            <View key={r.minutes} style={row}>
              <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink }}>In {r.minutes} min</Text>
              <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2 }}>
                {Math.round(r.low)}–{Math.round(r.high)} mg/dL
              </Text>
            </View>
          ))}
        </Card>
      ) : null}
      {marks.length > 0 ? (
        <Card>
          <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 15, color: colors.ink }}>Forecast line</Text>
          {marks.map((m) => (
            <View key={m.minutes} style={row}>
              <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink }}>In {m.minutes} min</Text>
              <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2 }}>{Math.round(m.value)} mg/dL</Text>
            </View>
          ))}
          <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, marginTop: 10 }}>
            A single forecast value is an estimate and can be wrong. It carries no range beyond 45 minutes.
          </Text>
        </Card>
      ) : null}
      <Card>
        <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 15, color: colors.ink }}>About this forecast</Text>
        <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, marginTop: 6, lineHeight: 21 }}>
          Estimates only. Not medical advice.
          {data.modelVersion ? ` Model ${data.modelVersion}.` : ''}
          {data.generatedAt ? ` Generated at ${formatClock(data.generatedAt)}.` : ''}
        </Text>
      </Card>
    </>
  );
}
