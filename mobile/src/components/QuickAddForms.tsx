import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { goToInsulinSettings } from '../navigation/navigationRef';
import { apiContext } from '../api/apiContext';
import { getTherapySettings } from '../api/therapyApi';
import {
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
import { formatTime12 } from '../services/clock12';
import { useEvents } from '../services/EventsProvider';
import { mealChoices, type MealRef } from '../services/mealRefs';
import { radius, touch, useColors } from '../theme';
import { PrimaryButton, SecondaryButton } from './Buttons';
import { AbsorptionChoice, CheckRow, ChoiceChips, EventTimePicker, FormField } from './FormField';
import { ResultBanner, useRecord } from './EventResult';
import { Icon } from './Icon';
import { DoseConfirmCard } from './DoseConfirmCard';

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

/** Collapsed by default so the one required number is always visible without scrolling. */
function MoreDetails({ children, forceOpen }: { children: React.ReactNode; forceOpen: boolean }) {
  const colors = useColors();
  const [open, setOpen] = useState(false);
  const shown = open || forceOpen;
  return (
    <View style={{ gap: 14 }}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        aria-expanded={shown}
        accessibilityLabel={shown ? 'Hide extra details' : 'Add more details: notes and more'}
        style={{ minHeight: touch.min, justifyContent: 'center' }}
      >
        <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.blue600 }}>
          {shown ? 'Fewer details ▲' : 'More details (notes...) ▼'}
        </Text>
      </Pressable>
      {shown ? children : null}
    </View>
  );
}

function Helper({ children }: { children: React.ReactNode }) {
  const colors = useColors();
  return <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, lineHeight: 20 }}>{children}</Text>;
}


/** A small "use the camera instead" shortcut at the top of the carbs form. */
function PhotoWidget({ onPress }: { onPress: () => void }) {
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Take a photo of the meal instead"
      style={({ pressed }) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          minHeight: 56,
          paddingHorizontal: 14,
          borderRadius: radius.row,
          backgroundColor: colors.blue100,
        },
        pressed ? { opacity: 0.85 } : null,
      ]}
    >
      <Icon name="camera" size={22} color={colors.blue600} />
      <Text style={{ flex: 1, fontFamily: 'Manrope_700Bold', fontSize: 15, color: colors.blue600 }}>Take a photo of the meal instead</Text>
      <Icon name="chevronRight" size={16} color={colors.blue600} />
    </Pressable>
  );
}

// -------------------------------------------------------------------------------------- meal form

export function MealForm({ onDone, onBack, onPhoto }: { onDone: () => void; onBack: () => void; onPhoto: () => void }) {
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
        >
          {record.event.kind === 'meal' ? (
            <DoseConfirmCard
              carbsG={record.event.carbsG}
              mealTimeIso={record.event.occurredAtUtc}
              mealKey={record.serverId ?? record.event.id}
              onDone={onDone}
              hideDone
              onOpenSettings={() => {
                onDone();
                goToInsulinSettings();
              }}
            />
          ) : null}
        </ResultBanner>
      ) : null}
      {!record ? (
        <>
          <PhotoWidget onPress={onPhoto} />
          <FormField label="Carbohydrates" required value={carbs} onChangeText={setCarbs} unit="g" keyboardType="decimal-pad" placeholder="e.g. 45" error={errors.carbs} />
          <EventTimePicker value={time} hhmm={hhmm} onChange={setTime} onChangeHhmm={setHhmm} error={errors.time} />
          <PrimaryButton label="Save carbs" onPress={submit} />
          <ErrorSummary errors={errors} />
          <MoreDetails forceOpen={Boolean(errors.fat || errors.protein || errors.fiber || errors.notes)}>
            <FormField label="Meal description" value={label} onChangeText={setLabel} placeholder="e.g. Pasta" maxLength={80} />
            <CheckRow checked={approximate} onChange={setApproximate} label="The time is approximate" />
            <View style={{ gap: 8 }}>
              <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink }}>How fast does it hit?</Text>
              <AbsorptionChoice value={absorption} onChange={setAbsorption} />
            </View>
            <FormField label="Fat" value={fat} onChangeText={setFat} unit="g" keyboardType="decimal-pad" error={errors.fat} />
            <FormField label="Protein" value={protein} onChangeText={setProtein} unit="g" keyboardType="decimal-pad" error={errors.protein} />
            <FormField label="Fibre" value={fiber} onChangeText={setFiber} unit="g" keyboardType="decimal-pad" error={errors.fiber} />
            <FormField label="Notes" value={notes} onChangeText={setNotes} multiline maxLength={300} error={errors.notes} />
          </MoreDetails>
          <SecondaryButton label="Back" onPress={onBack} />
        </>
      ) : null}
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

export function InsulinForm({ onDone, onBack, preselectMeal, initialKind }: { onDone: () => void; onBack: () => void; preselectMeal?: MealRef; initialKind?: InsulinKind }) {
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
      ...choices.map((c) => ({ value: c.key, label: `${c.label} (${formatTime12(new Date(c.occurredAtUtc))})` })),
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
      {!record ? (
        <>
          <FormField label="Insulin units" required value={units} onChangeText={setUnits} unit="U" keyboardType="decimal-pad" placeholder="e.g. 4" error={errors.units} />
          <View style={{ gap: 8 }}>
            <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink }}>Insulin type *</Text>
            <ChoiceChips options={INSULIN_TYPES} value={insulinType ?? ('' as InsulinType)} onChange={setPickedType} />
            {errors.insulinType ? (
              <Text accessibilityLiveRegion="polite" style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.red600 }}>
                {errors.insulinType}
              </Text>
            ) : null}
            {notMealActing ? <Helper>Saved and shown, but not used as a meal or correction dose.</Helper> : null}
          </View>
          <EventTimePicker value={time} hhmm={hhmm} onChange={setTime} onChangeHhmm={setHhmm} error={errors.time} />
          <CheckRow checked={confirmedTaken} onChange={setConfirmedTaken} label="I confirm I actually took this insulin" error={errors.confirmedTaken} />
          <PrimaryButton label="Save insulin record" onPress={submit} />
          <ErrorSummary errors={errors} />
          <MoreDetails forceOpen={Boolean(errors.notes || errors.glucose)}>
            <View style={{ gap: 8 }}>
              <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink }}>What was it for?</Text>
              <ChoiceChips options={INSULIN_KINDS} value={insulinKind} onChange={setInsulinKind} />
            </View>
            {insulinKind === 'bolus' ? (
              <View style={{ gap: 8 }}>
                <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink }}>For which meal?</Text>
                <ChoiceChips options={mealOptions} value={chosenMeal?.key ?? ''} onChange={(v) => setMealKey(v === '' ? null : v)} />
              </View>
            ) : null}
            {insulinKind === 'correction' ? (
              <FormField label="Glucose at the time (stays on this device)" value={glucose} onChangeText={setGlucose} unit="mg/dL" keyboardType="decimal-pad" error={errors.glucose} />
            ) : null}
            <CheckRow checked={notSure} onChange={setNotSure} label="I'm not sure of the amount or time" />
            <FormField label="Notes (stays on this device)" value={notes} onChangeText={setNotes} multiline maxLength={300} error={errors.notes} />
          </MoreDetails>
          <SecondaryButton label="Back" onPress={onBack} />
        </>
      ) : null}
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
