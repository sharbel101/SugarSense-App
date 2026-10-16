import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { apiContext } from '../api/apiContext';
import { getTherapySettings } from '../api/therapyApi';
import {
  ABSORPTION_OPTIONS,
  buildInsulinEvent,
  buildMealEvent,
  buildNoInsulinEvent,
  INSULIN_KINDS,
  INSULIN_TYPES,
  InsulinField,
  InsulinKind,
  InsulinType,
  MEAL_ACTING_TYPES,
  MealField,
  newEventId,
  TimeChoice,
  validateInsulin,
  validateMeal,
  type AbsorptionClass,
} from '../services/events';
import type { EventRecord } from '../services/eventQueue';
import { useEvents } from '../services/EventsProvider';
import { mealChoices, type MealRef } from '../services/mealRefs';
import { PENDING_MESSAGE, savedMessage } from '../services/forecastView';
import { radius, useColors } from '../theme';
import { PrimaryButton, SecondaryButton } from './Buttons';
import { CheckRow, ChoiceChips, EventTimePicker, FormField } from './FormField';

const NOW: TimeChoice = { mode: 'minutesAgo', minutes: 0 };

function ErrorSummary({ errors }: { errors: Record<string, string | undefined> }) {
  const colors = useColors();
  if (!Object.values(errors).some(Boolean)) return null;
  return (
    <Text accessibilityLiveRegion="polite" style={{ fontFamily: 'Manrope_700Bold', fontSize: 14, color: colors.red600 }}>
      Some fields need your attention. Scroll up to fix them, then save again.
    </Text>
  );
}

function Helper({ children }: { children: React.ReactNode }) {
  const colors = useColors();
  return <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, lineHeight: 20 }}>{children}</Text>;
}

/**
 * What happened to the entry the person just submitted, read from the queue record: saved (and
 * whether the forecast was refreshed), still pending (not confirmed - never called saved), a
 * duplicate warning, or a server rejection. The form below stays filled in.
 */
function ResultBanner({
  record,
  onSaveAnyway,
  onDiscardDuplicate,
  onEditAgain,
  onDone,
  onSendNow,
}: {
  record: EventRecord;
  onSaveAnyway: () => void;
  onDiscardDuplicate: () => void;
  onEditAgain: () => void;
  onDone: () => void;
  onSendNow: () => void;
}) {
  const colors = useColors();
  if (record.status === 'saved') {
    return (
      <>
        <View accessibilityLiveRegion="polite" style={{ backgroundColor: colors.green100, borderRadius: radius.hero, padding: 18, gap: 6 }}>
          <Text style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 17, color: colors.greenDark }}>{savedMessage(record.forecastReturned)}</Text>
        </View>
        <PrimaryButton label="Done" onPress={onDone} />
      </>
    );
  }
  if (record.awaitingDuplicateDecision) {
    return (
      <>
        <View accessibilityLiveRegion="polite" style={{ backgroundColor: colors.amber100, borderRadius: radius.hero, padding: 18, gap: 6 }}>
          <Text style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 16, color: colors.amberDark }}>Looks like an entry you already made</Text>
          <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.amberDark, lineHeight: 20 }}>
            {record.reason ?? 'An entry with the same time and amount already exists.'}
          </Text>
        </View>
        <PrimaryButton label="Save anyway" onPress={onSaveAnyway} />
        <SecondaryButton label="Don't save" onPress={onDiscardDuplicate} />
      </>
    );
  }
  if (record.status === 'failed') {
    return (
      <>
        <View accessibilityLiveRegion="polite" style={{ backgroundColor: colors.red100, borderRadius: radius.hero, padding: 18, gap: 6 }}>
          <Text style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 16, color: colors.red600 }}>The server could not accept this entry</Text>
          <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.red600, lineHeight: 20 }}>{record.reason}</Text>
        </View>
        <PrimaryButton label="Edit and try again" onPress={onEditAgain} />
      </>
    );
  }
  return (
    <>
      <View accessibilityLiveRegion="polite" style={{ backgroundColor: colors.amber100, borderRadius: radius.hero, padding: 18, gap: 6 }}>
        <Text style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 16, color: colors.amberDark }}>{PENDING_MESSAGE}</Text>
        <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.amberDark, lineHeight: 20 }}>
          Not sent to the server yet - the forecast does not include it. It is kept on this device and sent when the connection is back.
        </Text>
      </View>
      <SecondaryButton label="Send now" onPress={onSendNow} />
      <PrimaryButton label="Done" onPress={onDone} />
    </>
  );
}

