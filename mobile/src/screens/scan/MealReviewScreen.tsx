import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, ScrollView, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { MealConfidence } from '../../api/mealsApi';
import { BackButton, PrimaryButton, RoundButton, SecondaryButton } from '../../components/Buttons';
import { EventTimePicker, FormField } from '../../components/FormField';
import { Card } from '../../components/Card';
import { Icon } from '../../components/Icon';
import { InsulinPenProgressBar } from '../../components/InsulinPenProgressBar';
import { LoadingWords } from '../../components/LoadingWords';
import { PixelMascot } from '../../components/PixelMascot';
import { ScanScreenProps } from '../../navigation/types';
import { useQuickAdd } from '../../components/QuickAdd';
import { useEvents } from '../../services/EventsProvider';
import { useKeyboardInset } from '../../services/useKeyboardInset';
import {
  buildMealEvent,
  FieldErrors,
  MealField,
  newEventId,
  photoMealSource,
  TimeChoice,
  validateMeal,
} from '../../services/events';
import {
  displayTotalCarbsG,
  editItemCarbsG,
  editTotalCarbsG,
  EditableMealAnalysis,
  manualConfirmedMeal,
  MealReviewState,
  runMealAnalysis,
  mealLabel,
  toConfirmedMeal,
} from '../../services/mealService';
import { DEFAULT_FINISH_MS, useSimulatedProgress } from '../../services/simulatedProgress';
import { ColorPalette, radius, spacing, useColors } from '../../theme';

// Text-weight colours only (never the `*600` icon-only shade at normal size - see
// scripts/check-contrast.mjs: `amber600` on `amber100` clears the 3:1 icon minimum but not 4.5:1
// text minimum in light mode; `amberDark` is the token already verified safe for text).
function confidenceTone(colors: ColorPalette, level: MealConfidence) {
  if (level === 'high') return { bg: colors.green100, color: colors.green600, label: 'High confidence' };
  if (level === 'medium') return { bg: colors.amber100, color: colors.amberDark, label: 'Medium confidence' };
  return { bg: colors.red100, color: colors.red600, label: 'Low confidence' };
}

const round = (value: number) => Math.round(value);

