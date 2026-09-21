# SugarSense — Session Handoff (for continuing front-end/mobile dev)

Context for whichever AI/dev picks this up: this session did **two separate things** that must not be confused with each other. Read this before touching `mobile/`.

---

## 1. The two things that now exist on disk

### A. The real project — `sugarsense_app_dev/` (untouched by this session, except this file)

This is the actual SugarSense project: `mobile/` (React Native + Expo + TypeScript, currently just a skeleton — `src/config.ts` + `src/api/health.ts`, no screens yet), `backend/` (NestJS), `ml/` (Python), governed by a detailed `CLAUDE.md` at the repo root (distilled from a technical reference PDF — physiological simulator, Mode A/B glucose forecasting, hypoglycemia risk model, meal-photo vision pipeline, anomaly agent, strict safety/data rules). **Nothing in `mobile/`, `backend/`, or `ml/` was created or modified this session.** That `CLAUDE.md` is the source of truth for this project going forward — the front-end AI should read it in full before writing any code into `mobile/`.

### B. A UI/UX reference demo — `sugarsense_app_dev/test-APP/` (built this session, renamed by the user from `sugarsense-app`)

A **separate, standalone** Expo/React Native/TypeScript app built earlier in this session as a pure UI/UX concept exploration for a "SugarSense" consumer app — 5 screens (Home, Predict, Scan, Safety, Insights) + a Profile modal, custom design system, mock data only. **This does not follow the real project's data model or safety-copy rules** (see below) and was explicitly kept as a separate reference folder, not merged into `mobile/`, per the user's own decision earlier in this session.

**Use `test-APP` only for visual/interaction ideas — not as a code base to build on directly**, because:
- It uses fabricated/mock numbers with no `edited` flag or audit trail (violates `CLAUDE.md` §2, §3.6).
- Its bolus screen doesn't show the full term-by-term arithmetic breakdown format `CLAUDE.md` §10/§12.2 requires.
- Its data shapes don't match the 12 real entities in `CLAUDE.md` §3 (`meal`, `glucose_reading`, `prediction`, `sensor_aggregate`, etc.).
- It has no loading/error/low-confidence states, no real camera, no backend, no auth/persistence.

If the front-end AI wants to reuse the visual language (colors, typography, chart style, screen flow), treat `test-APP/src/theme`, `src/components`, and the screen layouts as a moodboard — rebuild against real data and real copy rules, don't copy-paste.

---

## 2. What was verified about `test-APP` (for reference)

- 5 screens + Profile modal, `react-native-svg` custom charts/icons, Manrope typography, React Navigation (bottom tabs + nested stacks), mock data in `src/data/mockData.ts`.
- Verified via `tsc --noEmit` (0 errors), `expo export` for Android and web targets, and a Playwright-driven screenshot pass of the web build (11 screenshots) — confirmed it actually runs, not just type-checks.
- One real bug found and fixed: the bottom tab bar was incorrectly visible during the Scan flow (custom `tabBar` render prop doesn't respect `tabBarStyle:{display:'none'}` — fixed by returning `null` from the `tabBar` function when the focused route is `Scan`).
- Run it: `cd test-APP && npm install && npm start`, then scan the QR with the iOS Camera app (needs Expo Go installed) or Android's Expo Go. Same-Wi-Fi required, or add `--tunnel` if that fails.

---

## 3. BLE / Android testing research (relevant to real `mobile/` dev, once BLE work starts)

Band: **HealthyPi Move** (open-source, Zephyr-firmware, BLE 6.0). It exposes **standard BLE GATT services**, not a proprietary SDK — this is directly compatible with `react-native-ble-plx` (the candidate `CLAUDE.md` names but hasn't installed yet):

| Service | UUID | Notes |
|---|---|---|
| Heart Rate | `0x180D` | Notify, ~every 3s while worn |
| Battery | `0x180F` | Notify/Read |
| Pulse Oximeter (SpO₂) | `0x1822` | Spot-check, encrypted |
| Health Thermometer | `0x1809` | Indicate, rate-limited (~30s / 0.1°C) |
| ECG/GSR (custom) | `00001122-0000-1000-8000-00805f9b34fb` | Raw waveform, streams on subscribe |
| PPG (custom) | `cd5c7491-4448-7db8-ae4c-d1da8cba36d0` | Wrist + finger channels, streams on subscribe |

Device advertises as `"healthypi move"`, MTU 247. Battery life: up to 5 days normal use, 12–144h depending on streaming intensity.

**Expo Go cannot be used for BLE testing at all** — it only contains Expo's own bundled native modules, not third-party ones like `react-native-ble-plx`. Once BLE work starts, the flow becomes:
1. Install the BLE library, run `npx expo prebuild` to (re)generate `mobile/android`.
2. Build a **development build** (dev client): `npx expo run:android` (local) or `eas build --profile development --platform android` (cloud). **Local Android builds are currently blocked** per `CLAUDE.md`'s tooling notes — the NDK/CMake install hung during `assembleDebug`. **Use EAS cloud build for now** (`mobile/eas.json` is already set up; needs an Expo login).
3. Day-to-day work then uses `npx expo start --dev-client` — same hot-reload experience as Expo Go, just pointed at the installed dev client instead.
4. **Test BLE on a real Android device, never an emulator** — emulators generally have no real Bluetooth radio.

**All-day connectivity — platform-specific, plan for gaps, don't assume perfection:**
- **Android**: achievable, but requires either a foreground service (`connectedDevice` type, mandatory on Android 14+, shows a persistent notification) or the `CompanionDeviceService` API + `REQUEST_COMPANION_RUN_IN_BACKGROUND` permission (no notification, narrower eligibility). Without one of these, Android will eventually kill the background process. Also needs runtime `BLUETOOTH_SCAN`/`BLUETOOTH_CONNECT` permissions (API 31+), plus location permission on older API levels.
- **iOS**: background BLE is inherently limited — roughly a 15-minute background-task window and ~30 seconds of runtime per wake, even with `bluetooth-central` background mode declared. True uninterrupted all-day connection is not reliable on iOS regardless of implementation care.
- This is actually already accounted for in `CLAUDE.md` §12/§13 — `coverage` is a first-class data field (missingness is data, never imputed), and the anomaly agent already treats "band not worn >12h" and "sync stalled >24h" as expected low-severity conditions, not failures. Build the wearable pipeline assuming intermittent connectivity from day one rather than fighting iOS for perfection.

---

## 4. Open items (unchanged from `CLAUDE.md`, not resolved this session)

BLE library not yet formally locked in (react-native-ble-plx is the likely pick, still not installed); ORM/query layer for Postgres; how shared TS reaches both `mobile/` and `backend/`; on-device inference runtime (ONNX Runtime Mobile vs TFLite vs ExecuTorch); which vision-language model for meal photos; final `com.sugarsense.app` application id (permanent once published — pick deliberately); and everything in `CLAUDE.md`'s own "Build order" (§15) starting from Phase 1 (simulator parameter fitting), which doesn't need the mobile app at all and can start independently.

---

## 5. What to hand the front-end AI, concretely

Point it at `CLAUDE.md` first, full stop — it is long but is the actual spec (data model, safety rules, UI copy table, simulator equations, build order). Then: `mobile/src` is empty and waiting for real screens; `test-APP/` is a look-and-feel reference only; BLE work is blocked on picking/installing a library and needs an EAS dev-client build (not Expo Go) plus a real Android device to test against; the HealthyPi Move's GATT UUIDs above are ready to use directly.