function useRecord(id: string | null): EventRecord | null {
  const { records } = useEvents();
  return useMemo(() => (id ? records.find((r) => r.event.id === id) ?? null : null), [records, id]);
}

// -------------------------------------------------------------------------------------- meal form

export function MealForm({ onDone }: { onDone: () => void }) {
  const colors = useColors();
  const { addEvent, discard, saveAnyway, sendNow } = useEvents();
  const idRef = useRef<string | null>(null);
  const [submittedId, setSubmittedId] = useState<string | null>(null);
  const record = useRecord(submittedId);
  const [carbs, setCarbs] = useState('');
  const [label, setLabel] = useState('');
  const [fat, setFat] = useState('');
  const [protein, setProtein] = useState('');
  const [fiber, setFiber] = useState('');
  const [notes, setNotes] = useState('');
  const [absorption, setAbsorption] = useState<AbsorptionClass | 'unset'>('unset');
  const [approximate, setApproximate] = useState(false);
  const [time, setTime] = useState<TimeChoice>(NOW);
  const [hhmm, setHhmm] = useState('');
  const [errors, setErrors] = useState<Partial<Record<MealField, string>>>({});

  const submit = () => {
    if (submittedId) return; // already submitted: a second tap can never create a second entry
    const result = validateMeal({ carbs, label, fat, protein, fiber, absorption, timeApproximate: approximate, time, notes }, new Date());
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    if (!idRef.current) idRef.current = newEventId();
    setSubmittedId(idRef.current);
    addEvent(buildMealEvent(idRef.current, result.value, { source: 'manual', aiCarbsG: null }));
  };

  const editAgain = () => {
    if (submittedId) discard(submittedId);
    idRef.current = null;
    setSubmittedId(null);
  };

  return (
    <>
      {record ? (
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
        />
      ) : null}
      <FormField label="Carbohydrates" required value={carbs} onChangeText={setCarbs} unit="g" keyboardType="decimal-pad" placeholder="e.g. 45" error={errors.carbs} />
      <FormField label="Meal description (optional)" value={label} onChangeText={setLabel} placeholder="e.g. Pasta" maxLength={80} />
      <EventTimePicker value={time} hhmm={hhmm} onChange={setTime} onChangeHhmm={setHhmm} error={errors.time} />
      <CheckRow checked={approximate} onChange={setApproximate} label="The time is approximate" />
      <View style={{ gap: 8 }}>
        <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink }}>How fast does it hit? (optional)</Text>
        <ChoiceChips options={ABSORPTION_OPTIONS} value={absorption} onChange={setAbsorption} />
      </View>
      <FormField label="Fat (optional)" value={fat} onChangeText={setFat} unit="g" keyboardType="decimal-pad" error={errors.fat} />
      <FormField label="Protein (optional)" value={protein} onChangeText={setProtein} unit="g" keyboardType="decimal-pad" error={errors.protein} />
      <FormField label="Fibre (optional)" value={fiber} onChangeText={setFiber} unit="g" keyboardType="decimal-pad" error={errors.fiber} />
      <FormField label="Notes (optional)" value={notes} onChangeText={setNotes} multiline maxLength={300} error={errors.notes} />
      <ErrorSummary errors={errors} />
      {!record ? <PrimaryButton label="Save carbs" onPress={submit} /> : null}
    </>
  );
}

// ----------------------------------------------------------------------------------- insulin form