export function MealReviewScreen({ navigation, route }: ScanScreenProps<'MealReview'>) {
  const colors = useColors();
  const { height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { bottomInset } = useKeyboardInset();
  // Lift the pinned Confirm / Cancel footer above the keyboard (the SafeAreaView already pads the home indicator).
  const keyboardPad = Math.max(0, bottomInset - insets.bottom);
  // The photo is context, the carbs number is the point: shrink it on short screens so the number stays above the footer.
  const photoHeight = windowHeight < 700 ? 88 : 150;
  const { photo } = route.params;

  const [state, setState] = useState<MealReviewState>({ kind: 'uploading' });
  // One id per review screen, reused on every confirm attempt, plus a latch against double taps:
  // together they make a repeated confirm unable to create a second meal event.
  const eventIdRef = useRef<string | null>(null);
  const confirmedRef = useRef(false);
  const [attempt, setAttempt] = useState(0);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingTotal, setEditingTotal] = useState(false);
  const [totalValue, setTotalValue] = useState('');
  const [editValue, setEditValue] = useState('');
  const [manualGrams, setManualGrams] = useState('');
  const { addEvent, adoptSavedMeal, editMeal } = useEvents();
  const [confirmMessage, setConfirmMessage] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // Meal name the user can correct; null = still the name derived from the detected foods.
  const [mealName, setMealName] = useState<string | null>(null);
  const [eatenAt, setEatenAt] = useState<TimeChoice>({ mode: 'minutesAgo', minutes: 0 });
  const [eatenHhmm, setEatenHhmm] = useState('');
  const [confirmErrors, setConfirmErrors] = useState<FieldErrors<MealField>>({});

  useEffect(() => {
    const controller = new AbortController();
    if (!eventIdRef.current) eventIdRef.current = newEventId();
    // The same id is the analysis request's clientId and the meal event's id: a retry maps to one meal.
    runMealAnalysis(photo, controller.signal, { clientId: eventIdRef.current })
      .then(setState)
      .catch((error) => {
        if (error instanceof Error && error.name === 'AbortError') return;
        setState({ kind: 'error', message: 'Something went wrong. Please try again.' });
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photo.uri, attempt]);

  // The real result can already be in `state` before the progress bar has visually finished its
  // run to 100% - `revealed` holds the actual result/error content back for one short beat so that
  // finish plays out instead of being cut off mid-tween (see InsulinPenProgressBar / DEFAULT_FINISH_MS).
  // This never delays the real analysis itself, only how soon its already-known outcome is shown.
  const isUploading = state.kind === 'uploading';
  const [revealed, setRevealed] = useState(true);
  // Flip `revealed` synchronously, during render, on the transition itself (not as a setState call
  // inside the effect below - react-hooks/set-state-in-effect wants that reserved for the effect's
  // callback, i.e. the setTimeout below, not its immediate body). See the same pattern in
  // useSimulatedProgress.
  const [wasUploading, setWasUploading] = useState(isUploading);
  if (isUploading !== wasUploading) {
    setWasUploading(isUploading);
    setRevealed(isUploading);
  }
  useEffect(() => {
    if (isUploading) return;
    const timer = setTimeout(() => setRevealed(true), DEFAULT_FINISH_MS);
    return () => clearTimeout(timer);
  }, [isUploading]);
  const progress = useSimulatedProgress(isUploading);
  const showLoading = isUploading || !revealed;

  // Sets the visible "uploading" state and clears any in-progress edit synchronously (an event
  // handler, not the effect above), then bumps `attempt` to re-run the effect for a new request.
  const retry = () => {
    setState({ kind: 'uploading' });
    setEditingIndex(null);
    setMealName(null);
    setAttempt((n) => n + 1);
  };

  const beginEdit = (index: number, currentGrams: number) => {
    setEditingIndex(index);
    setEditValue(String(currentGrams));
  };

  const beginEditTotal = (current: number) => {
    setEditingIndex(null);
    setTotalValue(String(Math.round(current * 10) / 10));
    setEditingTotal(true);
  };

  const commitEditTotal = () => {
    if (!editingTotal || state.kind !== 'result') {
      setEditingTotal(false);
      return;
    }
    const parsed = Number(totalValue.replace(',', '.'));
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 400) {
      setState({ kind: 'result', analysis: editTotalCarbsG(state.analysis, parsed) });
      setConfirmMessage(null);
    } else {
      setConfirmMessage('Total carbs must be a number above 0, up to 400 g. Your change was not applied.');
    }
    setEditingTotal(false);
  };

  const commitEdit = () => {
    if (editingIndex === null || state.kind !== 'result') {
      setEditingIndex(null);
      return;
    }
    const parsed = Number(editValue);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 400) {
      setState({ kind: 'result', analysis: editItemCarbsG(state.analysis, editingIndex, parsed) });
      setConfirmMessage(null);
    } else {
      // Never keep a number the server would reject (max 400 g) or one that is not a number.
      setConfirmMessage('Carbs for one item must be a number from 0 to 400 g. Your change was not applied.');
    }
    setEditingIndex(null);
  };

  const manualGramsValue = Number(manualGrams);
  const manualGramsValid = manualGrams.trim().length > 0 && Number.isFinite(manualGramsValue) && manualGramsValue > 0;

  // Confirm = the only path that records the meal and goes on to the forecast screen. Cancel (back or
  // the Cancel button) records nothing. The server already stored the analysed meal (`mealEventId`);
  // confirming PATCHes it (the corrected carbs only when the person changed something) and the server
  // returns the refreshed forecast. With no `mealEventId`, the meal is queued through the same
  // POST /events/meals pathway as a manual entry, with the same client id.
  const confirm = async (analysis: EditableMealAnalysis | null, serverMealId: string | null) => {
    if (confirmedRef.current) return;
    const carbsG = analysis ? displayTotalCarbsG(analysis) : manualGramsValue;
    const defaultName = analysis ? mealLabel(analysis.items.map((i) => i.name)) : 'Meal (entered manually)';
    const result = validateMeal(
      {
        carbs: String(Math.round(carbsG * 10) / 10),
        label: mealName ?? defaultName,
        fat: analysis?.totalFatG != null ? String(analysis.totalFatG) : '',
        protein: analysis?.totalProteinG != null ? String(analysis.totalProteinG) : '',
        fiber: analysis?.totalFiberG != null ? String(analysis.totalFiberG) : '',
        absorption: 'unset',
        timeApproximate: false,
        time: eatenAt,
        notes: '',
      },
      new Date(),
    );
    if (!result.ok) {
      setConfirmErrors(result.errors);
      return;
    }
    confirmedRef.current = true;
    setConfirming(true);
    setConfirmMessage(null);
    if (!eventIdRef.current) eventIdRef.current = newEventId();
    const event = buildMealEvent(eventIdRef.current, result.value, {
      source: analysis ? photoMealSource(analysis.edited) : 'manual',
      aiCarbsG: analysis ? analysis.totalNetCarbsG : null,
    });
    const meal = analysis ? toConfirmedMeal(analysis) : manualConfirmedMeal(carbsG);
    const timeChanged = eatenAt.mode === 'clock' || eatenAt.minutes > 0;
    const go = (key: string, pending: boolean) =>
      navigation.navigate('PostMeal', {
        meal: { ...meal, label: result.value.label },
        mealRef: {
          key,
          label: `Meal, ${Math.round(result.value.carbsG)} g carbs`,
          occurredAtUtc: result.value.occurredAtUtc,
          utcOffsetMin: result.value.utcOffsetMin,
          carbsG: result.value.carbsG,
          pending,
        },
        forecastNote: analysis?.forecastNote ?? (state.kind === 'needs_manual_entry' ? state.forecastNote ?? null : null),
      });

    if (serverMealId) {
      adoptSavedMeal(event, serverMealId);
      const out = await editMeal(serverMealId, {
        status: 'confirmed',
        ...(analysis === null || analysis.edited ? { carbsG: result.value.carbsG } : null),
        ...(timeChanged ? { eatenAt: result.value.occurredAtUtc } : null),
      });
      setConfirming(false);
      if (out.result === 'updated' || out.result === 'unchanged' || out.result === 'exists') {
        go(serverMealId, false);
        return;
      }
      // Not confirmed: stay here so nothing is lost, and say why.
      confirmedRef.current = false;
      setConfirmMessage(
        out.result === 'invalid' || out.result === 'conflict'
          ? out.reason ?? 'The server could not confirm this meal.'
          : 'Could not reach the server. Nothing was confirmed - try again.',
      );
      return;
    }
    addEvent(event);
    setConfirming(false);
    go(eventIdRef.current, true);
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.ground }}>
      <View style={{ flex: 1, paddingBottom: keyboardPad }}>
        <View style={{ paddingHorizontal: spacing.xl, paddingTop: spacing.md, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <BackButton onPress={() => navigation.goBack()} accessibilityLabel="Back to camera" />
          <Text accessibilityRole="header" style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 20, color: colors.ink }}>
            Meal review
          </Text>
        </View>

        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: spacing.xl, paddingTop: spacing.md, paddingBottom: spacing.lg, gap: 16 }}
        >
          <View
            accessible
            accessibilityRole="image"
            accessibilityLabel="Photo of your meal"
            style={{ height: photoHeight, borderRadius: 22, backgroundColor: colors.divider, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' }}
          >
            {/* The photo stays visible and untouched while analyzing - just a small loading badge
                in the corner, not a scrim covering it. */}
            <Image source={{ uri: photo.uri }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
            {showLoading ? (
              <View
                style={{
                  position: 'absolute',
                  right: 12,
                  bottom: 12,
                  width: 36,
                  height: 36,
                  borderRadius: 18,
                  backgroundColor: 'rgba(22,33,61,0.55)',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <ActivityIndicator color="#FFFFFF" size="small" />
              </View>
            ) : null}
          </View>

          {showLoading ? (
            <View style={{ alignItems: 'center', paddingVertical: 20, gap: 10 }}>
              <PixelMascot />
              <LoadingWords style={{ fontSize: 16 }} />
              <View style={{ width: '100%', paddingHorizontal: spacing.md, marginTop: 4 }}>
                <InsulinPenProgressBar percent={progress} />
              </View>
            </View>
          ) : null}

          {revealed && state.kind === 'result' ? (
            <ResultContent
              analysis={state.analysis}
              editingIndex={editingIndex}
              editValue={editValue}
              onEditValueChange={setEditValue}
              onBeginEdit={beginEdit}
              onCommitEdit={commitEdit}
              editingTotal={editingTotal}
              totalValue={totalValue}
              onTotalValueChange={setTotalValue}
              onBeginEditTotal={beginEditTotal}
              onCommitEditTotal={commitEditTotal}
              mealName={mealName ?? mealLabel(state.analysis.items.map((i) => i.name))}
              onMealNameChange={setMealName}
              eatenAt={eatenAt}
              eatenHhmm={eatenHhmm}
              onEatenAtChange={setEatenAt}
              onEatenHhmmChange={setEatenHhmm}
              errors={confirmErrors}
            />
          ) : null}

          {revealed && state.kind === 'no_food_detected' ? <MessagePanel title="No food recognized" body={state.forecastNote ? `${state.reason} ${state.forecastNote}` : state.reason} /> : null}

          {revealed && state.kind === 'needs_manual_entry' ? (
            <>
              <MessagePanel title="Couldn't estimate carbs" body={state.reason} />
              <Card>
                <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 13, color: colors.ink2, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  Estimated carbohydrates (manual entry)
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 }}>
                  <TextInput
                    value={manualGrams}
                    onChangeText={setManualGrams}
                    keyboardType="decimal-pad"
                    placeholder="Enter grams"
                    placeholderTextColor={colors.ink3}
                    accessibilityLabel="Carbohydrates in grams"
                    style={{
                      flex: 1,
                      fontFamily: 'Manrope_700Bold',
                      fontSize: 22,
                      color: colors.ink,
                      borderWidth: 1,
                      borderColor: colors.border,
                      borderRadius: radius.chip,
                      paddingHorizontal: 14,
                      paddingVertical: 10,
                    }}
                  />
                  <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 16, color: colors.ink2 }}>g</Text>
                </View>
                {confirmErrors.carbs ? (
                  <Text accessibilityLiveRegion="polite" style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.red600, marginTop: 6 }}>
                    {confirmErrors.carbs}
                  </Text>
                ) : null}
              </Card>
              <EventTimePicker value={eatenAt} hhmm={eatenHhmm} onChange={setEatenAt} onChangeHhmm={setEatenHhmm} error={confirmErrors.time} />
            </>
          ) : null}

          {revealed && state.kind === 'too_large' ? (
            <MessagePanel
              title="Photo too large"
              body={`This photo is about ${((state.base64Chars * 0.75) / (1024 * 1024)).toFixed(1)} MB, too large to upload. Please retake it.`}
            />
          ) : null}

          {revealed && state.kind === 'error' ? <MessagePanel title="Couldn't analyze this photo" body={state.message} /> : null}
        </ScrollView>

        <Footer
          state={showLoading ? { kind: 'uploading' } : state}
          manualGramsValid={manualGramsValid}
          onRetake={() => navigation.goBack()}
          onRetry={retry}
          onCancel={() => navigation.goBack()}
          confirming={confirming}
          message={confirmMessage}
          onConfirmResult={(analysis) => void confirm(analysis, analysis.mealEventId ?? null)}
          onConfirmManual={() => void confirm(null, state.kind === 'needs_manual_entry' ? state.mealEventId : null)}
        />
      </View>
    </SafeAreaView>
  );
}

