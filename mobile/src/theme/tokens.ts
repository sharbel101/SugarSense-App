/**
 * Design tokens.
 *
 * Colour comes in two palettes (light / dark) that share one set of role names, so
 * screens never branch on the scheme - they call `useColors()` (see ThemeProvider).
 * Every text/background pairing the app renders is checked against WCAG 2.1 AA by
 * `npm run check:contrast`; change a colour here and run it.
 */
const light = {
  // brand blue. `blue600` is text/icon/fill and carries `onBlue` text when used as a fill.
  blue700: '#2F58C4',
  blue600: '#3262D0',
  blue500: '#5B87E8',
  blue100: '#E8EFFD',
  blue50: '#F3F7FF',
  onBlue: '#FFFFFF',

  // neutrals
  ink: '#16213D',
  ink2: '#465170',
  ink3: '#5D697F', // muted text
  ink4: '#8A95AA', // icons, chevrons, disabled fills - never text
  border: '#E3E8F1',
  divider: '#EEF1F7',
  ground: '#F7F9FC',
  surface: '#FFFFFF',
  surfaceRaised: '#FFFFFF', // a surface lifted above `surface`, e.g. the active tab capsule
  onInk: '#FFFFFF', // text on `ink` fills (tooltips)
  onInk2: '#DDE3F0',

  // semantic
  green600: '#0F7A50',
  green100: '#E1F6EC',
  greenDark: '#0E6B45',
  greenDark2: '#1B7A52',

  amber600: '#B4650A',
  amber100: '#FFF0DA',
  amberDark: '#8A4E08',

  red600: '#C0341F',
  red100: '#FBE4E1',

  purple600: '#7452C9',
  purple100: '#F0EBFC',

  // the scan screen is always dark, in both schemes
  camera: '#0E1420',
  cameraSurface: '#2A3346',
};

export type ColorPalette = Record<keyof typeof light, string>;

export const lightColors: ColorPalette = light;

// Dark is neutral gray (iOS / Material style), not navy: only the accent stays blue, and every
// tint is that accent's colour at low opacity over the gray surface.
export const darkColors: ColorPalette = {
  blue700: '#9DBBFA',
  blue600: '#7EA3F7',
  blue500: '#6C93EE',
  blue100: '#2A2F3C',
  blue50: '#22252E',
  onBlue: '#121212',

  ink: '#F2F2F2',
  ink2: '#C7C7CC',
  ink3: '#A1A1A6',
  ink4: '#6E6E73',
  border: '#38383A',
  divider: '#2A2A2C',
  ground: '#121212',
  surface: '#1C1C1E',
  surfaceRaised: '#2C2C2E',
  onInk: '#121212',
  onInk2: '#3A3A3C',

  green600: '#4CCB98',
  green100: '#23352F',
  greenDark: '#8FE0BB',
  greenDark2: '#A0E7C8',

  amber600: '#F2AE45',
  amber100: '#3A3024',
  amberDark: '#F6C877',

  red600: '#F58779',
  red100: '#3A2B2B',

  purple600: '#B7A1F2',
  purple100: '#322F3C',

  camera: '#0D0D0E',
  cameraSurface: '#2C2C2E',
};

/** `#RRGGBB` + opacity -> `#RRGGBBAA`, so a theme colour can be used translucent. */
export function withAlpha(hex: string, alpha: number) {
  return `${hex}${Math.round(alpha * 255).toString(16).padStart(2, '0')}`;
}

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  huge: 40,
} as const;

export const radius = {
  chip: 12,
  row: 16,
  card: 20,
  hero: 24,
  pill: 999,
} as const;

/**
 * Minimum touch target in dp. 48 satisfies both iOS (44 pt) and Material (48 dp).
 * Make the target real (a 48 dp box around a smaller visual, see `RoundButton`) rather than
 * using `hitSlop`: react-native-web ignores `hitSlop` on Pressable.
 */
export const touch = {
  min: 48,
} as const;

/** The only font sizes text may use - no half-points. */
export const fontSize = {
  micro: 11,
  caption: 12,
  label: 13,
  body: 14,
  bodyLg: 15,
  title: 16,
  headline: 20,
  h1: 22,
  stat: 30,
  statLg: 40,
  display: 56,
} as const;

export const typography = {
  display: { fontFamily: 'Manrope_800ExtraBold', fontSize: fontSize.display, letterSpacing: -1.5 },
  statLg: { fontFamily: 'Manrope_800ExtraBold', fontSize: fontSize.statLg },
  stat: { fontFamily: 'Manrope_800ExtraBold', fontSize: fontSize.stat },
  h1: { fontFamily: 'Manrope_800ExtraBold', fontSize: fontSize.h1 },
  headline: { fontFamily: 'Manrope_700Bold', fontSize: fontSize.headline },
  h2: { fontFamily: 'Manrope_700Bold', fontSize: fontSize.title },
  bodyLg: { fontFamily: 'Manrope_700Bold', fontSize: fontSize.bodyLg },
  body: { fontFamily: 'Manrope_500Medium', fontSize: fontSize.body },
  bodyStrong: { fontFamily: 'Manrope_600SemiBold', fontSize: fontSize.body },
  label: { fontFamily: 'Manrope_700Bold', fontSize: fontSize.label },
  bodySm: { fontFamily: 'Manrope_500Medium', fontSize: fontSize.label },
  caption: { fontFamily: 'Manrope_600SemiBold', fontSize: fontSize.caption },
  captionRegular: { fontFamily: 'Manrope_500Medium', fontSize: fontSize.caption },
  micro: { fontFamily: 'Manrope_500Medium', fontSize: fontSize.micro },
} as const;

export const shadow = {
  card: {
    shadowColor: '#10214D',
    shadowOpacity: 0.06,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 3,
  },
  lift: {
    shadowColor: '#10214D',
    shadowOpacity: 0.14,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
  fab: {
    shadowColor: '#3D6FDB',
    shadowOpacity: 0.38,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
} as const;
