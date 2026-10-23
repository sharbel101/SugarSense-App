import {
  Manrope_400Regular,
  Manrope_500Medium,
  Manrope_600SemiBold,
  Manrope_700Bold,
  Manrope_800ExtraBold,
  useFonts,
} from '@expo-google-fonts/manrope';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { RootNavigator } from './src/navigation/RootNavigator';
import { QuickAddProvider } from './src/components/QuickAdd';
import { EventsProvider } from './src/services/EventsProvider';
import { ForecastProvider } from './src/services/ForecastProvider';
import { GlucoseProvider } from './src/services/GlucoseProvider';
import { InsightsProvider } from './src/services/InsightsProvider';
import { WearableProvider } from './src/services/WearableProvider';
import { ToasterHost } from './src/components/ToasterHost';
import { LastKnownSync } from './src/services/LastKnownSync';
import { ToastSync } from './src/services/ToastSync';
import { MissedMealProvider } from './src/services/MissedMealProvider';
import { RiskAlertsProvider } from './src/services/RiskAlertsProvider';
import { startWebUpdateWatcher } from './src/services/webUpdate';
import { ThemeProvider, useTheme } from './src/theme';

/** Follows the theme in effect (including the user's override), not just the device setting. */
function ThemedStatusBar() {
  const { isDark } = useTheme();
  return <StatusBar style={isDark ? 'light' : 'dark'} />;
}

export default function App() {
  const [fontsLoaded] = useFonts({
    Manrope_400Regular,
    Manrope_500Medium,
    Manrope_600SemiBold,
    Manrope_700Bold,
    Manrope_800ExtraBold,
  });

  // On a slow connection the five font files can take a long time; a blank screen is worse than a
  // brief fallback font, so show the app after a few seconds and let the fonts swap in when ready.
  const [fontWaitOver, setFontWaitOver] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setFontWaitOver(true), 2500);
    return () => clearTimeout(t);
  }, []);

  // Web only (a no-op elsewhere): a home-screen web app never reloads on its own, so it asks.
  useEffect(() => startWebUpdateWatcher(), []);

  if (!fontsLoaded && !fontWaitOver) {
    return null;
  }

  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <ThemedStatusBar />
        <ToasterHost />
        <GlucoseProvider>
          <ForecastProvider>
            <RiskAlertsProvider>
              <LastKnownSync />
              <ToastSync />
              <EventsProvider>
                <InsightsProvider>
                  <WearableProvider>
                    <MissedMealProvider>
                      <QuickAddProvider>
                        <RootNavigator />
                      </QuickAddProvider>
                    </MissedMealProvider>
                  </WearableProvider>
                </InsightsProvider>
              </EventsProvider>
            </RiskAlertsProvider>
          </ForecastProvider>
        </GlucoseProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
