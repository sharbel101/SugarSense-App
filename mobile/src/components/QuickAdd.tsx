import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { goToScan } from '../navigation/navigationRef';
import type { InsulinKind } from '../services/events';
import { useEvents } from '../services/EventsProvider';
import { useForecast } from '../services/ForecastProvider';
import { useKeyboardInset } from '../services/useKeyboardInset';
import { findMealRef, type MealRef } from '../services/mealRefs';
import { forecastPrompts } from '../services/forecastView';
import { radius, shadow, spacing, touch, useColors } from '../theme';
import { EventList } from './EventList';
import { Icon, IconName } from './Icon';
import { InsulinForm, MealForm, NoInsulinConfirm } from './QuickAddForms';

export type QuickAddMode = 'menu' | 'meal' | 'insulin' | 'none' | 'list';
export type QuickAddOptions = { mode?: QuickAddMode; meal?: MealRef; insulinKind?: InsulinKind };

type QuickAddContextValue = {
  /** Open the sheet, optionally straight to a form (used by the forecast banners and the post-meal screen). */
  open: (options?: QuickAddOptions) => void;
};

const QuickAddContext = createContext<QuickAddContextValue | null>(null);

export function useQuickAdd(): QuickAddContextValue {
  const ctx = useContext(QuickAddContext);
  if (!ctx) throw new Error('useQuickAdd must be used inside <QuickAddProvider>');
  return ctx;
}

/** Holds the one sheet for the whole app; the "+" button and every banner open it through `open`. */
export function QuickAddProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<{ open: boolean; options: QuickAddOptions; nonce: number }>({ open: false, options: {}, nonce: 0 });
  const open = useCallback((options: QuickAddOptions = {}) => setState((s) => ({ open: true, options, nonce: s.nonce + 1 })), []);
  const close = useCallback(() => setState((s) => ({ ...s, open: false })), []);
  const value = useMemo(() => ({ open }), [open]);
  return (
    <QuickAddContext.Provider value={value}>
      {children}
      {state.open ? <QuickAddSheet key={state.nonce} options={state.options} onClose={close} /> : null}
    </QuickAddContext.Provider>
  );
}

/** Distance from the screen bottom that clears the floating tab bar (72 dp bar + its padding). One place, not per screen. */
export const TAB_BAR_CLEARANCE = 96;

/** Bottom padding for a tab screen's scroll content so its last card clears the floating tab bar (and the safe area). */
export function useTabScreenBottomPadding(): number {
  const insets = useSafeAreaInsets();
  return insets.bottom + TAB_BAR_CLEARANCE + 24;
}

/** The persistent "+" button. Rendered once at the navigator root so it floats over every main screen. */
export function QuickAddFab({ hidden }: { hidden: boolean }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { open } = useQuickAdd();
  if (hidden) return null;
  return (
    <Pressable
      onPress={() => open()}
      accessibilityRole="button"
      accessibilityLabel="Add carbs or insulin"
      style={({ pressed }) => [
        {
          position: 'absolute',
          right: spacing.xl,
          bottom: insets.bottom + TAB_BAR_CLEARANCE,
          width: 56,
          height: 56,
          borderRadius: 28,
          backgroundColor: colors.blue600,
          alignItems: 'center',
          justifyContent: 'center',
        },
        shadow.fab,
        pressed ? { opacity: 0.9 } : null,
      ]}
    >
      <Icon name="plus" size={26} color={colors.onBlue} />
    </Pressable>
  );
}

