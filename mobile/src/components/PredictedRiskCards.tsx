import React, { useEffect, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Platform, Pressable, Text, View } from 'react-native';
import { useForecast } from '../services/ForecastProvider';
import { useGlucose } from '../services/GlucoseProvider';
import { useRiskAlerts } from '../services/RiskAlertsProvider';
import { detectPredictedRisks, HIGH_THRESHOLD_MGDL, LOW_THRESHOLD_MGDL, riskSummary, type RiskKind } from '../services/riskAlerts';
import { radius, useColors } from '../theme';
import { PrimaryButton, SecondaryButton } from './Buttons';
import { Card } from './Card';
import { Icon } from './Icon';

/** Ticks every 30 s so "in about 1 h 20 min" keeps counting down while the screen is open. */
function useNowMs(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/**
 * A slow pulse (about one beat every 3 seconds, far below anything that could trigger a flash
 * sensitivity) while `active`; it stays still when the person asked their phone to reduce motion.
 * Returns a 0..1 value to drive overlay opacity.
 */
function usePulse(active: boolean): Animated.Value {
  const [value] = useState(() => new Animated.Value(0));
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((on) => {
      if (alive) setReduceMotion(on);
    });
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (!active) {
      value.setValue(0);
      return;
    }
    if (reduceMotion) {
      value.setValue(1);
      return;
    }
    const native = Platform.OS !== 'web';
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(value, { toValue: 1, duration: 1500, easing: Easing.inOut(Easing.ease), useNativeDriver: native }),
        Animated.timing(value, { toValue: 0, duration: 1500, easing: Easing.inOut(Easing.ease), useNativeDriver: native }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [active, reduceMotion, value]);
  return value;
}

/**
 * One big square on the Safety screen per kind of risk (the two fill the screen, one above the other).
 * White when nothing is predicted; red for a low and orange for a high when one is predicted or the
 * latest reading is already past the line, and then the box pulses slowly. It shows only a few numbers:
 * what and when, the value, and the reading now. Tapping opens the predictions page. When there is no
 * forecast it says so (never "all clear"); a reading already past the line still raises it.
 */
export function PredictedRiskCard({ kind, onPress }: { kind: RiskKind; onPress: () => void }) {
  const colors = useColors();
  const { view } = useForecast();
  const glucose = useGlucose();
  const now = useNowMs();
  const name = kind === 'low' ? 'Low' : 'High';
  const threshold = kind === 'low' ? LOW_THRESHOLD_MGDL : HIGH_THRESHOLD_MGDL;
  const past = (v: number) => (kind === 'low' ? v < threshold : v > threshold);

  const reading = glucose.view.kind === 'ok' ? glucose.view.data.glucoseMgdl : view.kind === 'ok' ? view.data.anchor.glucoseMgdl : null;
  const risk = view.kind === 'ok' ? detectPredictedRisks(view.data)[kind] : null;
  const readingPast = reading !== null && past(reading);

  let tone: 'alert' | 'quiet' | 'unknown' = 'unknown';
  let big = 'No forecast';
  const lines: string[] = [];
  if (risk) {
    tone = 'alert';
    const t = riskSummary(risk, now);
    big = risk.alreadyPast ? name + ' now' : t.title;
    if (!risk.alreadyPast) lines.push(t.detail);
    if (t.extreme) lines.push(t.extreme);
    if (reading !== null) lines.push('Now ' + Math.round(reading) + ' mg/dL');
  } else if (readingPast && reading !== null) {
    tone = 'alert';
    big = name + ' now';
    lines.push('Reading ' + Math.round(reading) + ' mg/dL, ' + (kind === 'low' ? 'below ' : 'above ') + threshold);
    if (view.kind !== 'ok') lines.push('No forecast right now');
  } else if (view.kind === 'ok') {
    tone = 'quiet';
    big = 'None predicted';
    if (reading !== null) lines.push('Now ' + Math.round(reading) + ' mg/dL');
    lines.push('Next 3 hours stay ' + (kind === 'low' ? 'at or above ' : 'at or below ') + threshold);
  } else {
    if (reading !== null) lines.push('Now ' + Math.round(reading) + ' mg/dL');
    lines.push('Forecast not available right now');
  }

  const pulse = usePulse(tone === 'alert');
  const alertBg = kind === 'low' ? colors.red100 : colors.amber100;
  // green when nothing is predicted, red (low) / orange (high) when it is, white when there is no forecast to judge by
  const fg = tone === 'alert' ? (kind === 'low' ? colors.red600 : colors.amberDark) : tone === 'quiet' ? colors.greenDark : colors.ink;
  const sub = tone === 'unknown' ? colors.ink2 : fg;
  const accent = fg;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={name + ': ' + big + '. ' + lines.join('. ') + '. Opens the predictions.'}
      style={({ pressed }) => [
        {
          flex: 1,
          minHeight: 190,
          borderRadius: radius.card,
          padding: 20,
          justifyContent: 'space-between',
          overflow: 'hidden',
          // calm = light green with a green edge; alert = tinted red / orange fill that pulses; no forecast = white
          backgroundColor: tone === 'alert' ? alertBg : tone === 'quiet' ? colors.green100 : colors.surface,
          borderWidth: tone === 'quiet' ? 2 : 1,
          borderColor: tone === 'alert' ? alertBg : tone === 'quiet' ? colors.green600 : colors.border,
        },
        pressed ? { opacity: 0.9 } : null,
      ]}
    >
      {tone === 'alert' ? (
        <>
          {/* the pulse: a tint over the box and a coloured edge that breathe together */}
          <Animated.View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: fg, opacity: Animated.multiply(pulse, 0.1) }} />
          <Animated.View
            pointerEvents="none"
            style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: radius.card, borderWidth: 4, borderColor: fg, opacity: Animated.add(0.25, Animated.multiply(pulse, 0.75)) }}
          />
        </>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          {tone === 'alert' ? <Icon name="alertTriangle" size={20} color={fg} /> : null}
          {tone === 'quiet' ? (
            <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: colors.green600, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="check" size={18} color={colors.onBlue} strokeWidth={2.5} />
            </View>
          ) : null}
          <Text accessibilityRole="header" style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 14, letterSpacing: 1, color: accent }}>
            {name.toUpperCase()}
          </Text>
        </View>
        <Icon name="chevronRight" size={18} color={tone === 'unknown' ? colors.ink3 : fg} />
      </View>
      <View style={{ gap: 6 }}>
        <Text accessibilityLiveRegion="polite" style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 26, lineHeight: 32, color: fg }}>
          {big}
        </Text>
        {lines.map((l) => (
          <Text key={l} style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 15, lineHeight: 21, color: sub }}>
            {l}
          </Text>
        ))}
      </View>
    </Pressable>
  );
}

