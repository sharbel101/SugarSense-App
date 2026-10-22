import React from 'react';
import { Text, View } from 'react-native';
import { formatCarbsOnBoard, formatInsulinOnBoard } from '../services/forecastView';
import { formatAge, formatClock } from '../services/glucoseState';
import type { LastKnown } from '../services/lastKnown';
import { radius, useColors } from '../theme';
import { SecondaryButton } from './Buttons';

/**
 * What Home shows when there is no fresh reading: the LAST reading, clearly labelled as old (never as current),
 * so the page is not blank. A reading this old is not a basis for a decision: the card says to check glucose.
 */
export function LastReading({ last, reason, nowMs, onRetry, retrying }: { last: LastKnown; reason: string | null; nowMs: number; onRetry: () => void; retrying: boolean }) {
  const colors = useColors();
  const g = last.glucose;
  const ageMin = g ? Math.max(0, (nowMs - Date.parse(g.measuredAt)) / 60_000) : null;
  return (
    <View style={{ gap: 6 }}>
      {g && ageMin !== null ? (
        <>
          <View accessible accessibilityLabel={`Last reading ${Math.round(g.mgdl)} milligrams per decilitre, measured ${formatAge(ageMin)}. Too old to use as current.`} style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8 }}>
            <Text style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 56, color: colors.ink3, letterSpacing: -1.5 }}>{Math.round(g.mgdl)}</Text>
            <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 16, color: colors.ink3, marginBottom: 9 }}>mg/dL</Text>
          </View>
          <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 14, color: colors.ink }}>
            Last reading · measured {formatClock(g.measuredAt)} ({formatAge(ageMin)})
          </Text>
          <View style={{ alignSelf: 'flex-start', backgroundColor: colors.amber100, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4 }}>
            <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 13, color: colors.amberDark }}>Too old to use as current</Text>
          </View>
          <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, lineHeight: 20 }}>
            {reason ?? 'No recent reading.'} Use your own meter or sensor to check.
          </Text>
        </>
      ) : (
        <>
          <Text accessibilityRole="header" style={{ fontFamily: 'Manrope_700Bold', fontSize: 18, color: colors.ink }}>
            No reading yet
          </Text>
          <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, lineHeight: 20 }}>
            {reason ?? 'Waiting for your first reading.'}
          </Text>
        </>
      )}
      <View style={{ marginTop: 6 }}>
        <SecondaryButton label={retrying ? 'Retrying…' : 'Retry'} onPress={onRetry} disabled={retrying} />
      </View>
    </View>
  );
}

/**
 * Insulin and carbs on board from the LAST forecast, labelled "as of HH:MM". They may be lower now (insulin and
 * carbs act over time), and an amount we never had stays "unknown", never 0.
 */
export function LastOnBoard({ last }: { last: LastKnown }) {
  const colors = useColors();
  const b = last.onBoard;
  // After a save and before the refreshed forecast arrives, the remembered amounts predate what the person just
  // logged: say "unknown", never the old number (an old 0 g would read as "your meal is not counted").
  const updating = last.newEntrySinceForecast === true;
  const unknown = (label: string, caption: string) => ({ label, value: 'unknown', caption, known: false });
  const insulin = updating
    ? unknown('Insulin on board', 'updating after your entry')
    : b
      ? formatInsulinOnBoard({ insulinOnBoardUnits: b.insulinUnits, insulin: b.insulin })
      : unknown('Insulin on board', 'not available yet');
  const carbs = updating ? unknown('Carbs on board', 'updating after your entry') : b ? formatCarbsOnBoard({ carbsOnBoardGrams: b.carbsGrams }) : unknown('Carbs on board', 'not available yet');
  const asOf = b && !updating ? `as of ${formatClock(b.generatedAt)} · may be lower now` : null;
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        {[insulin, carbs].map((c) => (
          <View key={c.label} accessible accessibilityLabel={`${c.label} ${c.value}. ${c.caption}${asOf ? `, ${asOf}` : ''}`} style={{ flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: radius.row, padding: 12, gap: 2 }}>
            <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink2 }}>{c.label}</Text>
            <Text style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 22, color: c.known ? colors.ink : colors.ink3 }}>{c.value}</Text>
            <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 13, color: colors.ink2 }}>{c.caption}</Text>
          </View>
        ))}
      </View>
      {asOf ? <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 13, color: colors.ink3 }}>{asOf[0].toUpperCase() + asOf.slice(1)}</Text> : null}
    </View>
  );
}
