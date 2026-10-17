import React, { useMemo, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import {
  buildInsulinEvent,
  buildNoInsulinEvent,
  newEventId,
  parseNumber,
  validateInsulin,
  type InsulinType,
  type TimeChoice,
} from '../services/events';
import { estimateDose, unitsLabel, type DoseEstimate } from '../services/doseEstimate';
import { LOW_GLUCOSE_MGDL } from '../services/mealInsulinEstimate';
import { useEvents } from '../services/EventsProvider';
import { useDoseInputs } from '../services/useDoseInputs';
import { radius, touch, useColors } from '../theme';
import { PrimaryButton, SecondaryButton } from './Buttons';
import { Card } from './Card';
import { ResultBanner, useRecord } from './EventResult';
import { ChoiceChips, EventTimePicker, FormField } from './FormField';

const NOW: TimeChoice = { mode: 'minutesAgo', minutes: 0 };
const STEP = 0.5;
const MEAL_INSULIN: { value: InsulinType; label: string }[] = [
  { value: 'rapid', label: 'Rapid-acting' },
  { value: 'ultra_rapid', label: 'Ultra-rapid' },
];

/**
 * After the carbs are confirmed: the meal dose (this meal only), the combined dose (meal + correction
 * - insulin on board, with every term shown), and an EDITABLE dose. Pressing "I took X units" is the
 * person's explicit statement and records it as taken insulin for this meal (the same event pathway as
 * any recorded injection), which is what lets the forecast and the learning use it. "I took none"
 * records a confirmed 0 U. A suggestion is never recorded by itself.
 */
export function DoseConfirmCard({
  carbsG,
  mealTimeIso,
  mealKey,
  onOpenSettings,
  onDone,
  hideDone = false,
}: {
  carbsG: number;
  mealTimeIso: string;
  /** The meal's server id, or its local id while the server does not have it yet. */
  mealKey: string;
  onOpenSettings: () => void;
  onDone: () => void;
  /** The screen already has its own pinned Done button. */
  hideDone?: boolean;
}) {
  const colors = useColors();
  const inputs = useDoseInputs();
  const { addEvent, discard, saveAnyway, sendNow } = useEvents();
  const [openedAt] = useState(() => new Date());

  const estimate: DoseEstimate | null = useMemo(
    () =>
      inputs.loading
        ? null
        : estimateDose({
            carbsG,
            therapy: inputs.therapy,
            targetMgdl: inputs.targetMgdl,
            glucose: inputs.glucose,
            iobUnits: inputs.iobUnits,
            mealTime: new Date(mealTimeIso),
            now: openedAt,
          }),
    [inputs, carbsG, mealTimeIso, openedAt],
  );

  // The dose field starts from the combined suggestion until the person edits it.
  const suggestedText = estimate?.kind === 'ok' ? estimate.combined.text : '';
  const [edited, setEdited] = useState<string | null>(null);
  const unitsText = edited ?? suggestedText;
  const [pickedType, setPickedType] = useState<InsulinType | null>(null);
  const insulinType = pickedType ?? inputs.insulinType;
  const [time, setTime] = useState<TimeChoice>(NOW);
  const [hhmm, setHhmm] = useState('');
  const [showTime, setShowTime] = useState(false);
  const [errors, setErrors] = useState<{ units?: string; insulinType?: string; time?: string }>({});

  const idRef = useRef<string | null>(null);
  const [submittedId, setSubmittedId] = useState<string | null>(null);
  const record = useRecord(submittedId);

  const parsed = parseNumber(unitsText);
  const setUnits = (n: number) => setEdited(String(Math.max(0, Math.round(n * 100) / 100)));

  const confirmTaken = () => {
    if (submittedId) return;
    const none = parsed === 0;
    if (none) {
      setErrors({ units: 'Use "I took none" to record that no insulin was taken.' });
      return;
    }
    const result = validateInsulin(
      { units: unitsText, insulinKind: 'bolus', insulinType, confirmedTaken: true, notSure: false, time, notes: '', mealId: mealKey, glucose: '' },
      new Date(),
    );
    if (!result.ok) {
      setErrors({ units: result.errors.units, insulinType: result.errors.insulinType, time: result.errors.time });
      return;
    }
    setErrors({});
    if (!idRef.current) idRef.current = newEventId();
    setSubmittedId(idRef.current);
    addEvent(buildInsulinEvent(idRef.current, result.value));
  };

  const confirmNone = () => {
    if (submittedId) return;
    if (!idRef.current) idRef.current = newEventId();
    setSubmittedId(idRef.current);
    addEvent(
      buildNoInsulinEvent(
        idRef.current,
        { occurredAtUtc: mealTimeIso, utcOffsetMin: -new Date(mealTimeIso).getTimezoneOffset(), mealId: mealKey },
        insulinType ?? 'rapid',
      ),
    );
  };

  const editAgain = () => {
    if (submittedId) discard(submittedId);
    idRef.current = null;
    setSubmittedId(null);
  };

  return (
    <>
      <Card elevated>
        <Text accessibilityRole="header" style={{ fontFamily: 'Manrope_700Bold', fontSize: 14, color: colors.ink2, textTransform: 'uppercase', letterSpacing: 0.5 }}>
          Suggested insulin
        </Text>
        {estimate === null ? (
          <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, marginTop: 8 }}>Reading your saved settings...</Text>
        ) : estimate.kind === 'ok' ? (
          <Suggestion estimate={estimate} onOpenSettings={onOpenSettings} />
        ) : (
          <Problem estimate={estimate} onSettings={onOpenSettings} />
        )}
      </Card>

      <Card>
        {record ? (
          <View style={{ gap: 12 }}>
            <ResultBanner
              record={record}
              onSaveAnyway={() => saveAnyway(record.event.id)}
              onDiscardDuplicate={() => {
                discard(record.event.id);
                onDone();
              }}
              onEditAgain={editAgain}
              onDone={onDone}
              onSendNow={sendNow}
              hideDone={hideDone}
            >
              <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink2, lineHeight: 20 }}>
                {record.event.kind === 'insulin' && record.event.unitsAdministered === 0
                  ? 'No insulin taken for this meal.'
                  : record.event.kind === 'insulin'
                    ? `${trimUnits(record.event.unitsAdministered)} ${unitsLabel(trimUnits(record.event.unitsAdministered))} entered as taken for this meal.`
                    : ''}
              </Text>
            </ResultBanner>
          </View>
        ) : (
          <View style={{ gap: 12 }}>
            <Text accessibilityRole="header" style={{ fontFamily: 'Manrope_700Bold', fontSize: 16, color: colors.ink }}>
              Your dose for this meal
            </Text>
            <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, lineHeight: 20 }}>
              {estimate?.kind === 'ok' ? 'Starts from the combined suggestion. Change it to what you actually take.' : 'Enter the units you actually take.'}
            </Text>

            <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8 }}>
              <Stepper label="Less insulin" symbol="−" onPress={() => setUnits((parsed ?? 0) - STEP)} />
              <View style={{ flex: 1 }}>
                <FormField label="Units" value={unitsText} onChangeText={setEdited} keyboardType="decimal-pad" placeholder="0" error={errors.units} />
              </View>
              <Stepper label="More insulin" symbol="+" onPress={() => setUnits((parsed ?? 0) + STEP)} />
            </View>

            {estimate?.kind === 'ok' ? (
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                <QuickSet label={`Meal ${estimate.meal.text}`} onPress={() => setEdited(estimate.meal.text)} />
                <QuickSet label={`Combined ${estimate.combined.text}`} onPress={() => setEdited(estimate.combined.text)} />
              </View>
            ) : null}

            <View style={{ gap: 8 }}>
              <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink }}>Insulin type *</Text>
              <ChoiceChips options={MEAL_INSULIN} value={insulinType ?? ('' as InsulinType)} onChange={setPickedType} />
              {errors.insulinType ? (
                <Text accessibilityLiveRegion="polite" style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.red600 }}>
                  {errors.insulinType}
                </Text>
              ) : null}
            </View>

            {showTime ? (
              <EventTimePicker value={time} hhmm={hhmm} onChange={setTime} onChangeHhmm={setHhmm} error={errors.time} />
            ) : (
              <Pressable
                onPress={() => setShowTime(true)}
                accessibilityRole="button"
                accessibilityLabel="Taken earlier? Change the time"
                style={{ minHeight: touch.min, justifyContent: 'center' }}
              >
                <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.blue600 }}>Taken just now · change time</Text>
              </Pressable>
            )}

            <PrimaryButton
              label={parsed !== null && parsed > 0 ? `I took ${unitsText} ${unitsLabel(unitsText)}` : 'I took this dose'}
              onPress={confirmTaken}
              disabled={parsed === null || parsed <= 0}
            />
            <SecondaryButton label="I took none for this meal" onPress={confirmNone} />
            <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 13, color: colors.ink3, lineHeight: 18 }}>
              Pressing a button above records it as insulin you took. Not medical advice; SugarSense never delivers insulin.
            </Text>
          </View>
        )}
      </Card>
    </>
  );
}

