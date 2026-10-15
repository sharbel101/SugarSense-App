import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/**
 * Shared by every purely-decorative loop (PixelMascot's idle poses, the insulin-pen flame
 * flicker) - not by motion that itself carries required state, like a progress bar's fill
 * advancing, which keeps running regardless (see InsulinPenProgressBar).
 */
export function useReducedMotionPreference(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (mounted) setReduced(value);
    });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);
  return reduced;
}