/** Turn the browser alerts for these predictions on or off. Short on purpose. */
export function AlertsControlCard() {
  const colors = useColors();
  const { permission, enabled, enable, disable, sendTest } = useRiskAlerts();
  const [testResult, setTestResult] = useState<string | null>(null);
  const line = { fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, lineHeight: 20 } as const;

  return (
    <Card style={{ padding: 14, gap: 8 }}>
      <Text accessibilityRole="header" style={{ fontFamily: 'Manrope_700Bold', fontSize: 15, color: colors.ink }}>Alerts</Text>
      {Platform.OS !== 'web' ? (
        <Text style={line}>Alerts are in the web app for now.</Text>
      ) : permission === 'unsupported' ? (
        <Text style={line}>This browser cannot show alerts. On iPhone, open SugarSense from the Home Screen icon.</Text>
      ) : permission === 'denied' ? (
        <Text style={line}>Alerts are blocked in your browser settings for this site.</Text>
      ) : enabled ? (
        <>
          <Text accessibilityLiveRegion="polite" style={{ ...line, color: colors.ink, fontFamily: 'Manrope_600SemiBold' }}>
            On. You hear when a low or high is predicted, and when it clears.
          </Text>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ flex: 1 }}>
              <SecondaryButton
                label="Test"
                onPress={() => {
                  setTestResult(null);
                  void sendTest().then((ok) => setTestResult(ok ? 'Test alert sent.' : 'The test alert could not be shown.'));
                }}
              />
            </View>
            <View style={{ flex: 1 }}>
              <SecondaryButton label="Turn off" onPress={disable} />
            </View>
          </View>
          {testResult ? (
            <Text accessibilityLiveRegion="polite" style={{ ...line, color: colors.ink, fontFamily: 'Manrope_600SemiBold' }}>{testResult}</Text>
          ) : null}
        </>
      ) : (
        <>
          <Text style={line}>Get an alert when a low or high is predicted, and when it clears.</Text>
          <PrimaryButton label="Turn on alerts" onPress={() => void enable()} />
        </>
      )}
      <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 13, color: colors.ink3, lineHeight: 18 }}>
        Alerts arrive while SugarSense is open. Estimates, not medical advice.
      </Text>
    </Card>
  );
}
