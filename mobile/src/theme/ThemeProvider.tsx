import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Appearance, Platform, useColorScheme } from 'react-native';
import { ColorPalette, darkColors, lightColors } from './tokens';

export type Scheme = 'light' | 'dark';

/** What the user picked: follow the device, or force one scheme. */
export type ThemePreference = 'system' | Scheme;

export type Theme = {
  /** The scheme actually in effect. */
  scheme: Scheme;
  isDark: boolean;
  colors: ColorPalette;
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
};

const STORAGE_KEY = 'sugarsense.theme-preference';

const isPreference = (value: unknown): value is ThemePreference =>
  value === 'system' || value === 'light' || value === 'dark';

// Used by `useTheme` when there is no provider (e.g. an isolated render): follow the system, no override.
const FALLBACK: Record<Scheme, Theme> = {
  light: { scheme: 'light', isDark: false, colors: lightColors, preference: 'system', setPreference: () => {} },
  dark: { scheme: 'dark', isDark: true, colors: darkColors, preference: 'system', setPreference: () => {} },
};

const ThemeContext = createContext<Theme | null>(null);

/**
 * Supplies the active palette. Follows the system appearance unless the user picked Light or Dark
 * (Profile & settings > Appearance); that choice is remembered on the device. Pass `scheme` to pin
 * one regardless (tests).
 */
export function ThemeProvider({ children, scheme: pinned }: { children: React.ReactNode; scheme?: Scheme }) {
  const system = useColorScheme();
  const [preference, setPreferenceState] = useState<ThemePreference>('system');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(STORAGE_KEY)
      .then((saved) => {
        if (!cancelled && isPreference(saved)) setPreferenceState(saved);
      })
      .catch(() => {
        // Storage unavailable: keep following the system.
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Native: also flip system UI (keyboard, alerts, status bar 'auto'). react-native-web has no
  // Appearance.setColorScheme, and it doesn't need one because the palette below is ours.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    Appearance.setColorScheme(preference === 'system' ? 'unspecified' : preference);
  }, [preference]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    AsyncStorage.setItem(STORAGE_KEY, next).catch(() => {
      // Best effort: the choice still applies for this session.
    });
  }, []);

  const scheme: Scheme = pinned ?? (preference === 'system' ? (system === 'dark' ? 'dark' : 'light') : preference);

  const value = useMemo<Theme>(
    () => ({ scheme, isDark: scheme === 'dark', colors: scheme === 'dark' ? darkColors : lightColors, preference, setPreference }),
    [scheme, preference, setPreference],
  );

  // Wait for the saved choice so the first frame is never the wrong theme.
  if (!loaded) return null;

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  const provided = useContext(ThemeContext);
  const system = useColorScheme();
  return provided ?? FALLBACK[system === 'dark' ? 'dark' : 'light'];
}

/** The active palette. Call it inside the component - never read a palette at module scope. */
export function useColors(): ColorPalette {
  return useTheme().colors;
}
