/**
 * WCAG 2.1 AA contrast check for the design tokens (MOBILE_UIUX_FRONTEND_AI_GUIDE.md, "Color Contrast").
 *
 * Reads the real palettes from src/theme/tokens.ts and tests every text/background pairing the app
 * renders, in both light and dark. Exits 1 if any pair falls below its minimum.
 *
 *   npm run check:contrast
 *
 * When you add a colour pairing to a screen, add it to PAIRS so it stays covered.
 */
import { darkColors, lightColors } from '../src/theme/tokens.ts';

const channel = (v) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const TEXT = 4.5; // normal text
const GRAPHIC = 3; // icons, chart strokes, UI graphics

// [description, foreground token, background token, minimum ratio]
const PAIRS = [
  ['body text on ground', 'ink', 'ground', TEXT],
  ['body text on surface', 'ink', 'surface', TEXT],
  ['body text on active tab capsule', 'ink', 'surfaceRaised', TEXT],
  ['secondary text on ground', 'ink2', 'ground', TEXT],
  ['secondary text on surface', 'ink2', 'surface', TEXT],
  ['secondary text on divider', 'ink2', 'divider', TEXT],
  ['muted text on ground', 'ink3', 'ground', TEXT],
  ['muted text on surface', 'ink3', 'surface', TEXT],
  ['muted text on divider (segmented control)', 'ink3', 'divider', TEXT],
  ['blue text on surface (text buttons)', 'blue600', 'surface', TEXT],
  ['blue text on ground', 'blue600', 'ground', TEXT],
  ['blue text on blue tint (chips)', 'blue600', 'blue100', TEXT],
  ['blue label on active tab capsule', 'blue600', 'surfaceRaised', TEXT],
  ['text on blue fill (buttons)', 'onBlue', 'blue600', TEXT],
  ['green text on green tint (chips)', 'green600', 'green100', TEXT],
  ['green text on surface', 'green600', 'surface', TEXT],
  ['green text on ground', 'green600', 'ground', TEXT],
  ['dark green on green tint (safety card)', 'greenDark', 'green100', TEXT],
  ['dark green 2 on green tint (safety card)', 'greenDark2', 'green100', TEXT],
  ['amber text on amber tint', 'amberDark', 'amber100', TEXT],
  ['amber icon on amber tint', 'amber600', 'amber100', GRAPHIC],
  ['purple text on purple tint (chips)', 'purple600', 'purple100', TEXT],
  ['purple text on surface', 'purple600', 'surface', TEXT],
  ['purple text on ground (fun loading word)', 'purple600', 'ground', TEXT],
  ['red icon on red tint', 'red600', 'red100', GRAPHIC],
  ['red text on red tint (low-confidence chip)', 'red600', 'red100', TEXT],
  ['red text on ground (fun loading word)', 'red600', 'ground', TEXT],
  ['red text on surface (fun loading word)', 'red600', 'surface', TEXT],
  ['tooltip text on ink', 'onInk', 'ink', TEXT],
  ['tooltip secondary text on ink', 'onInk2', 'ink', TEXT],
  ['chevron / icon on surface', 'ink4', 'surface', GRAPHIC],
  ['chart actual line on surface', 'blue700', 'surface', GRAPHIC],
  ['chart forecast line on surface', 'blue500', 'surface', GRAPHIC],
];

let failures = 0;
for (const [scheme, palette] of [
  ['light', lightColors],
  ['dark', darkColors],
]) {
  for (const [description, fg, bg, min] of PAIRS) {
    const ratio = contrast(palette[fg], palette[bg]);
    if (ratio < min) {
      failures += 1;
      console.error(`FAIL  ${scheme}  ${ratio.toFixed(2)} < ${min}  ${description}  (${fg} ${palette[fg]} on ${bg} ${palette[bg]})`);
    }
  }
}

const total = PAIRS.length * 2;
if (failures > 0) {
  console.error(`\n${failures} of ${total} pairings below WCAG AA.`);
  process.exit(1);
}
console.log(`PASS  ${total} of ${total} pairings meet WCAG AA (${PAIRS.length} in light, ${PAIRS.length} in dark).`);
