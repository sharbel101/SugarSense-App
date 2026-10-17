/**
 * How far the on-screen keyboard covers the bottom of the LAYOUT viewport. Pure.
 *
 * iOS Safari (the web build) does not resize the layout viewport when the keyboard opens - it only
 * shrinks the VISUAL viewport - so anything pinned to the bottom (our add sheet, the meal-review
 * footer) ends up underneath the keyboard. The covered strip is the layout height minus the visual
 * viewport's height and its offset from the top.
 */
export function webKeyboardInset(layoutHeight: number, visualHeight: number, visualOffsetTop: number): number {
  if (![layoutHeight, visualHeight, visualOffsetTop].every(Number.isFinite)) return 0;
  const covered = layoutHeight - visualHeight - visualOffsetTop;
  // Small differences are browser chrome (URL bar), not a keyboard.
  return covered > 80 ? Math.round(covered) : 0;
}
