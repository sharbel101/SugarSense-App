import { Toaster } from 'sileo';
import 'sileo/styles.css';
import React from 'react';
import { useTheme } from '../theme';

/**
 * Mounts Sileo once. Toasts appear at the top centre, below the iPhone status bar / Dynamic Island, follow the
 * app's light or dark theme, and shrink to fit a narrow phone.
 */
export function ToasterHost() {
  const { isDark } = useTheme();
  return (
    <>
      <style>{`:root { --sileo-width: min(350px, calc(100vw - 3rem)); } [data-sileo-viewport] { z-index: 2147483000; } [data-sileo-title] { text-transform: none !important; }`}</style>
      <Toaster position="top-center" theme={isDark ? 'dark' : 'light'} offset={{ top: 'calc(env(safe-area-inset-top, 0px) + 8px)' }} />
    </>
  );
}
