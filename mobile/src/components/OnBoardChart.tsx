import React, { useMemo, useRef, useState } from 'react';
import { Platform, Text, View } from 'react-native';
import Svg, { Circle, Line, Path, Polyline } from 'react-native-svg';
import type { GlucoseOk } from '../api/glucoseContract';
import { monotonePath } from '../services/chartPath';
import { formatTime12 } from '../services/clock12';
import { useForecast } from '../services/ForecastProvider';
import {
  buildOnBoardChart,
  describeOnBoardChart,
  nearestOnBoardPoint,
  type OnBoardChartModel,
  type OnBoardScrubPoint,
} from '../services/onBoardChart';
import { radius, useColors } from '../theme';
import { Card } from './Card';

const HEIGHT = 190;

const units = (n: number) => `${(Math.round(n * 10) / 10).toFixed(1)} U`;
const grams = (n: number) => `${Math.round(n)} g`;
const hoursText = (minutes: number) => (minutes >= 60 ? `+${Math.round(minutes / 60)} h` : `+${minutes} min`);

type Scaled = { x: number; y: number }[];
const toPoints = (pts: Scaled) => pts.map((p) => `${p.x},${p.y}`).join(' ');

/**
 * The lines and grid. Memoised so a finger scrubbing across the graph only re-renders the small
 * readout, never the lines. Drawn in real pixels (the measured width) so circles stay round.
 */
const Layers = React.memo(function Layers({ model, width }: { model: OnBoardChartModel; width: number }) {
  const colors = useColors();
  const sx = width / model.viewBoxWidth;
  const sy = HEIGHT / model.viewBoxHeight;
  const scale = (pts: Scaled): Scaled => pts.map((p) => ({ x: p.x * sx, y: p.y * sy }));
  const glucose = useMemo(() => scale(model.glucoseActual), [model, sx, sy]); // eslint-disable-line react-hooks/exhaustive-deps
  const predicted = useMemo(() => scale(model.glucosePredicted), [model, sx, sy]); // eslint-disable-line react-hooks/exhaustive-deps
  const insulin = useMemo(() => scale(model.insulin), [model, sx, sy]); // eslint-disable-line react-hooks/exhaustive-deps
  const carbs = useMemo(() => scale(model.carbs), [model, sx, sy]); // eslint-disable-line react-hooks/exhaustive-deps
  const nowDot = glucose[glucose.length - 1];
  return (
    <Svg width="100%" height={HEIGHT} pointerEvents="none" viewBox={`0 0 ${width} ${HEIGHT}`}>
      {model.gridLinesY.map((y) => (
        <Line key={y} x1={0} y1={y * sy} x2={width} y2={y * sy} stroke={colors.divider} strokeWidth={1} />
      ))}
      <Line x1={model.nowX * sx} y1={0} x2={model.nowX * sx} y2={HEIGHT} stroke={colors.ink4} strokeWidth={1.5} strokeDasharray="3 4" />

      {insulin.length > 1 ? (
        <>
          <Path d={monotonePath(insulin)} fill="none" stroke={colors.purple600} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
          <Circle cx={insulin[0].x} cy={insulin[0].y} r={4} fill={colors.purple600} stroke={colors.surface} strokeWidth={2} />
        </>
      ) : null}
      {carbs.length > 1 ? (
        <>
          <Path d={monotonePath(carbs)} fill="none" stroke={colors.amber600} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
          <Circle cx={carbs[0].x} cy={carbs[0].y} r={4} fill={colors.amber600} stroke={colors.surface} strokeWidth={2} />
        </>
      ) : null}

      <Path d={monotonePath(glucose)} fill="none" stroke={colors.blue700} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
      {predicted.length > 1 ? (
        <Polyline points={toPoints(predicted)} fill="none" stroke={colors.blue500} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" strokeDasharray="1 7" />
      ) : null}
      {nowDot ? <Circle cx={nowDot.x} cy={nowDot.y} r={5} fill={colors.blue700} stroke={colors.surface} strokeWidth={2} /> : null}
    </Svg>
  );
});

function Swatch({ color, dotted }: { color: string; dotted?: boolean }) {
  return (
    <View style={{ width: 22, height: 14, justifyContent: 'center' }}>
      {dotted ? (
        <View style={{ flexDirection: 'row', gap: 3 }}>
          {[0, 1, 2, 3].map((i) => (
            <View key={i} style={{ width: 3, height: 3, borderRadius: 2, backgroundColor: color }} />
          ))}
        </View>
      ) : (
        <View style={{ height: 3, borderRadius: 2, backgroundColor: color }} />
      )}
    </View>
  );
}

function LegendRow({ swatch, title, text }: { swatch: React.ReactNode; title: string; text: string }) {
  const colors = useColors();
  return (
    <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
      <View style={{ paddingTop: 4 }}>{swatch}</View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 14, color: colors.ink }}>{title}</Text>
        <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, lineHeight: 20 }}>{text}</Text>
      </View>
    </View>
  );
}