function Stepper({ label, symbol, onPress }: { label: string; symbol: string; onPress: () => void }) {
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        {
          width: touch.min,
          height: touch.min,
          marginBottom: 2,
          borderRadius: touch.min / 2,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: colors.blue100,
        },
        pressed ? { opacity: 0.8 } : null,
      ]}
    >
      <Text style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 24, color: colors.blue600, lineHeight: 28 }}>{symbol}</Text>
    </Pressable>
  );
}

function QuickSet({ label, onPress }: { label: string; onPress: () => void }) {
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Set the dose to: ${label}`}
      style={{
        minHeight: touch.min,
        paddingHorizontal: 14,
        justifyContent: 'center',
        borderRadius: radius.pill,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface,
      }}
    >
      <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink }}>{label} U</Text>
    </Pressable>
  );
}

function Row({ label, value, sub, strong }: { label: string; value: string; sub?: string; strong?: boolean }) {
  const colors = useColors();
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
      <View style={{ flex: 1 }}>
        <Text style={{ fontFamily: strong ? 'Manrope_700Bold' : 'Manrope_600SemiBold', fontSize: 14, color: colors.ink }}>{label}</Text>
        {sub ? <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 13, color: colors.ink2, lineHeight: 18 }}>{sub}</Text> : null}
      </View>
      <Text style={{ fontFamily: strong ? 'Manrope_800ExtraBold' : 'Manrope_700Bold', fontSize: strong ? 16 : 14, color: colors.ink }}>{value}</Text>
    </View>
  );
}

function Suggestion({ estimate, onOpenSettings }: { estimate: Extract<DoseEstimate, { kind: 'ok' }>; onOpenSettings: () => void }) {
  const colors = useColors();
  const { meal, correction, iob, combined, notes } = estimate;
  const corrValue = correction.kind === 'included' ? `+${trimUnits(correction.units)}` : '0';
  const iobValue = iob.kind === 'subtracted' && iob.units > 0 ? `−${trimUnits(iob.units)}` : '0';
  const needsSettings = correction.kind === 'excluded' && (correction.reason === 'no_target' || correction.reason === 'no_isf');
  return (
    <View style={{ marginTop: 6, gap: 10 }}>
      <View>
        <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink2 }}>For this meal</Text>
        <Text accessibilityLiveRegion="polite" style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 34, color: colors.ink }}>
          {meal.text} <Text style={{ fontSize: 18, fontFamily: 'Manrope_700Bold', color: colors.ink2 }}>{unitsLabel(meal.text)}</Text>
        </Text>
        <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2 }}>{meal.explanation}</Text>
      </View>

      <View style={{ height: 1, backgroundColor: colors.divider }} />

      <View>
        <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink2 }}>Combined with glucose and insulin on board</Text>
        <Text style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 28, color: colors.ink }}>
          {combined.text} <Text style={{ fontSize: 16, fontFamily: 'Manrope_700Bold', color: colors.ink2 }}>{unitsLabel(combined.text)}</Text>
        </Text>
      </View>

      <View style={{ gap: 8, backgroundColor: colors.ground, borderRadius: radius.row, padding: 12 }}>
        <Row label="Meal" value={meal.text} />
        <Row label="Correction" value={corrValue} sub={correction.explanation} />
        <Row label="Insulin on board" value={iobValue} sub={iob.explanation} />
        <View style={{ height: 1, backgroundColor: colors.divider }} />
        <Row label="Combined" value={combined.text} strong />
      </View>

      {needsSettings ? <SecondaryButton label="Open insulin settings" onPress={onOpenSettings} /> : null}
      {notes.map((n) => (
        <Text key={n} style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.amberDark, lineHeight: 20 }}>
          {n}
        </Text>
      ))}
      <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 13, color: colors.ink3, lineHeight: 18 }}>
        From your saved ratio, correction factor, target and logged insulin. Exercise, illness and fat or protein delay are not included. Check before using; it is
        not an instruction.
      </Text>
    </View>
  );
}

const trimUnits = (n: number) => (Math.round(n * 10) / 10).toString();

function Problem({ estimate, onSettings }: { estimate: Exclude<DoseEstimate, { kind: 'ok' }>; onSettings: () => void }) {
  const colors = useColors();
  const text = (() => {
    switch (estimate.kind) {
      case 'ratio_not_set':
        return 'No insulin-to-carb ratio is saved yet, so there is nothing to calculate from.';
      case 'ratio_unavailable':
        return 'Your saved ratio could not be read right now. No suggestion is shown.';
      case 'ratio_invalid':
        return 'The saved ratio has no valid value for this time of day. Check it in Insulin settings.';
      case 'low_glucose':
        return `Your latest glucose is ${Math.round(estimate.glucoseMgdl)} mg/dL (below ${LOW_GLUCOSE_MGDL}). No suggestion is shown. Deal with the low first.`;
      case 'too_high':
        return `The calculation gives ${estimate.units} units, which is above the safety limit this app will show. Check the carbs and your settings.`;
      case 'no_carbs':
        return 'There are no carbohydrates to calculate from.';
    }
  })();
  const needsSettings = estimate.kind === 'ratio_not_set' || estimate.kind === 'ratio_invalid' || estimate.kind === 'too_high';
  return (
    <View style={{ gap: 10, marginTop: 8 }}>
      <Text accessibilityLiveRegion="polite" style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink, lineHeight: 20 }}>
        {text}
      </Text>
      {needsSettings ? <SecondaryButton label="Open insulin settings" onPress={onSettings} /> : null}
    </View>
  );
}
