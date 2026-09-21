# SugarSense

Type 1 diabetes decision-support app: mobile app + backend + modelling layer. See
[`CLAUDE.md`](CLAUDE.md) for the design, safety rules and conventions (distilled from the
*SugarSense Technical Reference*).

**Status: development environment plus a UI prototype.** `mobile/` holds a UI/UX prototype (Home, Predict,
Scan, Safety, Insights, Profile) that runs entirely on **mock data** - it is not connected to the backend and
does not yet follow the safety/copy rules in `CLAUDE.md`. No BLE code, data models or ML models exist.
The only backend route is the `/health` liveness probe (not used by the UI).

```
SugarSense/                 (this repo, branch `sugarsense_app` of sharbel101/GlucoGuard)
├── mobile/    React Native + Expo (TypeScript) - web now, Android/iOS dev builds later
├── backend/   NestJS (TypeScript) - Postgres/Supabase-ready
└── ml/        Python 3.12 virtualenv - numpy, pandas, scikit-learn, LightGBM, PyTorch, ONNX
```

## Day-to-day workflow (UI testing)

**On the Windows laptop: browser only** (no emulator).

```powershell
cd mobile ; npm run web          # Expo Web (Metro) on http://localhost:8081, Fast Refresh on
```

**On an iPhone: Expo Go** (no Mac, no build, no Apple account).

```powershell
cd mobile ; npm run start:go     # prints a QR code; also serves the browser at http://localhost:8081
```

1. Install **Expo Go** from the App Store and make sure it is up to date (this project is Expo SDK 57;
   an old Expo Go will say the SDK is incompatible).
2. Put the iPhone and the PC on the **same Wi-Fi** (no guest network / client isolation), scan the QR code
   with the iPhone Camera app and open it in Expo Go. Or type the URL shown, e.g. `exp://192.168.10.30:8081`.
3. If it cannot connect, allow Node.js through Windows Firewall (Private and Public), or use
   `npx expo start --go --tunnel` (needs an extra package download).

The prototype runs on mock data, so the backend is not needed. The backend still runs separately
(`cd backend ; npm start`, http://localhost:3000) and nothing in the UI calls it yet.

Expo Go cannot test Bluetooth/wearable access, HealthKit, push notifications or background work - those need
an iOS development build (macOS or EAS cloud build + Apple Developer account), see below.

## Prerequisites (Windows)

| Tool | Version used | Notes |
|---|---|---|
| Node.js | >= 22.13 (22.16 installed; 22.22.3+ removes an `EBADENGINE` warning) | |
| npm | 10.9 bundled; **npm 11 for `backend/` installs** | `npx --yes npm@11 install` |
| Python | 3.12 | `ml/.venv` |
| JDK | 17+ (JDK 19 installed, `JAVA_HOME`) | native Android builds only |
| Android SDK | `%LOCALAPPDATA%\Android\Sdk`, `ANDROID_HOME` set (user level) | native Android builds only |

## Mobile (`mobile/`)

Expo SDK 57 / React Native 0.86 / React 19, New Architecture, Hermes, TypeScript (strict).
`expo-dev-client` is installed, so native builds are **Expo development builds - Expo Go is not used**.

```powershell
cd mobile
npm install
npm run web          # browser workflow (above)
npm run typecheck ; npm run lint ; npm run doctor
```

### Native development builds (later - not built yet)

Android and iOS config is in place (`app.json`: `com.sugarsense.app`; `eas.json`; a generated, gitignored
`android/` project) and the same JS bundles for both platforms. **No native binary has been built yet.**

- **Android, local build:** `npm run android` builds and installs on a USB-connected phone (Developer
  options > USB debugging, accept the RSA prompt, `adb devices` must list it). First build needs the
  Android NDK 27.1.12297006, CMake 3.22.1 and platform 36. Gradle's auto-installer hung on the NDK on
  this machine (dead download connection) - see "Tooling notes" in `CLAUDE.md` for the manual install.
- **iOS:** Expo cannot generate `ios/` on Windows. Use macOS (`npm run ios`) or EAS cloud builds
  (`eas build --profile development --platform ios`; needs an Expo account and Apple Developer Program).
- A physical phone reaches the backend via your PC's LAN IP, not `localhost` (see `mobile/.env.example`).

## Backend (`backend/`)

NestJS 12 (ESM), Vitest, oxlint. Installed and configured for Postgres/Supabase (`pg`,
`@supabase/supabase-js`, `@nestjs/config`, `class-validator`, `class-transformer`) but **no data
models**. Copy `.env.example` to `.env` to set `DATABASE_URL` / `SUPABASE_*`.

```powershell
cd backend
npx --yes npm@11 install      # npm 10.9 crashes on this dependency tree
npm start                     # http://localhost:3000 (PORT overrides)
npm run typecheck ; npm run lint ; npm test ; npm run test:e2e ; npm run build
```

## ML (`ml/`)

```powershell
cd ml
py -3.12 -m venv .venv
.venv\Scripts\python.exe -m pip install -e ".[dev]"
.venv\Scripts\python.exe -m pytest ; .venv\Scripts\python.exe -m ruff check .
```

Resolved versions are pinned in `ml/requirements-lock.txt`. `ml/data/` is gitignored - never commit
patient data (OhioT1DM is under a data use agreement).
