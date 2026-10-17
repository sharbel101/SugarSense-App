import { useEffect, useState } from 'react';
import { Keyboard, Platform, useWindowDimensions } from 'react-native';
import { webKeyboardInset } from './keyboardInset';

/**
 * `bottomInset`: pixels to lift bottom-pinned UI so it sits above the keyboard.
 * `available`: the height left for that UI (visible area above the keyboard).
 * - iOS native: from the Keyboard events.
 * - Web (iOS Safari especially): from the visual viewport (see keyboardInset.ts).
 * - Android: the window itself resizes with the keyboard, so no inset is needed.
 */
export function useKeyboardInset(): { bottomInset: number; available: number } {
  const { height: windowHeight } = useWindowDimensions();
  const [nativeKeyboard, setNativeKeyboard] = useState(0);
  const [web, setWeb] = useState<{ inset: number; height: number } | null>(null);

  useEffect(() => {
    if (Platform.OS === 'web') {
      const vv = typeof window !== 'undefined' ? window.visualViewport : null;
      if (!vv) return;
      const update = () =>
        setWeb({ inset: webKeyboardInset(window.innerHeight, vv.height, vv.offsetTop), height: vv.height });
      update();
      vv.addEventListener('resize', update);
      vv.addEventListener('scroll', update);
      return () => {
        vv.removeEventListener('resize', update);
        vv.removeEventListener('scroll', update);
      };
    }
    if (Platform.OS !== 'ios') return;
    const frame = Keyboard.addListener('keyboardWillChangeFrame', (e) => setNativeKeyboard(e.endCoordinates.height));
    const show = Keyboard.addListener('keyboardWillShow', (e) => setNativeKeyboard(e.endCoordinates.height));
    const hide = Keyboard.addListener('keyboardWillHide', () => setNativeKeyboard(0));
    return () => {
      frame.remove();
      show.remove();
      hide.remove();
    };
  }, []);

  if (Platform.OS === 'web') {
    const inset = web?.inset ?? 0;
    return { bottomInset: inset, available: Math.max(200, (web?.height ?? windowHeight)) };
  }
  if (Platform.OS === 'ios') return { bottomInset: nativeKeyboard, available: Math.max(200, windowHeight - nativeKeyboard) };
  return { bottomInset: 0, available: windowHeight };
}