function ResultContent({
  analysis,
  editingIndex,
  editValue,
  onEditValueChange,
  onBeginEdit,
  onCommitEdit,
  editingTotal,
  totalValue,
  onTotalValueChange,
  onBeginEditTotal,
  onCommitEditTotal,
  mealName,
  onMealNameChange,
  eatenAt,
  eatenHhmm,
  onEatenAtChange,
  onEatenHhmmChange,
  errors,
}: {
  analysis: EditableMealAnalysis;
  editingIndex: number | null;
  editValue: string;
  onEditValueChange: (value: string) => void;
  onBeginEdit: (index: number, currentGrams: number) => void;
  onCommitEdit: () => void;
  editingTotal: boolean;
  totalValue: string;
  onTotalValueChange: (value: string) => void;
  onBeginEditTotal: (currentGrams: number) => void;
  onCommitEditTotal: () => void;
  mealName: string;
  onMealNameChange: (name: string) => void;
  eatenAt: TimeChoice;
  eatenHhmm: string;
  onEatenAtChange: (choice: TimeChoice) => void;
  onEatenHhmmChange: (text: string) => void;
  errors: FieldErrors<MealField>;
}) {
  const colors = useColors();
  const totalG = displayTotalCarbsG(analysis);

  const macros = [
    analysis.totalFatG != null ? `Fat ${round(analysis.totalFatG)} g` : null,
    analysis.totalProteinG != null ? `Protein ${round(analysis.totalProteinG)} g` : null,
    analysis.totalFiberG != null ? `Fibre ${round(analysis.totalFiberG)} g` : null,
    `~${round(analysis.totalCaloriesKcal)} kcal`,
  ].filter((m): m is string => m !== null);

  return (
    <>
      <FormField label="Meal name" value={mealName} onChangeText={onMealNameChange} maxLength={80} />
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 13, color: colors.ink2, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Estimated carbohydrates
          </Text>
          <RoundButton accessibilityLabel="Edit total carbohydrates" size={40} bg="transparent" edge="end" onPress={() => onBeginEditTotal(totalG)}>
            <Icon name="edit" size={16} color={colors.ink3} />
          </RoundButton>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
          {editingTotal ? (
            <TextInput
              value={totalValue}
              onChangeText={onTotalValueChange}
              onSubmitEditing={onCommitEditTotal}
              onBlur={onCommitEditTotal}
              keyboardType="decimal-pad"
              selectTextOnFocus
              autoFocus
              accessibilityLabel="Total carbohydrates in grams"
              style={{
                width: 120,
                fontFamily: 'Manrope_800ExtraBold',
                fontSize: 32,
                color: colors.ink,
                borderWidth: 1,
                borderColor: colors.blue600,
                borderRadius: radius.chip,
                paddingHorizontal: 10,
                paddingVertical: 4,
              }}
            />
          ) : (
            <Text style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 40, color: colors.ink }}>{round(totalG)}g</Text>
          )}
          <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2 }}>
            carbs{' '}
            {analysis.edited
              ? '(edited)'
              : `(est. ${round(analysis.totalCarbsRangeLowG)}–${round(analysis.totalCarbsRangeHighG)}g)`}
          </Text>
        </View>
        {analysis.estimatedGlycemicIndex !== null ? (
          // SAFETY: display-only. Deliberately smaller and muted vs the carbs number above, and
          // never read anywhere near the bolus calculator (root CLAUDE.md section 2) - GI can never
          // be "high" confidence from a single photo (backend schema excludes it structurally).
          <View style={{ marginTop: 10 }}>
            <View
              style={{
                alignSelf: 'flex-start',
                backgroundColor: colors.divider,
                borderRadius: radius.pill,
                paddingHorizontal: 9,
                paddingVertical: 3,
              }}
            >
              <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 11, color: colors.ink3 }}>
                GI ~{round(analysis.estimatedGlycemicIndex)} (rough estimate
                {analysis.glycemicIndexConfidence ? `, ${analysis.glycemicIndexConfidence} confidence` : ''})
              </Text>
            </View>
          </View>
        ) : null}
        <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.ink2, marginTop: 10 }}>
          {macros.join(' · ')} · {analysis.edited ? 'carbs corrected by you' : 'AI estimate - check before confirming'}
        </Text>
        {analysis.analysisNotes ? (
          <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 12.5, color: colors.ink3, marginTop: 8, lineHeight: 18 }}>
            {analysis.analysisNotes}
          </Text>
        ) : null}
      </Card>
      <View>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 15, color: colors.ink }}>SugarSense detected</Text>
          <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 12.5, color: colors.ink3 }}>
            {analysis.items.length} item{analysis.items.length === 1 ? '' : 's'} · ~{round(analysis.totalCaloriesKcal)} kcal
          </Text>
        </View>
        <View style={{ backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.row }}>
          {analysis.items.map((item, index) => {
            const tone = confidenceTone(colors, item.confidence);
            return (
              <View
                key={`${item.name}-${index}`}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  paddingHorizontal: 16,
                  paddingVertical: 12,
                  borderBottomWidth: index === analysis.items.length - 1 ? 0 : 1,
                  borderBottomColor: colors.divider,
                }}
              >
                <View style={{ flex: 1, paddingRight: 10 }}>
                  <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 15, color: colors.ink }}>
                    {item.name}
                    {item.edited ? ' · edited' : ''}
                  </Text>
                  <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 12.5, color: colors.ink3, marginTop: 1 }}>
                    {item.portionDescription} · ~{round(item.estimatedGrams)}g
                  </Text>
                  <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 12, color: tone.color, marginTop: 2 }}>
                    {tone.label}
                  </Text>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  {editingIndex === index ? (
                    <TextInput
                      value={editValue}
                      onChangeText={onEditValueChange}
                      onSubmitEditing={onCommitEdit}
                      onBlur={onCommitEdit}
                      keyboardType="decimal-pad"
                      selectTextOnFocus
                      autoFocus
                      accessibilityLabel={`Carbs for ${item.name} in grams`}
                      style={{
                        width: 64,
                        fontFamily: 'Manrope_600SemiBold',
                        fontSize: 16,
                        color: colors.ink,
                        borderWidth: 1,
                        borderColor: colors.blue600,
                        borderRadius: radius.chip,
                        paddingHorizontal: 8,
                        paddingVertical: 6,
                        textAlign: 'right',
                      }}
                    />
                  ) : (
                    <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2 }}>{round(item.netCarbsG)}g</Text>
                  )}
                  <RoundButton
                    accessibilityLabel={`Edit ${item.name}`}
                    size={26}
                    bg="transparent"
                    edge="end"
                    onPress={() => onBeginEdit(index, item.netCarbsG)}
                  >
                    <Icon name="edit" size={14} color={colors.ink3} />
                  </RoundButton>
                </View>
              </View>
            );
          })}
        </View>
      </View>

      <EventTimePicker value={eatenAt} hhmm={eatenHhmm} onChange={onEatenAtChange} onChangeHhmm={onEatenHhmmChange} error={errors.time ?? errors.carbs} />
    </>
  );
}

