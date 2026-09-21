# SugarSense — mobile app

A React Native + TypeScript + Expo implementation of the SugarSense UI concept:
Home, Predict, Scan (camera → meal review → post-meal forecast), Safety, Insights,
and Profile & settings, wired together with real navigation over mock data.

## Run it

```bash
npm install
npm run android   # or: npm run ios / npm run web
```

Requires Node 18+ and either an Android/iOS simulator or the Expo Go app on a
physical device (scan the QR code printed by `npm start`).

## Structure

```
src/
  theme/        design tokens (color, type, spacing, radius)
  components/   Icon, buttons, Card, Chip, GlucoseChart, CustomTabBar, Avatar
  navigation/   bottom tabs + nested Scan stack + Profile modal
  screens/      Home, Predict, Safety, Insights, Profile, scan/*
  data/         mock glucose, meal and wearable data
```

## Notes on scope

- All data is mocked in `src/data/mockData.ts` — there is no backend, CGM, or
  camera/ML integration wired up. Swap the mock data and hook the "Take photo"
  and "Confirm" actions to a real capture/analysis pipeline to go further.
- The Safety screen has a small "Preview: Normal / Attention" segmented
  control at the top so both states are easy to demo — remove it once real
  risk data drives the screen.
- Insulin guidance is presented strictly as reviewable decision support; there
  is no path in this code that delivers insulin automatically.