function QuickAddSheet({ options, onClose }: { options: QuickAddOptions; onClose: () => void }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { bottomInset, available } = useKeyboardInset();
  const [mode, setMode] = useState<QuickAddMode>(options.mode ?? 'menu');
  const [meal, setMeal] = useState<MealRef | undefined>(options.meal);

  const titles: Record<QuickAddMode, string> = {
    menu: 'Add to your log',
    meal: 'Carbs / food',
    insulin: 'Insulin',
    none: 'No insulin for this meal',
    list: 'Logged today',
  };

  return (
    <Modal transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      {/* paddingBottom lifts the sheet above the keyboard (iOS Safari does not resize the layout viewport). */}
      <View style={{ flex: 1, justifyContent: 'flex-end', paddingBottom: bottomInset }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          onPress={onClose}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.45)' }}
        />
        <View>
          <View
            style={{
              backgroundColor: colors.ground,
              borderTopLeftRadius: radius.hero,
              borderTopRightRadius: radius.hero,
              // A real pixel cap (a percentage of an auto-height parent caps nothing): the sheet can never
              // grow past the top of the screen, and its ScrollView scrolls inside it.
              maxHeight: Math.max(240, Math.floor(available - insets.top - 12)),
              paddingBottom: bottomInset > 0 ? spacing.md : Math.max(insets.bottom, spacing.md),
            }}
          >
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: spacing.xl,
                paddingBottom: spacing.md,
              }}
            >
              <Text accessibilityRole="header" style={{ fontFamily: 'Manrope_800ExtraBold', fontSize: 20, color: colors.ink }}>
                {titles[mode]}
              </Text>
              <Pressable
                onPress={onClose}
                accessibilityRole="button"
                accessibilityLabel="Close"
                style={{ width: touch.min, height: touch.min, alignItems: 'center', justifyContent: 'center' }}
              >
                <Icon name="close" size={20} color={colors.ink2} />
              </Pressable>
            </View>
            {/* key = mode: each step starts at the top (a reused ScrollView kept the previous form's scroll offset). */}
            <ScrollView
              key={mode}
              style={{ flexGrow: 0 }}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ paddingHorizontal: spacing.xl, paddingBottom: spacing.lg, gap: 14 }}
            >
              {mode === 'menu' ? <Menu onPick={setMode} onPickNone={(m) => { setMeal(m); setMode('none'); }} /> : null}
              {mode === 'meal' ? (
                <MealForm
                  onDone={onClose}
                  onBack={() => setMode('menu')}
                  onPhoto={() => {
                    onClose();
                    goToScan();
                  }}
                />
              ) : null}
              {mode === 'insulin' ? <InsulinForm onDone={onClose} onBack={() => setMode('menu')} preselectMeal={meal} initialKind={options.insulinKind} /> : null}
              {mode === 'none' && meal ? <NoInsulinConfirm meal={meal} onDone={onClose} /> : null}
              {mode === 'list' ? <EventList onDone={onClose} /> : null}
            </ScrollView>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function BigChoice({ icon, title, body, onPress }: { icon: IconName; title: string; body: string; onPress: () => void }) {
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${body}`}
      style={({ pressed }) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 14,
          minHeight: 76,
          padding: 16,
          borderRadius: radius.row,
          backgroundColor: colors.surface,
          borderWidth: 1,
          borderColor: colors.border,
        },
        pressed ? { opacity: 0.85 } : null,
      ]}
    >
      <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: colors.blue100, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={icon} size={22} color={colors.blue600} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontFamily: 'Manrope_700Bold', fontSize: 16, color: colors.ink }}>{title}</Text>
        <Text style={{ fontFamily: 'Manrope_500Medium', fontSize: 14, color: colors.ink2, marginTop: 1 }}>{body}</Text>
      </View>
      <Icon name="chevronRight" size={18} color={colors.ink4} />
    </Pressable>
  );
}

function Menu({ onPick, onPickNone }: { onPick: (m: QuickAddMode) => void; onPickNone: (meal: MealRef) => void }) {
  const colors = useColors();
  const { view } = useForecast();
  const { records, recent, refreshRecent } = useEvents();
  useEffect(() => {
    if (recent.kind === 'idle') refreshRecent();
  }, [recent.kind, refreshRecent]);

  // "I took no insulin for [meal]" appears only when the server says a meal is waiting for an insulin record.
  const waitingMeal = useMemo<MealRef | null>(() => {
    if (view.kind !== 'ok' || view.data.mealAware.availability.mealsRangeOnly <= 0) return null;
    const prompt = forecastPrompts(view.data).find((p) => p.kind === 'meal_without_insulin');
    if (!prompt?.eventId) return null;
    return findMealRef(records, recent.kind === 'ok' ? recent.meals : [], prompt.eventId, -new Date().getTimezoneOffset());
  }, [view, records, recent]);

  return (
    <>
      <BigChoice icon="fork" title="Carbs / food" body="Log carbohydrates you ate, without a photo." onPress={() => onPick('meal')} />
      <BigChoice icon="droplet" title="Insulin" body="Record insulin you took." onPress={() => onPick('insulin')} />
      {waitingMeal ? (
        <Pressable
          onPress={() => onPickNone(waitingMeal)}
          accessibilityRole="button"
          accessibilityLabel={`I took no insulin for this meal. ${waitingMeal.label}`}
          style={{ minHeight: touch.min, justifyContent: 'center' }}
        >
          <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.blue600 }}>I took no insulin for [{waitingMeal.label}]</Text>
        </Pressable>
      ) : null}
      <Pressable onPress={() => onPick('list')} accessibilityRole="button" accessibilityLabel="Logged today" style={{ minHeight: touch.min, justifyContent: 'center' }}>
        <Text style={{ fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: colors.blue600 }}>Logged today</Text>
      </Pressable>
    </>
  );
}
