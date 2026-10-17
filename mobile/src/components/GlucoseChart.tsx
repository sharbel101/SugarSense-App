import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import Svg, { Circle, Line, Path, Polygon, Polyline } from 'react-native-svg';
import { monotonePath, polylinePath } from '../services/chartPath';
import { nearestForecastPoint, type ForecastPoint } from '../services/glucoseChart';
import type { EventMarker } from '../services/forecastChart';
import { touch, useColors } from '../theme';
import { Icon } from './Icon';

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
  /**
   * Server-supplied forecast points. When present, pressing and dragging on the chart shows the
   * nearest point's predicted value and clock time.
   */
  forecastPoints?: ForecastPoint[];
  /** Dotted continuation after the glucose-only horizon (only logged events move it). */
  extension?: ChartPoint[];
  /** Thin glucose-only comparison line; pass only when it differs from the forecast. */
  baselineLine?: ChartPoint[];
  /** Logged meals / insulin on the time axis. */
  markers?: EventMarker[];
  /** Text for a tapped marker, e.g. "Meal, 45 g - insulin not recorded". */
  markerLabel?: (marker: EventMarker) => string;
  /** `history` = the points are past readings (tooltip says "N min ago"); default `forecast`. */
  scrubKind?: 'forecast' | 'history';
  /** Draw the measured line as a smooth curve through the readings (default true). */
  smooth?: boolean;
  /** Text alternative for screen readers - describe the trend and the range, not exact values. */
  accessibilityLabel: string;
};

function toPoints(points: ChartPoint[]) {
  return points.map((p) => `${p.x},${p.y}`).join(' ');
}

type StaticProps = Pick<
  Props,
  'viewBoxWidth' | 'viewBoxHeight' | 'actual' | 'predicted' | 'band' | 'nowX' | 'highlightPoint' | 'extension' | 'baselineLine'
> & { width: number; height: number; gridLinesY: number[]; smooth: boolean };

/**
 * The lines, band and grid. Memoised: while a finger or mouse scrubs across the chart only the
 * small overlay re-renders, never these lines (re-drawing them on every move was the lag).
 *
 * Drawn in REAL PIXELS (the measured width and height), not a stretched viewBox: with
 * `preserveAspectRatio="none"` the latest-reading dot became an ellipse and line widths varied with
 * direction, which is why the chart looked stretched. `pointerEvents="none"` keeps the SVG out of
 * hit-testing, so a drag can neither select it nor report coordinates relative to an inner shape.
 */
const StaticLayers = React.memo(function StaticLayers({
  viewBoxWidth,
  viewBoxHeight,
  width,
  height,
  actual,
  predicted,
  band,
  nowX,
  highlightPoint,
  gridLinesY,
  extension,
  baselineLine,
  smooth,
}: StaticProps) {
  const colors = useColors();
  const sx = width / viewBoxWidth;
  const sy = height / viewBoxHeight;
  const scaled = useMemo(() => {
    const sc = (pts?: ChartPoint[]) => (pts ?? []).map((q) => ({ x: q.x * sx, y: q.y * sy }));
    return {
      actual: sc(actual),
      predicted: sc(predicted),
      band: sc(band),
      extension: sc(extension),
      baseline: sc(baselineLine),
      highlight: highlightPoint ? { x: highlightPoint.x * sx, y: highlightPoint.y * sy } : null,
    };
  }, [actual, predicted, band, extension, baselineLine, highlightPoint, sx, sy]);
  const actualPath = useMemo(() => (smooth ? monotonePath(scaled.actual) : polylinePath(scaled.actual)), [scaled.actual, smooth]);
  const predictedPts = useMemo(() => toPoints(scaled.predicted), [scaled.predicted]);
  const bandPts = useMemo(() => toPoints(scaled.band), [scaled.band]);
  const extensionPts = useMemo(() => toPoints(scaled.extension), [scaled.extension]);
  const baselinePts = useMemo(() => toPoints(scaled.baseline), [scaled.baseline]);
  const last = scaled.actual[scaled.actual.length - 1];
  return (
    <Svg width="100%" height={height} pointerEvents="none" viewBox={`0 0 ${width} ${height}`}>
      {gridLinesY.map((y) => (
        <Line key={y} x1={0} y1={y * sy} x2={width} y2={y * sy} stroke={colors.divider} strokeWidth={1} />
      ))}

      {scaled.band.length > 0 ? <Polygon points={bandPts} fill={colors.blue500} opacity={0.16} /> : null}

      <Path d={actualPath} fill="none" stroke={colors.blue700} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />

      {nowX !== undefined ? (
        <Line x1={nowX * sx} y1={0} x2={nowX * sx} y2={height} stroke={colors.ink4} strokeWidth={1.5} strokeDasharray="3 4" />
      ) : null}

      {scaled.baseline.length > 1 ? (
        <Polyline points={baselinePts} fill="none" stroke={colors.ink4} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      ) : null}

      {scaled.extension.length > 1 ? (
        <Polyline
          points={extensionPts}
          fill="none"
          stroke={colors.blue500}
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray="1 11"
          opacity={0.7}
        />
      ) : null}

      {scaled.predicted.length > 0 ? (
        <Polyline
          points={predictedPts}
          fill="none"
          stroke={colors.blue500}
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray="1 7"
        />
      ) : null}

      {last ? <Circle cx={last.x} cy={last.y} r={5} fill={colors.blue700} stroke={colors.surface} strokeWidth={2} /> : null}

      {scaled.highlight ? (
        <Circle cx={scaled.highlight.x} cy={scaled.highlight.y} r={5} fill={colors.surface} stroke={colors.blue600} strokeWidth={2.5} />
      ) : null}
    </Svg>
  );
});

