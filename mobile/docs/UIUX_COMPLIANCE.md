# UI/UX compliance: `MOBILE_UIUX_FRONTEND_AI_GUIDE.md` applied to this app

Status as of 2026-09-21. The guide lives next to this file, unmodified:
[MOBILE_UIUX_FRONTEND_AI_GUIDE.md](./MOBILE_UIUX_FRONTEND_AI_GUIDE.md).

## Read this first

1. **Precedence.** The root `CLAUDE.md` (section 2 safety rules, UI language) and the PDF it distils win over
   the guide wherever they conflict. The guide is about looks and ergonomics; it cannot relax a safety rule.
2. **The guide is written for web React** (Vite, Tailwind, DOM, `window`). This app is Expo + React Native,
   so web-only items are listed under "Not applicable" and their React Native equivalents are used.
3. **Verify with the real commands** (all from `mobile/`): `npm run typecheck`, `npm run lint`,
   `npm run check:contrast`. Then look at every change in **light and dark** on Expo Web.

## Enforced now

| Rule (guide section) | How the app meets it | Where |
|---|---|---|
| Touch targets >= 44 pt / 48 dp (Mobile-First; One-Hand) | `touch.min = 48`. Small visuals sit in a real 48 dp box (`RoundButton`, `IconButton`, `BackButton`); text buttons and segmented options use `minHeight`. **Not** `hitSlop`: react-native-web ignores it on `Pressable`. | `src/theme/tokens.ts`, `src/components/Buttons.tsx` |
| Contrast AA: 4.5:1 text, 3:1 graphics (Accessibility) | Both palettes are tuned to pass. `npm run check:contrast` tests 29 pairings per scheme (58 total) against the real tokens and exits 1 on any miss. | `scripts/check-contrast.mjs` |
| Light and dark mode from day one (Color System) | `ThemeProvider` + `useColors()` follow the device by default. **Profile & settings > Appearance** lets the user force System / Light / Dark; the choice is saved on the device (AsyncStorage) and restored before the first frame. Dark is neutral gray (`#121212` / `#1C1C1E` / `#2C2C2E`); only the accent stays blue. `userInterfaceStyle: automatic`; the status bar and navigation theme follow the scheme in effect. | `src/theme/`, `src/components/SegmentedControl.tsx`, `src/screens/ProfileScreen.tsx`, `App.tsx`, `src/navigation/RootNavigator.tsx`, `app.json` |
| Limited, predictable type scale (Typography) | 11 fixed sizes in `fontSize` (the screens used 18 different sizes, including half-points). Body copy is >= 14. `typography` holds the named styles. | `src/theme/tokens.ts` |
| Spacing scale (Spacing) | `spacing` / `radius` tokens (4 / 8 pt grid). Some inline literals (gaps of 14, paddings of 18 or 22) remain and are not enforced. | `src/theme/tokens.ts` |
| Button states: normal, pressed, disabled, loading (Button System) | `PrimaryButton` has all four (`loading` shows a spinner and sets `busy`). `SecondaryButton` and `GhostButton` have pressed and disabled. | `src/components/Buttons.tsx` |
| Screen-reader support (Accessibility) | `header` role on screen and section titles; `tablist` / `tab` with `aria-selected` on the tab bar; `radiogroup` / `radio` with `aria-checked` on segmented controls; `aria-disabled` / `aria-busy` on buttons. State uses the `aria-*` props, **not** `accessibilityState`, because react-native-web ignores `accessibilityState`. Also: `accessibilityLabel` on every icon-only control, a text alternative on every chart and on the meal photo, and `maxFontSizeMultiplier` on fixed-size tab labels. | screens, `CustomTabBar.tsx`, `SegmentedControl.tsx`, `GlucoseChart.tsx` |
| Primary CTA in the thumb zone; back / nav at the top (One-Hand) | Confirm, Edit and Done are pinned footers above the home indicator. Back / close is top-left. Tab bar is at the bottom. | `MealReviewScreen`, `PostMealScreen` |
| Tab bar: 4 to 5 destinations (iOS navigation) | 4 tabs plus the raised Scan action. | `CustomTabBar.tsx` |
| Safe areas (Mobile-First) | `SafeAreaView` edges and `useSafeAreaInsets`. | all screens, tab bar |
| Functional components + TypeScript; no `console` noise (React Architecture; Code Quality) | Already true. `strict` TypeScript, no class components, no `console.*` in `src/`. | repo-wide |

### What was actually measured (Expo Web, 390 x 700, light and dark)

- **Palette:** 58 / 58 pairings pass; the check was also run against the *old* colours and correctly failed
  (muted text 2.77 to 3.14:1, green text 3.54:1).
