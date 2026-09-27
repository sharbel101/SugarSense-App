# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.

# UI/UX standards

Follow [docs/MOBILE_UIUX_FRONTEND_AI_GUIDE.md](docs/MOBILE_UIUX_FRONTEND_AI_GUIDE.md), as applied to this
React Native app in [docs/UIUX_COMPLIANCE.md](docs/UIUX_COMPLIANCE.md) (what is enforced, what is web-only and
does not apply, what is deferred). Where the guide conflicts with the root `CLAUDE.md` (section 2 safety rules,
UI language), **`CLAUDE.md` wins**.

Non-negotiables when you touch UI:

- **Colour:** never import a palette. Call `const colors = useColors()` inside the component, so dark mode works.
  A new text/background pairing goes into `scripts/check-contrast.mjs`; `npm run check:contrast` must pass.
- **Touch targets:** every tappable element is at least 48 x 48 dp (`touch.min`) as a real box. Use `RoundButton`,
  `IconButton`, `BackButton`, or `minHeight`. Do not rely on `hitSlop`: react-native-web ignores it.
- **Type:** only sizes from `fontSize` (no half-points); body copy is 14 or larger.
- **Accessibility:** `accessibilityRole="header"` on screen titles, `accessibilityLabel` on icon-only controls, and a
  text alternative on every chart and image. Expose state with `aria-selected` / `aria-checked` / `aria-disabled` /
  `aria-busy`, **not** `accessibilityState`: react-native-web ignores the latter, so the web build would announce nothing.
- **Layout:** the screen's primary action lives in the bottom thumb zone (a pinned footer); back / close is top-left.
- **Verify:** `npm run typecheck`, `npm run lint`, `npm run check:contrast`, then look at the change in light
  **and** dark on Expo Web.
