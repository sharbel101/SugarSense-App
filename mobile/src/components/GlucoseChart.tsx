import React from 'react';
import { Text, View } from 'react-native';
import Svg, { Circle, Line, Polygon, Polyline } from 'react-native-svg';
import { useColors } from '../theme';

export type ChartPoint = { x: number; y: number };

type Props = {
  viewBoxWidth: number;
  viewBoxHeight: number;
  actual: ChartPoint[];
  predicted: ChartPoint[];
  band?: ChartPoint[];
  nowX?: number;
  highlightPoint?: ChartPoint;
  gridLinesY?: number[];
  /** Real-scale axis labels (fractions of the chart width / height). Optional; mock charts omit them. */
  xTicks?: { frac: number; label: string }[];
  yTicks?: { frac: number; label: string }[];
  height?: number;
  /** Text alternative for screen readers - describe the trend and the range, not exact values. */
  accessibilityLabel: string;
};

function toPoints(points: ChartPoint[]) {
  return points.map((p) => `${p.x},${p.y}`).join(' ');
}

/**
 * Renders a glucose trend: a solid "actual" line, a dashed "predicted" median
 * line, and a shaded uncertainty band — reused across Home, Predict, and the
 * post-meal forecast so reality and prediction are always drawn the same way.
 */
export function GlucoseChart({
  viewBoxWidth,
  viewBoxHeight,
  actual,
  predicted,
  band,
  nowX,
  highlightPoint,
  gridLinesY = [],
  xTicks,
  yTicks,
  height,
  accessibilityLabel,
}: Props) {
  const colors = useColors();
  const lastActual = actual[actual.length - 1];

  return (
    <View accessible accessibilityRole="image" accessibilityLabel={accessibilityLabel}>
      <Svg
        width="100%"
        height={height ?? viewBoxHeight}
        viewBox={`0 0 ${viewBoxWidth} ${viewBoxHeight}`}
        preserveAspectRatio="none"
      >
        {gridLinesY.map((y) => (
          <Line key={y} x1={0} y1={y} x2={viewBoxWidth} y2={y} stroke={colors.divider} strokeWidth={1} />
        ))}

        {band && band.length > 0 ? (
          <Polygon points={toPoints(band)} fill={colors.blue500} opacity={0.16} />
        ) : null}

        <Polyline
          points={toPoints(actual)}
          fill="none"
          stroke={colors.blue700}
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {nowX !== undefined ? (
          <Line
            x1={nowX}
            y1={0}
            x2={nowX}
            y2={viewBoxHeight}
            stroke={colors.ink4}
            strokeWidth={1.5}
            strokeDasharray="3 4"
          />
        ) : null}

        {predicted.length > 0 ? (
          <Polyline
            points={toPoints(predicted)}
            fill="none"
            stroke={colors.blue500}
            strokeWidth={3}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray="1 7"
          />
        ) : null}

        {lastActual ? <Circle cx={lastActual.x} cy={lastActual.y} r={4.5} fill={colors.blue700} /> : null}

        {highlightPoint ? (
          <Circle
            cx={highlightPoint.x}
            cy={highlightPoint.y}
            r={5}
            fill={colors.surface}
            stroke={colors.blue600}
            strokeWidth={2.5}
          />
        ) : null}
      </Svg>

      {yTicks && yTicks.length > 0 ? (
        <View pointerEvents="none" style={{ position: 'absolute', left: 2, top: 0, right: 0, height: height ?? viewBoxHeight }}>
          {yTicks.map((t) => (
            <Text
              key={t.label}
              style={{
                position: 'absolute',
                top: `${t.frac * 100}%`,
                marginTop: -15,
                fontFamily: 'Manrope_500Medium',
                fontSize: 11,
                color: colors.ink3,
              }}
            >
              {t.label}
            </Text>
          ))}
        </View>
      ) : null}

      {xTicks && xTicks.length > 0 ? (
        <View style={{ height: 18, marginTop: 4 }}>
          {xTicks.map((t) => (
            <Text
              key={t.label}
              style={{
                position: 'absolute',
                top: 0,
                width: 64,
                fontFamily: 'Manrope_500Medium',
                fontSize: 11,
                color: colors.ink3,
                ...(t.frac < 0.08
                  ? { left: 0, textAlign: 'left' as const }
                  : t.frac > 0.92
                    ? { right: 0, textAlign: 'right' as const }
                    : { left: `${t.frac * 100}%`, marginLeft: -32, textAlign: 'center' as const }),
              }}
            >
              {t.label}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}