function useTherapyInsulinType(): InsulinType | null {
  const [type, setType] = useState<InsulinType | null>(null);
  useEffect(() => {
    let alive = true;
    void getTherapySettings(apiContext).then((r) => {
      if (alive && r.kind === 'ok' && r.value.insulinType) setType(r.value.insulinType);
    });
    return () => {
      alive = false;
    };
  }, []);
  return type;
}

export function InsulinForm({ onDone, preselectMeal, initialKind }: { onDone: () => void; preselectMeal?: MealRef; initialKind?: InsulinKind }) {
  const colors = useColors();
  const { addEvent, discard, saveAnyway, sendNow, records, recent, refreshRecent } = useEvents();
  const idRef = useRef<string | null>(null);
  const [submittedId, setSubmittedId] = useState<string | null>(null);
  const record = useRecord(submittedId);
  const therapyType = useTherapyInsulinType();
  const [openedAtMs] = useState(() => Date.now());
  const [units, setUnits] = useState('');
  const [insulinKind, setInsulinKind] = useState<InsulinKind>(initialKind ?? 'bolus');
  // Pre-selected only from the person's own saved settings; otherwise they must choose.
  const [pickedType, setPickedType] = useState<InsulinType | null>(null);
  const insulinType = pickedType ?? therapyType;
  const [confirmedTaken, setConfirmedTaken] = useState(false);
  const [notSure, setNotSure] = useState(false);
  const [notes, setNotes] = useState('');
  const [glucose, setGlucose] = useState('');
  const [mealKey, setMealKey] = useState<string | null>(preselectMeal?.key ?? null);
  const [time, setTime] = useState<TimeChoice>(NOW);
  const [hhmm, setHhmm] = useState('');
  const [errors, setErrors] = useState<Partial<Record<InsulinField, string>>>({});

  useEffect(() => {
    if (recent.kind === 'idle') refreshRecent();
  }, [recent.kind, refreshRecent]);

  const choices = useMemo(
    () => mealChoices(records, recent.kind === 'ok' ? recent.meals : [], openedAtMs, 6, -new Date(openedAtMs).getTimezoneOffset()),
    [records, recent, openedAtMs],
  );
  const chosenMeal = useMemo(() => choices.find((c) => c.key === mealKey) ?? preselectMeal ?? null, [choices, mealKey, preselectMeal]);
  const mealOptions = useMemo(
    () => [
      { value: '', label: 'No meal / not sure' },
      ...(preselectMeal && !choices.some((c) => c.key === preselectMeal.key) ? [{ value: preselectMeal.key, label: preselectMeal.label }] : []),
      ...choices.map((c) => ({ value: c.key, label: `${c.label} (${new Date(c.occurredAtUtc).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })})` })),
    ],
    [choices, preselectMeal],
  );

  const submit = () => {
    if (submittedId) return;
    const result = validateInsulin(
      { units, insulinKind, insulinType, confirmedTaken, notSure, time, notes, mealId: mealKey, glucose },
      new Date(),
    );
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    if (!idRef.current) idRef.current = newEventId();
    setSubmittedId(idRef.current);
    addEvent(buildInsulinEvent(idRef.current, result.value));
  };

  const editAgain = () => {
    if (submittedId) discard(submittedId);
    idRef.current = null;
    setSubmittedId(null);
  };

  const notMealActing = insulinType !== null && !MEAL_ACTING_TYPES.includes(insulinType);

  return (
    <>
      {record ? (
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
        />
      ) : null}
      <Helper>Record only insulin you actually took. SugarSense does not tell you how much to take.</Helper>
      <View style={{ gap: 8 }}>
        <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink }}>What was it for?</Text>
        <ChoiceChips options={INSULIN_KINDS} value={insulinKind} onChange={setInsulinKind} />
      </View>
      <FormField label="Insulin units" required value={units} onChangeText={setUnits} unit="U" keyboardType="decimal-pad" placeholder="e.g. 4" error={errors.units} />
      <View style={{ gap: 8 }}>
        <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink }}>Insulin type *</Text>
        <ChoiceChips
          options={INSULIN_TYPES}
          value={insulinType ?? ('' as InsulinType)}
          onChange={setPickedType}
        />
        {errors.insulinType ? (
          <Text accessibilityLiveRegion="polite" style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.red600 }}>
            {errors.insulinType}
          </Text>
        ) : null}
        <Helper>Only rapid-acting and ultra-rapid insulin count as meal or correction insulin in the forecast.</Helper>
        {notMealActing ? <Helper>This type is saved and shown, but it is not used as a meal or correction dose.</Helper> : null}
      </View>
      {insulinKind === 'bolus' ? (
        <View style={{ gap: 8 }}>
          <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink }}>For which meal? (optional)</Text>
          <ChoiceChips options={mealOptions} value={chosenMeal?.key ?? ''} onChange={(v) => setMealKey(v === '' ? null : v)} />
          <Helper>Choosing the meal removes guesswork. If you skip it, the server only links a dose to a meal when it is unambiguous.</Helper>
        </View>
      ) : null}
      {insulinKind === 'correction' ? (
        <FormField label="Glucose at the time (optional, stays on this device)" value={glucose} onChangeText={setGlucose} unit="mg/dL" keyboardType="decimal-pad" error={errors.glucose} />
      ) : null}
      <EventTimePicker value={time} hhmm={hhmm} onChange={setTime} onChangeHhmm={setHhmm} error={errors.time} />
      <CheckRow checked={notSure} onChange={setNotSure} label="I'm not sure of the amount or time" />
      <FormField label="Notes (optional, stays on this device)" value={notes} onChangeText={setNotes} multiline maxLength={300} error={errors.notes} />
      <CheckRow checked={confirmedTaken} onChange={setConfirmedTaken} label="I confirm I actually took this insulin" error={errors.confirmedTaken} />
      <ErrorSummary errors={errors} />
      {!record ? <PrimaryButton label="Save insulin record" onPress={submit} /> : null}
    </>
  );
}