function Chart({ model }: { model: OnBoardChartModel }) {
  const colors = useColors();
  const [layoutWidth, setLayoutWidth] = useState(0);
  const widthRef = useRef(0);
  const [scrub, setScrub] = useState<OnBoardScrubPoint | null>(null);

  const update = (locationX: number) => {
    if (widthRef.current <= 0) return;
    const next = nearestOnBoardPoint(model.scrubPoints, (locationX / widthRef.current) * model.viewBoxWidth);
    setScrub((prev) => (prev && next && prev.timeMs === next.timeMs ? prev : next));
  };
  const width = layoutWidth > 0 ? layoutWidth : model.viewBoxWidth;
  const scrubFrac = scrub ? scrub.x / model.viewBoxWidth : 0;

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={describeOnBoardChart(model)}
      accessibilityHint="Press and drag across the graph to read blood sugar, insulin on board and carbs on board at any time."
      onLayout={(e) => {
        widthRef.current = e.nativeEvent.layout.width;
        setLayoutWidth(Math.round(e.nativeEvent.layout.width));
      }}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
      onResponderGrant={(e) => update(e.nativeEvent.locationX)}
      onResponderMove={(e) => update(e.nativeEvent.locationX)}
      onResponderRelease={() => setScrub(null)}
      onResponderTerminate={() => setScrub(null)}
      style={
        Platform.OS === 'web'
          ? ({ touchAction: 'pan-y', userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' } as object)
          : undefined
      }
    >
      <Layers model={model} width={width} />

      <View pointerEvents="none" style={{ position: 'absolute', left: 2, top: 0, right: 0, height: HEIGHT }}>
        {model.yTicks.map((t) => (
          <Text key={t.label} style={{ position: 'absolute', top: `${t.frac * 100}%`, marginTop: -15, fontFamily: 'Manrope_500Medium', fontSize: 11, color: colors.ink3 }}>
            {t.label}
          </Text>
        ))}
      </View>

      {scrub ? (
        <>
          <View
            pointerEvents="none"
            style={{ position: 'absolute', top: 0, height: HEIGHT, left: `${scrubFrac * 100}%`, width: 2, marginLeft: -1, backgroundColor: colors.blue600 }}
          />
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              top: 0,
              // On the side away from the finger, so the readout never covers the point being read.
              ...(scrubFrac > 0.5 ? { left: 6 } : { right: 6 }),
              paddingHorizontal: 10,
              paddingVertical: 6,
              borderRadius: radius.chip,
              backgroundColor: colors.surface,
              borderWidth: 1,
              borderColor: colors.divider,
              gap: 1,
            }}
          >
            <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 14, color: colors.ink }}>
              {scrub.minutesAhead === 0 ? 'Latest reading' : `${hoursText(scrub.minutesAhead)} · ${formatTime12(new Date(scrub.timeMs))}`}
            </Text>
            <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2 }}>
              Blood sugar {Math.round(scrub.glucose)} mg/dL{scrub.minutesAhead > 0 ? ' (predicted)' : ''}
            </Text>
            <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2 }}>
              Insulin on board {scrub.insulin === null ? 'unknown' : units(scrub.insulin)}
            </Text>
            <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2 }}>
              Carbs on board {scrub.carbs === null ? 'none logged' : grams(scrub.carbs)}
            </Text>
          </View>
        </>
      ) : null}

      <View style={{ height: 18, marginTop: 4 }}>
        {model.xTicks.map((t) => (
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
    </View>
  );
}

/**
 * A second graph, further down the Predict page: blood sugar now with its dotted predicted line, and how
 * the insulin and the carbs you logged are predicted to wear off over the same hours. Shown only when
 * the server returned a forecast; a curve the server gave no values for is left out (never drawn as 0).
 */
export function OnBoardChartCard({ data }: { data: GlucoseOk }) {
  const colors = useColors();
  const { view } = useForecast();
  const forecast = view.kind === 'ok' ? view.data : null;
  const model = useMemo(() => (forecast ? buildOnBoardChart(data, forecast) : null), [data, forecast]);
  if (!model || !forecast) return null;
  const end = hoursText(model.endMinutes);
  const a = forecast.mealAware.availability;

  return (
    <Card elevated>
      <Text accessibilityRole="header" style={{ fontFamily: 'Manrope_700Bold', fontSize: 13, color: colors.ink2, textTransform: 'uppercase', letterSpacing: 0.5 }}>
        How insulin and carbs wear off
      </Text>
      <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, lineHeight: 20, marginTop: 4 }}>
        Your blood sugar now and its predicted line, with the insulin and carbs you logged, over the same hours.
      </Text>

      <View style={{ marginTop: 12 }}>
        <Chart model={model} />
      </View>

      <View style={{ gap: 10, marginTop: 14 }}>
        <LegendRow
          swatch={<Swatch color={colors.blue700} />}
          title="Blood sugar"
          text={`${Math.round(data.glucoseMgdl)} mg/dL now. The dotted line is the predicted range's middle, from your forecast.`}
        />
        <LegendRow
          swatch={<Swatch color={colors.purple600} />}
          title="Insulin on board"
          text={
            model.hasInsulin && model.insulinNow !== null && model.insulinEnd !== null
              ? `${units(model.insulinNow)} now, ${units(model.insulinEnd)} by ${end}. From the doses you logged.`
              : a.insulin === 'confirmed_none'
                ? 'None taken (you confirmed), so there is no curve.'
                : 'Unknown: no insulin logged recently, so there is no curve.'
          }
        />
        <LegendRow
          swatch={<Swatch color={colors.amber600} />}
          title="Carbs on board"
          text={
            model.hasCarbs && model.carbsNow !== null && model.carbsEnd !== null
              ? `${grams(model.carbsNow)} now, ${grams(model.carbsEnd)} by ${end}. From the meals you entered.`
              : 'None logged recently, so there is no curve.'
          }
        />
      </View>

      <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 13, color: colors.ink3, lineHeight: 18, marginTop: 12 }}>
        Insulin and carbs are each drawn on their own scale, starting at the top, so you can see how fast they wear off: read the numbers, not the heights. Press and drag on the
        graph to read all three at any time. Estimates from your entries. Not medical advice.
      </Text>
    </Card>
  );
}
