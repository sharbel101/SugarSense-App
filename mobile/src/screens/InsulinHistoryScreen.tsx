import { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { InsulinView } from '../api/eventsApi';
import { BackButton, IconButton, PrimaryButton, SecondaryButton } from '../components/Buttons';
import { Card } from '../components/Card';
import { EditInsulin } from '../components/EventList';
import { Icon } from '../components/Icon';
import { RootStackParamList } from '../navigation/types';
import { useEvents } from '../services/EventsProvider';
import { formatEventTime, INSULIN_KINDS, INSULIN_TYPES } from '../services/events';
import { dayKey, dayLabel, lastDays } from '../services/mealHistory';
import { radius, spacing, touch, useColors } from '../theme';

const DAYS_SHOWN = 3;

const amount = (i: InsulinView) => (i.unitsTaken === null ? '? U' : i.unitsTaken === 0 ? 'None' : `${Math.round(i.unitsTaken * 100) / 100} U`);

/**
 * Insulin doses grouped by day: the same layout as the meal history. Data is `GET /events/recent` (the
 * server returns at most the last 48 hours), so the day picker covers today, yesterday and the day
 * before. A dose can be corrected or removed (removed = withdrawn as a mistake; it stays in the history
 * on the server and stops counting in the forecast). Removing never un-takes insulin in real life.
 */
export function InsulinHistoryScreen({ navigation }: NativeStackScreenProps<RootStackParamList, 'InsulinHistory'>) {
  const colors = useColors();
  const { recent, refreshRecent, editInsulin } = useEvents();
  const [now] = useState(() => new Date());
  const days = useMemo(() => lastDays(now, DAYS_SHOWN), [now]);
  const [dayIndex, setDayIndex] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<InsulinView | null>(null);
  const [askRemove, setAskRemove] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    refreshRecent();
  }, [refreshRecent]);

  const doses = useMemo(() => {
    if (recent.kind !== 'ok') return [];
    return recent.insulin
      .filter((i) => i.status !== 'cancelled' && dayKey(new Date(i.administeredAt)) === days[dayIndex])
      .sort((a, b) => Date.parse(b.administeredAt) - Date.parse(a.administeredAt));
  }, [recent, days, dayIndex]);
  const total = useMemo(() => {
    const known = doses.filter((d) => d.unitsTaken !== null && d.confirmation !== 'planned');
    return known.length > 0 ? known.reduce((s, d) => s + (d.unitsTaken as number), 0) : null;
  }, [doses]);

  const remove = async (d: InsulinView) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const out = await editInsulin(d.id, { status: 'cancelled', expectedRevision: d.revision });
    setBusy(false);
    setAskRemove(null);
    if (out.result === 'updated' || out.result === 'unchanged' || out.result === 'exists') refreshRecent();
    else if (out.result === 'conflict') {
      refreshRecent();
      setError('This dose changed - please check it again.');
    } else setError('Could not remove it right now. Nothing was changed - try again.');
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.ground }}>
      <View style={{ paddingHorizontal: spacing.xl, paddingTop: spacing.lg, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <BackButton onPress={() => (editing ? setEditing(null) : navigation.goBack())} accessibilityLabel={editing ? 'Back to insulin' : 'Back'} />
        <Text accessibilityRole="header" style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 20, color: colors.ink }}>
          {editing ? 'Edit insulin' : 'Insulin'}
        </Text>
      </View>

      {editing ? (
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: spacing.xl, gap: 14 }}>
          <EditInsulin
            view={editing}
            onClose={() => {
              setEditing(null);
              refreshRecent();
            }}
          />
        </ScrollView>
      ) : (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.xl, paddingTop: spacing.md }}>
            <IconButton accessibilityLabel="Previous day" onPress={() => setDayIndex((i) => Math.min(DAYS_SHOWN - 1, i + 1))} size={touch.min}>
              <Icon name="back" size={18} color={dayIndex >= DAYS_SHOWN - 1 ? colors.ink4 : colors.blue600} />
            </IconButton>
            <View style={{ alignItems: 'center' }}>
              <Text accessibilityRole="header" style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 18, color: colors.ink }}>
                {dayLabel(days[dayIndex], now)}
              </Text>
              <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2 }}>
                {doses.length === 0 ? 'No insulin' : `${doses.length} dose${doses.length === 1 ? '' : 's'}${total !== null ? ` · ${Math.round(total * 10) / 10} U` : ''}`}
              </Text>
            </View>
            <View style={{ transform: [{ rotate: '180deg' }] }}>
              <IconButton accessibilityLabel="Next day" onPress={() => setDayIndex((i) => Math.max(0, i - 1))} size={touch.min}>
                <Icon name="back" size={18} color={dayIndex === 0 ? colors.ink4 : colors.blue600} />
              </IconButton>
            </View>
          </View>

          <ScrollView contentContainerStyle={{ padding: spacing.xl, paddingBottom: spacing.xxxl, gap: 12 }}>
            {recent.kind === 'loading' || recent.kind === 'idle' ? (
              <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2 }}>Loading insulin...</Text>
            ) : null}
            {recent.kind === 'unavailable' ? (
              <Card>
                <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 15, color: colors.ink }}>Insulin is not available right now</Text>
                <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, marginTop: 4 }}>
                  The server could not be reached. Nothing is shown rather than guessing.
                </Text>
                <View style={{ marginTop: 10 }}>
                  <SecondaryButton label="Try again" onPress={refreshRecent} />
                </View>
              </Card>
            ) : null}
            {error ? (
              <Text accessibilityLiveRegion="polite" style={{ fontFamily: 'Manrope_700Bold', fontSize: 14, color: colors.red600 }}>
                {error}
              </Text>
            ) : null}
            {recent.kind === 'ok' && doses.length === 0 ? (
              <Card>
                <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 15, color: colors.ink }}>
                  {dayIndex === 0 ? 'No insulin logged today' : 'No insulin logged this day'}
                </Text>
                <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, marginTop: 4 }}>
                  {dayIndex === 0 ? 'Use Log insulin on Home to record a dose.' : 'Use the arrows to look at another day.'}
                </Text>
              </Card>
            ) : null}

            {doses.map((d) => {
              const open = openId === d.id;
              const kind = INSULIN_KINDS.find((k) => k.value === d.kind)?.label ?? 'Insulin';
              const type = INSULIN_TYPES.find((t) => t.value === d.insulinType)?.label;
              return (
                <View key={d.id} style={{ backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.row }}>
                  <Pressable
                    onPress={() => setOpenId(open ? null : d.id)}
                    accessibilityRole="button"
                    aria-expanded={open}
                    accessibilityLabel={`${kind}, ${formatEventTime(d.administeredAt)}, ${amount(d)}. ${open ? 'Hide' : 'Show'} details`}
                    style={{ minHeight: 64, paddingHorizontal: 16, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 12 }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 16, color: colors.ink }}>{kind}</Text>
                      <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2 }}>{formatEventTime(d.administeredAt)}</Text>
                    </View>
                    <Text style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 20, color: colors.ink }}>{amount(d)}</Text>
                    <Icon name="chevronDown" size={16} color={colors.ink3} />
                  </Pressable>
                  {open ? (
                    <View style={{ paddingHorizontal: 16, paddingBottom: 14, gap: 6, borderTopWidth: 1, borderTopColor: colors.divider, paddingTop: 10 }}>
                      {type ? <Detail label="Type" value={type} /> : null}
                      <Detail label="Recorded as" value={d.confirmation === 'confirmed' ? 'Taken (you confirmed)' : d.confirmation === 'uncertain' ? 'Taken, amount or time approximate' : 'Planned, not taken'} />
                      <Detail label="For a meal" value={d.mealId ? 'Yes' : 'No meal linked'} />
                      {askRemove === d.id ? (
                        <View style={{ gap: 8, marginTop: 6 }}>
                          <Text accessibilityLiveRegion="polite" style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink, lineHeight: 20 }}>
                            Remove this dose? It stops counting in the forecast and stays in your history on the server. It does not change insulin you already took.
                          </Text>
                          <PrimaryButton label="Remove" onPress={() => void remove(d)} loading={busy} />
                          <SecondaryButton label="Keep it" onPress={() => setAskRemove(null)} />
                        </View>
                      ) : (
                        <View style={{ flexDirection: 'row', gap: 10, marginTop: 6 }}>
                          <View style={{ flex: 1 }}>
                            <SecondaryButton label="Edit" onPress={() => setEditing(d)} />
                          </View>
                          <IconButton accessibilityLabel={`Remove ${kind} ${amount(d)}`} onPress={() => setAskRemove(d.id)} size={touch.min} bg={colors.red100}>
                            <Icon name="trash" size={20} color={colors.red600} />
                          </IconButton>
                        </View>
                      )}
                    </View>
                  ) : null}
                </View>
              );
            })}

            <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 13, color: colors.ink3, lineHeight: 18 }}>
              Shows the last 48 hours the server returns. Not medical advice.
            </Text>
          </ScrollView>
        </>
      )}
    </SafeAreaView>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  const colors = useColors();
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
      <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2 }}>{label}</Text>
      <Text style={{ flexShrink: 1, textAlign: 'right', fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink }}>{value}</Text>
    </View>
  );
}
