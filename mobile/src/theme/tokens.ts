export const colors = {
  // brand blue
  blue700: '#2F58C4',
  blue600: '#3D6FDB',
  blue500: '#5B87E8',
  blue100: '#E8EFFD',
  blue50: '#F3F7FF',

  // neutrals
  ink: '#16213D',
  ink2: '#55617A',
  ink3: '#8792A6',
  ink4: '#B7C0D2',
  border: '#E3E8F1',
  divider: '#EEF1F7',
  ground: '#F7F9FC',
  surface: '#FFFFFF',

  // semantic
  green600: '#16915F',
  green100: '#E1F6EC',
  greenDark: '#0E6B45',
  greenDark2: '#1B7A52',

  amber600: '#B4650A',
  amber100: '#FFF0DA',
  amberDark: '#8A4E08',

  red600: '#D3402F',
  red100: '#FBE4E1',

  purple600: '#7452C9',
  purple100: '#F0EBFC',

  camera: '#0E1420',
  cameraSurface: '#2A3346',
} as const;

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

export const typography = {
  display: { fontFamily: 'Manrope_800ExtraBold', fontSize: 60, letterSpacing: -1.5 },
  h1: { fontFamily: 'Manrope_800ExtraBold', fontSize: 22 },
  h2: { fontFamily: 'Manrope_700Bold', fontSize: 16 },
  body: { fontFamily: 'Manrope_500Medium', fontSize: 14.5 },
  bodyStrong: { fontFamily: 'Manrope_600SemiBold', fontSize: 14.5 },
  caption: { fontFamily: 'Manrope_600SemiBold', fontSize: 12 },
  captionRegular: { fontFamily: 'Manrope_500Medium', fontSize: 12.5 },
  label: { fontFamily: 'Manrope_700Bold', fontSize: 13 },
} as const;

export const shadow = {
  card: {
    shadowColor: '#10214D',
    shadowOpacity: 0.06,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 3,
  },
  nav: {
    shadowColor: '#10214D',
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: -4 },
    elevation: 8,
  },
  fab: {
    shadowColor: '#3D6FDB',
    shadowOpacity: 0.38,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
} as const;
