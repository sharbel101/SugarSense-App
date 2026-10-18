import React, { useEffect, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { useForecast } from '../services/ForecastProvider';
import { useRiskAlerts } from '../services/RiskAlertsProvider';
import { detectPredictedRisks, HIGH_THRESHOLD_MGDL, LOW_THRESHOLD_MGDL, riskSummary, type RiskKind } from '../services/riskAlerts';
import { radius, touch, useColors } from '../theme';
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
 * One small Safety card per kind of predicted risk: a predicted low (forecast line below 80 mg/dL) or a
 * predicted high (above 240 mg/dL) anywhere in the next 3 hours. Tapping a card opens the graph of blood
 * sugar, insulin and carbs. Three honest states: predicted (what and when), not predicted, and not
 * available (no current forecast, so nothing can be said - never shown as "all clear").
 */
export function PredictedRiskCard({ kind, onPress }: { kind: RiskKind; onPress: () => void }) {
  const colors = useColors();
  const { view } = useForecast();
  const now = useNowMs();
  const name = kind === 'low' ? 'Low' : 'High';
  const threshold = kind === 'low' ? LOW_THRESHOLD_MGDL : HIGH_THRESHOLD_MGDL;

  let tone: 'alert' | 'quiet' | 'unknown' = 'unknown';
  let title = `${name}: no forecast right now`;
  let detail = '';
  if (view.kind === 'ok') {
    const risk = detectPredictedRisks(view.data)[kind];
    if (risk) {
      tone = 'alert';
      ({ title, detail } = riskSummary(risk, now));
    } else {
      tone = 'quiet';
      title = `No ${name.toLowerCase()} predicted`;
      detail = `Next 3 hours: stays ${kind === 'low' ? 'at or above' : 'at or below'} ${threshold} mg/dL`;
    }
  }

  const bg = tone === 'alert' ? (kind === 'low' ? colors.red100 : colors.amber100) : colors.surface;
  const fg = tone === 'alert' ? (kind === 'low' ? colors.red600 : colors.amberDark) : colors.ink;
  const sub = tone === 'alert' ? fg : colors.ink2;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title}${detail ? `. ${detail}` : ''}. Opens the graph.`}
      style={({ pressed }) => [
        {
          minHeight: touch.min + 8,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          paddingVertical: 12,
          paddingHorizontal: 16,
          borderRadius: radius.row,
          backgroundColor: bg,
          borderWidth: tone === 'alert' ? 0 : 1,
          borderColor: colors.border,
        },
        pressed ? { opacity: 0.85 } : null,
      ]}
    >
      {tone === 'alert' ? <Icon name="alertTriangle" size={20} color={fg} /> : null}
      <View style={{ flex: 1 }}>
        <Text accessibilityLiveRegion="polite" style={{ fontFamily: 'Manrope_700Bold', fontSize: 15, color: fg, lineHeight: 20 }}>
          {title}
        </Text>
        {detail ? <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: sub, lineHeight: 20 }}>{detail}</Text> : null}
      </View>
      <Icon name="chevronRight" size={16} color={tone === 'alert' ? fg : colors.ink3} />
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
