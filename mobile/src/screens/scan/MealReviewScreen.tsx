import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Image, KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MealConfidence } from '../../api/mealsApi';
import { BackButton, PrimaryButton, RoundButton } from '../../components/Buttons';
import { Card } from '../../components/Card';
import { Icon } from '../../components/Icon';
import { InsulinPenProgressBar } from '../../components/InsulinPenProgressBar';
import { LoadingWords } from '../../components/LoadingWords';
import { PixelMascot } from '../../components/PixelMascot';
import { ScanScreenProps } from '../../navigation/types';
import {
  displayTotalCarbsG,
  editItemCarbsG,
  EditableMealAnalysis,
  manualConfirmedMeal,
  MealReviewState,
  runMealAnalysis,
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
  const { photo } = route.params;

  const [state, setState] = useState<MealReviewState>({ kind: 'uploading' });
  const [attempt, setAttempt] = useState(0);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editValue, setEditValue] = useState('');
  const [manualGrams, setManualGrams] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    runMealAnalysis(photo, controller.signal)
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
    setAttempt((n) => n + 1);
  };

  const beginEdit = (index: number, currentGrams: number) => {
    setEditingIndex(index);
    setEditValue(String(currentGrams));
  };

  const commitEdit = () => {
    if (editingIndex === null || state.kind !== 'result') {
      setEditingIndex(null);
      return;
    }
    const parsed = Number(editValue);
    if (Number.isFinite(parsed) && parsed >= 0) {
      setState({ kind: 'result', analysis: editItemCarbsG(state.analysis, editingIndex, parsed) });
    }
    setEditingIndex(null);
  };

  const manualGramsValue = Number(manualGrams);
  const manualGramsValid = manualGrams.trim().length > 0 && Number.isFinite(manualGramsValue) && manualGramsValue > 0;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.ground }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
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
            style={{ height: 220, borderRadius: 22, backgroundColor: colors.divider, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' }}
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
            />
          ) : null}

          {revealed && state.kind === 'no_food_detected' ? <MessagePanel title="No food recognized" body={state.reason} /> : null}

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
              </Card>
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
          onConfirmResult={(analysis) => navigation.navigate('PostMeal', { meal: toConfirmedMeal(analysis) })}
          onConfirmManual={() => navigation.navigate('PostMeal', { meal: manualConfirmedMeal(manualGramsValue) })}
        />
      </KeyboardAvoidingView>
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
}: {
  analysis: EditableMealAnalysis;
  editingIndex: number | null;
  editValue: string;
  onEditValueChange: (value: string) => void;
  onBeginEdit: (index: number, currentGrams: number) => void;
  onCommitEdit: () => void;
}) {
  const colors = useColors();
  const totalG = displayTotalCarbsG(analysis);

  return (
    <>
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
                      autoFocus
                      accessibilityLabel={`Carbs for ${item.name} in grams`}
                      style={{
                        width: 64,
                        fontFamily: 'Manrope_600SemiBold',
                        fontSize: 14,
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

      <Card>
        <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 13, color: colors.ink2, textTransform: 'uppercase', letterSpacing: 0.5 }}>
          Estimated carbohydrates
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
          <Text style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 40, color: colors.ink }}>{round(totalG)}g</Text>
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
        {analysis.analysisNotes ? (
          <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 12.5, color: colors.ink3, marginTop: 8, lineHeight: 18 }}>
            {analysis.analysisNotes}
          </Text>
        ) : null}
      </Card>
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
  onConfirmResult,
  onConfirmManual,
}: {
  state: MealReviewState;
  manualGramsValid: boolean;
  onRetake: () => void;
  onRetry: () => void;
  onConfirmResult: (analysis: EditableMealAnalysis) => void;
  onConfirmManual: () => void;
}) {
  const colors = useColors();
  if (state.kind === 'uploading') return null;

  let content: React.ReactNode;
  if (state.kind === 'result') {
    content = <PrimaryButton label="Confirm" onPress={() => onConfirmResult(state.analysis)} />;
  } else if (state.kind === 'needs_manual_entry') {
    content = <PrimaryButton label="Continue" onPress={onConfirmManual} disabled={!manualGramsValid} />;
  } else if (state.kind === 'error') {
    content = <PrimaryButton label="Retry" onPress={onRetry} />;
  } else {
    // no_food_detected, too_large
    content = <PrimaryButton label="Retake photo" onPress={onRetake} />;
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