// One consistent "something needs your attention" tone for all four non-result states (no food
// detected, needs manual entry, photo too large, request failed) - matching how SafetyScreen
// already treats its own "attention" state, rather than introducing a separate, more alarming red
// for what are all just camera/upload/estimation hiccups, not glucose-safety alerts.
function MessagePanel({ title, body }: { title: string; body: string }) {
  const colors = useColors();
  return (
    <View style={{ backgroundColor: colors.amber100, borderRadius: radius.hero, padding: 20, gap: 8 }}>
      <Icon name="alertTriangle" size={22} color={colors.amber600} />
      <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 16, color: colors.amberDark }}>{title}</Text>
      <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.amberDark, lineHeight: 20 }}>{body}</Text>
    </View>
  );
}

function Footer({
  state,
  manualGramsValid,
  onRetake,
  onRetry,
  onCancel,
  confirming,
  message,
  onConfirmResult,
  onConfirmManual,
}: {
  state: MealReviewState;
  manualGramsValid: boolean;
  onRetake: () => void;
  onRetry: () => void;
  onCancel: () => void;
  confirming: boolean;
  message: string | null;
  onConfirmResult: (analysis: EditableMealAnalysis) => void;
  onConfirmManual: () => void;
}) {
  const colors = useColors();
  const { open } = useQuickAdd();
  if (state.kind === 'uploading') return null;

  let content: React.ReactNode;
  if (state.kind === 'result') {
    content = (
      <View style={{ gap: 10 }}>
        {message ? <Text accessibilityLiveRegion="polite" style={{ fontFamily: 'Manrope_700Bold', fontSize: 14, color: colors.red600 }}>{message}</Text> : null}
        <PrimaryButton label="Confirm carbs" onPress={() => onConfirmResult(state.analysis)} loading={confirming} />
        <SecondaryButton label="Cancel" onPress={onCancel} />
      </View>
    );
  } else if (state.kind === 'needs_manual_entry') {
    content = (
      <View style={{ gap: 10 }}>
        {message ? <Text accessibilityLiveRegion="polite" style={{ fontFamily: 'Manrope_700Bold', fontSize: 14, color: colors.red600 }}>{message}</Text> : null}
        <PrimaryButton label="Confirm carbs" onPress={onConfirmManual} disabled={!manualGramsValid} loading={confirming} />
        <SecondaryButton label="Cancel" onPress={onCancel} />
      </View>
    );
  } else if (state.kind === 'error') {
    content = <PrimaryButton label="Retry" onPress={onRetry} />;
  } else {
    // no_food_detected, too_large: retake, or enter the carbs by hand (the same form as the + button)
    content = (
      <View style={{ gap: 10 }}>
        <PrimaryButton label="Retake photo" onPress={onRetake} />
        <SecondaryButton label="Enter carbs manually" onPress={() => open({ mode: 'meal' })} />
      </View>
    );
  }

  return (
    <View
      style={{
        paddingHorizontal: spacing.xl,
        paddingTop: spacing.md,
        paddingBottom: spacing.md,
        borderTopWidth: 1,
        borderTopColor: colors.divider,
        backgroundColor: colors.ground,
      }}
    >
      {content}
    </View>
  );
}
