import { useEffect, useState } from 'react';
import { Keyboard, Platform, useWindowDimensions } from 'react-native';

/**
 * The height a bottom sheet can really use: the window height minus the on-screen keyboard.
 * Without a cap a tall form grows past the top of a small screen (its title and first field end up
 * off-screen and unreachable), and when the keyboard opens the same thing happens again.
 * - iOS: window height minus the keyboard height from the Keyboard events (the sheet is lifted by
 *   KeyboardAvoidingView).
 * - Android: the window itself shrinks when the keyboard opens, so the window height is enough.
 * - Web: the visual viewport height (it shrinks with a phone's soft keyboard).
 */
export function useAvailableHeight(): number {
  const { height: windowHeight } = useWindowDimensions();
  const [keyboard, setKeyboard] = useState(0);
  const [webHeight, setWebHeight] = useState<number | null>(null);

  useEffect(() => {
    if (Platform.OS === 'web') {
      const vv = typeof window !== 'undefined' ? window.visualViewport : null;
      if (!vv) return;
      const update = () => setWebHeight(vv.height);
      update();
      vv.addEventListener('resize', update);
      return () => vv.removeEventListener('resize', update);
    }
    if (Platform.OS !== 'ios') return;
    const show = Keyboard.addListener('keyboardWillShow', (e) => setKeyboard(e.endCoordinates.height));
    const hide = Keyboard.addListener('keyboardWillHide', () => setKeyboard(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  if (Platform.OS === 'web') return webHeight ?? windowHeight;
  return Math.max(200, windowHeight - keyboard);
}