const YLabels = React.memo(function YLabels({ yTicks, height }: { yTicks?: { frac: number; label: string }[]; height: number }) {
  const colors = useColors();
  if (!yTicks || yTicks.length === 0) return null;
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: 2, top: 0, right: 0, height }}>
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
  );
});

const XLabels = React.memo(function XLabels({ xTicks }: { xTicks?: { frac: number; label: string }[] }) {
  const colors = useColors();
  if (!xTicks || xTicks.length === 0) return null;
  return (
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
  );
});

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
  forecastPoints,
  extension,
  baselineLine,
  markers,
  markerLabel,
  scrubKind = 'forecast',
  smooth = true,
  accessibilityLabel,
}: Props) {
  const colors = useColors();

  const [scrub, setScrub] = useState<ForecastPoint | null>(null);
  const [pickedMarker, setPickedMarker] = useState<string | null>(null);
  const widthRef = useRef(0);
  const [layoutWidth, setLayoutWidth] = useState(0);
  const pointsRef = useRef<ForecastPoint[]>([]);
  const vbWidthRef = useRef(viewBoxWidth);
  useEffect(() => {
    pointsRef.current = forecastPoints ?? [];
    vbWidthRef.current = viewBoxWidth;
  }, [forecastPoints, viewBoxWidth]);

  const updateScrub = (locationX: number) => {
    if (widthRef.current <= 0 || pointsRef.current.length === 0) return;
    const x = (locationX / widthRef.current) * vbWidthRef.current;
    const next = nearestForecastPoint(pointsRef.current, x) ?? null;
    setScrub((prev) => (prev && next && prev.timeMs === next.timeMs ? prev : next));
  };

  const canScrub = (forecastPoints?.length ?? 0) > 0;
  const scrubFrac = scrub ? scrub.x / viewBoxWidth : 0;
  const scrubLabelPos =
    scrubFrac > 0.62
      ? { right: `${(1 - scrubFrac) * 100}%` as `${number}%` }
      : { left: `${scrubFrac * 100}%` as `${number}%` };

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={canScrub ? 'Press and drag across the dotted forecast line to read predicted values.' : undefined}
      onLayout={(e) => {
        widthRef.current = e.nativeEvent.layout.width;
        setLayoutWidth(Math.round(e.nativeEvent.layout.width));
      }}
      onStartShouldSetResponder={() => canScrub}
      onMoveShouldSetResponder={() => canScrub}
      onResponderTerminationRequest={() => false}
      onResponderGrant={(e) => updateScrub(e.nativeEvent.locationX)}
      onResponderMove={(e) => updateScrub(e.nativeEvent.locationX)}
      onResponderRelease={() => setScrub(null)}
      onResponderTerminate={() => setScrub(null)}
      style={
        Platform.OS === 'web'
          ? ({ touchAction: canScrub ? 'pan-y' : 'auto', userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' } as object)
          : undefined
      }
    >
      <StaticLayers
        viewBoxWidth={viewBoxWidth}
        viewBoxHeight={viewBoxHeight}
        width={layoutWidth > 0 ? layoutWidth : viewBoxWidth}
        height={height ?? viewBoxHeight}
        smooth={smooth}
        actual={actual}
        predicted={predicted}
        band={band}
        nowX={nowX}
        highlightPoint={highlightPoint}
        gridLinesY={gridLinesY}
        extension={extension}
        baselineLine={baselineLine}
      />

      {scrub ? (
        <View
          pointerEvents="none"
          style={{ position: 'absolute', left: 0, right: 0, top: 0, height: height ?? viewBoxHeight }}
        >
          <View
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: `${scrubFrac * 100}%`,
              width: 2,
              marginLeft: -1,
              backgroundColor: colors.blue600,
            }}
          />
          <View
            style={{
              position: 'absolute',
              top: `${(scrub.y / viewBoxHeight) * 100}%`,
              left: `${scrubFrac * 100}%`,
              width: 14,
              height: 14,
              marginLeft: -7,
              marginTop: -7,
              borderRadius: 7,
              backgroundColor: colors.surface,
              borderWidth: 3,
              borderColor: colors.blue600,
            }}
          />
        </View>
      ) : null}

      {scrub ? (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: 0,
            ...scrubLabelPos,
            paddingHorizontal: 10,
            paddingVertical: 6,
            borderRadius: 10,
            backgroundColor: colors.surface,
            borderWidth: 1,
            borderColor: colors.divider,
          }}
        >
          <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 14, color: colors.ink }}>
            {new Date(scrub.timeMs).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} ·{' '}
            {Math.round(scrub.value)} mg/dL
          </Text>
          <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2 }}>
            {scrubKind === 'history'
              ? scrub.minutesAhead === 0
                ? 'Latest reading'
                : `${Math.abs(scrub.minutesAhead)} min ago`
              : `Predicted, +${scrub.minutesAhead} min`}
          </Text>
          {scrub.low !== undefined && scrub.high !== undefined ? (
            <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2 }}>
              Range {Math.round(scrub.low)}-{Math.round(scrub.high)}
              {scrub.baseline !== undefined && scrub.baseline !== null ? ` · glucose-only ${Math.round(scrub.baseline)}` : ''}
            </Text>
          ) : null}
        </View>
      ) : null}

      {markers && markers.length > 0 ? (
        <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: touch.min }}>
          {markers.map((m) => {
            const filled = m.role === 'used';
            const label = markerLabel ? markerLabel(m) : m.type === 'meal' ? 'Logged meal' : 'Logged insulin';
            return (
              <Pressable
                key={m.id}
                onPress={() => setPickedMarker((cur) => (cur === m.id ? null : m.id))}
                accessibilityRole="button"
                accessibilityLabel={label}
                style={{
                  position: 'absolute',
                  left: `${(m.x / viewBoxWidth) * 100}%`,
                  bottom: 0,
                  width: touch.min,
                  height: touch.min,
                  marginLeft: -touch.min / 2,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <View
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: 12,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: filled ? colors.blue600 : colors.surface,
                    borderWidth: 2,
                    borderColor: colors.blue600,
                    borderStyle: filled ? 'solid' : 'dashed',
                  }}
                >
                  <Icon name={m.type === 'meal' ? 'fork' : 'droplet'} size={12} color={filled ? colors.onBlue : colors.blue600} />
                </View>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {pickedMarker && markers && markerLabel ? (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            paddingHorizontal: 10,
            paddingVertical: 6,
            borderRadius: 10,
            backgroundColor: colors.surface,
            borderWidth: 1,
            borderColor: colors.divider,
          }}
        >
          <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink }}>
            {(() => {
              const m = markers.find((x) => x.id === pickedMarker);
              return m ? markerLabel(m) : '';
            })()}
          </Text>
        </View>
      ) : null}

      <YLabels yTicks={yTicks} height={height ?? viewBoxHeight} />
      <XLabels xTicks={xTicks} />
    </View>
  );
}
