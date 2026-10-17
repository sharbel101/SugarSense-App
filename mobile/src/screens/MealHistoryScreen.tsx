import { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { MealView } from '../api/eventsApi';
import { BackButton, IconButton, PrimaryButton, SecondaryButton } from '../components/Buttons';
import { Card } from '../components/Card';
import { EditMeal } from '../components/EventList';
import { Icon } from '../components/Icon';
import { RootStackParamList } from '../navigation/types';
import { useEvents } from '../services/EventsProvider';
import { formatEventTime } from '../services/events';
import { carbsText, groupMealsByDay, lastDays, mealTitle } from '../services/mealHistory';
import { radius, spacing, touch, useColors } from '../theme';

const DAYS_SHOWN = 3;

const KIND_TEXT: Record<MealView['carbs']['kind'], string> = {
  estimated: 'AI estimate',
  user_corrected: 'Estimate corrected by you',
  user_entered: 'Entered by you',
  missing: 'Carbs unknown',
};

/**
 * Saved meals grouped by day. Data is `GET /events/recent` (the server returns at most the last
 * 48 hours), so the day picker covers today, yesterday and the day before; older days need a
 * date-range endpoint that does not exist yet.
 */
export function MealHistoryScreen({ navigation }: NativeStackScreenProps<RootStackParamList, 'MealHistory'>) {
  const colors = useColors();
  const { recent, refreshRecent, editMeal } = useEvents();
  const [now] = useState(() => new Date());
  const days = useMemo(() => lastDays(now, DAYS_SHOWN), [now]);
  const [dayIndex, setDayIndex] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<MealView | null>(null);
  const [askRemove, setAskRemove] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    refreshRecent();
  }, [refreshRecent]);

  const groups = useMemo(() => groupMealsByDay(recent.kind === 'ok' ? recent.meals : [], now, days), [recent, now, days]);
  const group = groups[dayIndex];

  const remove = async (m: MealView) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const out = await editMeal(m.id, { status: 'cancelled', expectedRevision: m.revision });
    setBusy(false);
    setAskRemove(null);
    if (out.result === 'updated' || out.result === 'unchanged' || out.result === 'exists') refreshRecent();
    else if (out.result === 'conflict') {
      refreshRecent();
      setError('This meal changed - please check it again.');
    } else setError('Could not remove it right now. Nothing was changed - try again.');
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.ground }}>
      <View style={{ paddingHorizontal: spacing.xl, paddingTop: spacing.lg, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <BackButton onPress={() => (editing ? setEditing(null) : navigation.goBack())} accessibilityLabel={editing ? 'Back to meals' : 'Back'} />
        <Text accessibilityRole="header" style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 20, color: colors.ink }}>
          {editing ? 'Edit meal' : 'Meals'}
        </Text>
      </View>

      {editing ? (
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: spacing.xl, gap: 14 }}>
          <EditMeal
            showTitle={false}
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
                {group.label}
              </Text>
              <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2 }}>
                {group.meals.length === 0
                  ? 'No meals'
                  : `${group.meals.length} meal${group.meals.length === 1 ? '' : 's'}${group.totalCarbsG !== null ? ` · ${Math.round(group.totalCarbsG)} g carbs` : ''}`}
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
              <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2 }}>Loading meals...</Text>
            ) : null}
            {recent.kind === 'unavailable' ? (
              <Card>
                <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 15, color: colors.ink }}>Meals are not available right now</Text>
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
            {recent.kind === 'ok' && group.meals.length === 0 ? (
              <Card>
                <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 15, color: colors.ink }}>
                  {dayIndex === 0 ? 'No meals logged today' : 'No meals logged this day'}
                </Text>
                <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, marginTop: 4 }}>
                  {dayIndex === 0 ? 'Photograph your next meal from Home to see it here.' : 'Use the arrows to look at another day.'}
                </Text>
              </Card>
            ) : null}

            {group.meals.map((m) => {
              const open = openId === m.id;
              return (
                <View key={m.id} style={{ backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.row }}>
                  <Pressable
                    onPress={() => setOpenId(open ? null : m.id)}
                    accessibilityRole="button"
                    aria-expanded={open}
                    accessibilityLabel={`${mealTitle(m)}, ${formatEventTime(m.eatenAt)}, ${carbsText(m)}. ${open ? 'Hide' : 'Show'} details`}
                    style={{ minHeight: 64, paddingHorizontal: 16, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 12 }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 16, color: colors.ink }}>{mealTitle(m)}</Text>
                      <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2 }}>{formatEventTime(m.eatenAt)}</Text>
                    </View>
                    <Text style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 18, color: colors.ink }}>
                      {m.carbs.grams === null ? '? g' : `${Math.round(m.carbs.grams)} g`}
                    </Text>
                    <Icon name="chevronDown" size={16} color={colors.ink3} />
                  </Pressable>
                  {open ? (
                    <View style={{ paddingHorizontal: 16, paddingBottom: 14, gap: 6, borderTopWidth: 1, borderTopColor: colors.divider, paddingTop: 10 }}>
                      <Detail label="Carbs" value={`${m.carbs.grams === null ? 'unknown' : `${Math.round(m.carbs.grams * 10) / 10} g`} · ${KIND_TEXT[m.carbs.kind]}`} />
                      {m.carbs.estimateRangeG ? <Detail label="AI range" value={`${Math.round(m.carbs.estimateRangeG.low)}-${Math.round(m.carbs.estimateRangeG.high)} g`} /> : null}
                      {m.fatG !== null ? <Detail label="Fat" value={`${Math.round(m.fatG)} g`} /> : null}
                      {m.proteinG !== null ? <Detail label="Protein" value={`${Math.round(m.proteinG)} g`} /> : null}
                      {m.fiberG !== null ? <Detail label="Fibre" value={`${Math.round(m.fiberG)} g`} /> : null}
                      {m.timeApproximateMin > 0 ? <Detail label="Time" value="approximate" /> : null}
                      {askRemove === m.id ? (
                        <View style={{ gap: 8, marginTop: 6 }}>
                          <Text accessibilityLiveRegion="polite" style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink, lineHeight: 20 }}>
                            Remove this meal? It stops counting in the forecast and stays in your history on the server.
                          </Text>
                          <PrimaryButton label="Remove" onPress={() => void remove(m)} loading={busy} />
                          <SecondaryButton label="Keep it" onPress={() => setAskRemove(null)} />
                        </View>
                      ) : (
                        <View style={{ flexDirection: 'row', gap: 10, marginTop: 6 }}>
                          <View style={{ flex: 1 }}>
                            <SecondaryButton label="Edit" onPress={() => setEditing(m)} />
                          </View>
                          <IconButton accessibilityLabel={`Remove ${mealTitle(m)}`} onPress={() => setAskRemove(m.id)} size={touch.min} bg={colors.red100}>
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
              Shows the last 48 hours the server returns. The server does not save the per-food breakdown, only the total.
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
