import React from 'react';
import { View } from 'react-native';
import Svg, { Circle, Line, Polygon, Polyline } from 'react-native-svg';
import { colors } from '../theme';

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
  height?: number;
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
  height,
}: Props) {
  const lastActual = actual[actual.length - 1];

  return (
    <View>
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
    </View>
  );
}