- **Rendered screens:** a DOM audit computed the real contrast of every text node against its composited
  background on every screen and state (Home, Predict with and without details, Safety normal and attention,
  Insights, Profile with the Appearance control, Camera, Meal review, Meal forecast with and without the
  calculation), in both schemes: **0 failures**, lowest 4.70:1 (light) and 5.39:1 (dark). It caught one thing the
  token check cannot: text on a translucent scrim over a photo. The scrim is now opaque enough to hold 4.5:1 over
  any image.
- **Touch sizes:** the same audit checked the 75 visible interactive controls (buttons, tabs, radios) in each
  scheme: none under 47 dp.
- **Theme switching:** with the device on dark, choosing Light flips the app and survives a reload; with the device
  on light, choosing Dark does the same; with System selected the app follows the device live, without a reload.
  Verified on Expo Web only. The native path (`Appearance.setColorScheme`, which also flips keyboards and alerts)
  is untested on a device.

That audit ran in a browser session and is **not** committed. Only the palette check is a repeatable script.

## Not applicable to React Native (web-only items in the guide)

- Vite, Tailwind, shadcn/ui, Radix, CSS classes, Prettier-for-JSX setup, `.jsx` files, PropTypes.
- `<picture>`, `srcSet`, WebP fallbacks, `loading="lazy"`, `next/image`.
- `window.*`, `localStorage`, `document.documentElement`, `matchMedia`. Use `useColorScheme`, `useWindowDimensions`,
  and `@react-native-async-storage/async-storage` for persistence (the theme preference uses it).
- `React.lazy` / `Suspense` route splitting and the 100 KB gzipped bundle budget; `webpack-bundle-analyzer`.
- Web Vitals (CLS, FID, LCP, TTFB).
- Hand-written DOM ARIA and keyboard focus management. React Native's `accessibility*`, `role` and `aria-*` props are
  used instead.
- `prefers-reduced-motion`. The app has no animations today. If one is added, gate it on
  `AccessibilityInfo.isReduceMotionEnabled`.
- `env(safe-area-inset-*)` and CSS breakpoints. `react-native-safe-area-context` and `useWindowDimensions` are used.

## Deferred: needs a decision or a dependency

- **Automated component tests and the 60% coverage target.** No test runner is installed in `mobile/`. Recommended:
  `jest-expo` + `@testing-library/react-native`. Until then the contrast script is the only automated UI check.
- **React Query / Zustand.** There is no server or global state yet (mock data only).
- **Onboarding (max 3 screens), empty / loading / error states, skeletons.** Nothing real to show until data is
  real. Design them together with the low-confidence and uncertainty states the root `CLAUDE.md` requires.
- **Haptics** (`expo-haptics` is not installed) and gestures beyond the native stack's swipe-back.
- **Push notifications.** Governed by the alarm budgets in root `CLAUDE.md` sections 2 and 12, which are stricter
  than the guide.
- **`danger` button variant.** No destructive action exists yet.
- **Device testing:** VoiceOver / TalkBack, Dynamic Type, one-handed reach, and native `hitSlop`-free touch sizes
  have not been checked on a phone. Native Android also needs `expo prebuild` for `userInterfaceStyle` to take
  effect (`android/` is generated).

## Where the guide and this project differ

- **Android patterns** (top app bar, navigation drawer, FAB): the app uses one brand design on both platforms,
  which the guide itself endorses ("unified brand identity with platform-native patterns").
- **Notifications and alerts:** the guide's toast and alert conventions never override the project's alarm budgets
  and the rule that hypoglycaemia alerts and the anomaly agent do not share a channel.
- **Copy the prototype still gets wrong** (for example the "LOW RISK" reassurance, the point estimates
  "Peak ~180 mg/dL" and "4.5 U", and a bolus figure shown before the arithmetic) breaks root `CLAUDE.md` section 2,
  not this guide. It is already listed in root `CLAUDE.md` section 0 and is untouched here.

## Checklist when you add or change UI

- [ ] Colours come from `useColors()`; nothing hard-coded except deliberate always-dark surfaces (camera) and photo content.
- [ ] Any new text / background pairing is added to `PAIRS` in `scripts/check-contrast.mjs`, and `npm run check:contrast` passes.
- [ ] Every tappable element is at least 48 x 48 dp as a real box (not `hitSlop`).
- [ ] Font sizes come from `fontSize`; body copy is 14 or larger.
- [ ] Screen title has `accessibilityRole="header"`; icon-only controls have a label; selected / checked / disabled / busy are exposed with `aria-*` props.
- [ ] Charts and images have a text alternative that describes the trend or range, never an invented number.
- [ ] The screen's primary action is in the bottom thumb zone.
- [ ] Looked at in light **and** dark.