// ------------------------------------------------------------------------------ "I took no insulin"

/**
 * The only way to state "no insulin was taken": an explicit, confirmed 0 U meal entry. Anything not
 * logged stays "unknown". Wording from the copy deck.
 */
export function NoInsulinConfirm({ meal, onDone }: { meal: MealRef; onDone: () => void }) {
  const colors = useColors();
  const { addEvent, discard, saveAnyway, sendNow } = useEvents();
  const idRef = useRef<string | null>(null);
  const [submittedId, setSubmittedId] = useState<string | null>(null);
  const record = useRecord(submittedId);

  const confirm = () => {
    if (submittedId) return;
    if (!idRef.current) idRef.current = newEventId();
    setSubmittedId(idRef.current);
    addEvent(buildNoInsulinEvent(idRef.current, { occurredAtUtc: meal.occurredAtUtc, utcOffsetMin: meal.utcOffsetMin, mealId: meal.key }));
  };

  return (
    <>
      {record ? (
        <ResultBanner
          record={record}
          onSaveAnyway={() => saveAnyway(record.event.id)}
          onDiscardDuplicate={() => {
            discard(record.event.id);
            onDone();
          }}
          onEditAgain={() => {
            discard(record.event.id);
            idRef.current = null;
            setSubmittedId(null);
          }}
          onDone={onDone}
          onSendNow={sendNow}
        />
      ) : null}
      <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 16, color: colors.ink }}>I took no insulin for this meal</Text>
      <Helper>{meal.label}</Helper>
      <Helper>
        This tells SugarSense that no rapid insulin was taken for this meal. If you are not sure, leave it unrecorded instead.
      </Helper>
      {!record ? (
        <>
          <PrimaryButton label="Yes, I took none" onPress={confirm} />
          <SecondaryButton label="Leave it unrecorded" onPress={onDone} />
        </>
      ) : null}
    </>
  );
}
