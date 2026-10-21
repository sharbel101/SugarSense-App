# UI PROMPT - show the SugarSense insights in the app (`GET /insights`)

Give this file to the UI/UX + integration chat (the one that owns `mobile/`). Read `MASTER-PROMPT-UI-INTEGRATION.md` first for the project rules, safety rules,
environment and the release procedure (section 9); this prompt only adds the insights feature. Do not touch `backend/`, `deploy/` or the VM.

## 1. What exists now

The backend has a read-only endpoint, **`GET /insights`**, that returns the morning briefing, evening recap and event-triggered insights produced by the engine in `backend/insights`.
The app already has an **Insights tab** (`mobile/src/screens/InsightsScreen.tsx`, registered in `RootNavigator.tsx`) that is a placeholder card ("No insights yet"). Replace the placeholder with the real data.

Backend status (2026-10-21): the route is implemented and verified end to end against a test database, but it is **not deployed yet**. Until it is, the live web link returns the app's own HTML page for `/insights`
(nginx falls through to the SPA) and the API answers 404 or 503. The app must therefore treat "not JSON", 404 and 503 all as *unavailable* and still look fine. It is safe to ship the UI before the backend is rolled out.

## 2. The contract (do not invent fields)

`GET ${API_URL}/insights?limit=5` (`API_URL` is `''` on the deployed web build, the ngrok URL in Expo Go; limit 1 to 10, default 5). Use the existing header helper (`src/api/apiContext.ts`:
`X-App-Token` only when a token is configured, plus the ngrok bypass header). HTTP 200 with a `status` field:

```jsonc
// status "ok"
{ "status": "ok", "generatedAt": "2026-10-21T18:00:00.000Z", "count": 2,
  "notice": "These insights describe your recorded data. They are not medical advice, not a dose or treatment instruction, and not safety alerts; real-time alerts come from the alert system.",
  "insights": [{
    "id": "uuid", "category": "episode_digest", "headline": "Time outside your range", "trigger": "evening",   // morning | evening | event
    "priority": 5.6, "createdAt": "...Z", "expiresAt": "...Z" /* or null */, "observationStart": "...Z", "observationEnd": "...Z",
    "factsText": ["Today so far: 3 stay(s) above 180 mg/dL [E2] totalling about 185 minutes [E3], ..."],     // AUTHORITATIVE, 1+ sentences
    "explanation": "Glucose stayed above range three times." /* or null */,                                 // optional plain-language gloss
    "limitations": ["Time without readings is unknown, not assumed in range."],                              // may be empty
    "validation": "valid",                                                                                    // valid | fallback | not_applicable
    "evidenceRefs": ["E2"],
    "evidence": { "coverage": 1, "method": "...", "qualityFlags": [], "facts": [{ "ref": "E1", "name": "coverage", "value": 100, "unit": "%", "kind": "computed" }] },
    "contentVersion": 1 }] }
// status "empty"
{ "status": "empty", "reason": "not_generated_yet" /* or "none_active" */, "lastRunAt": null /* or ISO */, "insights": [], "notice": "..." }
// HTTP 503
{ "status": "unavailable", "reason": "Insights are not available right now." }
```
Full contract and rules: `backend/src/insights/README.md`. Insights arrive already ranked; **do not re-sort or re-rank**. `[E2]`-style tags may appear inside `factsText` (they are evidence references): strip them from the text you display
(`/\s*\[E\d+(?:,\s*E\d+)*\]/g`). Categories are open-ended: known ones include `episode_digest`, `episode_context`, `episode_time_pattern`, `meal_response`, `recurring_meal_response`, `forecast_outlook`,
`previous_day_context`, `data_quality`, `data_availability`, `exercise_association`, `sleep_association`, `insulin_timing_association`; **an unknown category must still render from `headline` + `factsText`**.

## 3. Build it the way the app already builds things

- **API client**: a pure parser + fetch in `src/api/insightsContract.ts` (same shape as `glucoseContract.ts`: `fetchInsightsFrom(baseUrl, signal, fetchImpl, headers)` returning a discriminated outcome
  `{ kind: 'ok' | 'empty' | 'unavailable' | 'error' }`), and a thin `src/api/insightsApi.ts` using `API_URL`. The parser must be **defensive**: validate every field you use, drop an insight that lacks `headline`/`factsText`,
  cap string lengths, ignore unknown keys, and treat a non-JSON body (the SPA HTML page), a wrong content type, HTTP 404/503 or an unknown `status` as `unavailable`. Never throw into the UI.
- **State**: an `InsightsProvider` (like `GlucoseProvider` / `ForecastProvider`) mounted with the other providers in `App.tsx`. Fetch on mount and when the Insights tab gains focus, on pull-to-refresh (`PullToRefreshScrollView`),
  and every **15 minutes** while the app is foreground. Do not poll every minute: insights change once or twice a day plus occasional events. Use `AbortController`; keep the last good response.
- **Freshness**: show "Updated <relative time>" from `generatedAt`. If a refresh fails, keep showing the last good insights with "Couldn't refresh, showing the last update from <time>". Hide any insight whose `expiresAt` has passed on the device.
  Never present old content as current.
- **Optional second step (ask the user first)**: a "Latest insight" card on Home showing the top insight's headline and its first `factsText` sentence, tapping through to the Insights tab.

## 4. The screen

Keep the existing header ("Insights", avatar) and subtitle. Under it, in the order received, one `Card` per insight:
1. **Headline** (title) with a small category icon (use existing `Icon` names; pick neutral ones; an unknown category gets the generic sparkle icon already used).
2. **`factsText`** as the main body, one paragraph per sentence group. This is the source of truth: show it verbatim (tags stripped).
3. **`explanation`** (only if not null) as a quieter second block labelled "In plain words". It never replaces the facts. If `validation` is `fallback`, there is simply no explanation block: do not show a badge or an error.
4. **`limitations`** (if any) as small secondary text under "What this can't tell you", always visible, not collapsed.
5. A meta line: trigger label ("Morning briefing", "Evening recap", "Just now" for `event`) and the time in the user's local time.
- At the bottom, once, the response's **`notice`** text.
- `data_availability` and `data_quality` cards use a neutral style (no red, no alarm iconography). Anything about lows (text mentions "below 70") is a *past episode summary*: do not style it as an alert.
- States: **loading** (skeleton or the existing loading pattern), **empty / not_generated_yet** ("Your first insights will appear once SugarSense has a day of your data."), **empty / none_active** ("No current insights. New ones arrive with your morning briefing and evening recap."),
  **unavailable** ("Insights aren't available right now." + a Retry button), **offline**. Sentence case, no exclamation marks, no "successfully".
- Light and dark themes via the existing tokens; `npm run check:contrast` must pass; colour is never the only carrier of meaning.
- Accessibility: each card is one accessible group read as headline, then facts, then explanation, then limitations; support dynamic type; the Retry and pull-to-refresh work with VoiceOver.

## 5. Hard rules (from CLAUDE.md section 2, apply to every line)

Do not compute, round, convert or reword any number: display `factsText` as received. Do not add statistics, charts of your own, scores, "good/bad day" labels, trends or predictions. Do not call a model. Do not turn an insight into a notification
or an alert (alerts are a separate system with their own budget). Do not suggest doses, food or insulin timing. mg/dL only. Do not use "accurate", "optimal", "clinically validated". Do not add mock insights to the shipped app.
A missing explanation, limitations or evidence is fine; a missing `factsText` means the insight is dropped.

## 6. Tests and verification (show real output)

- Add `mobile/tests/insights.test.mjs` in the style of `tests/glucose.test.mjs` with fixtures for: ok (several categories), unknown category, `explanation: null`, `validation: "fallback"`, empty (both reasons), 503 unavailable,
  `limit` echo, a 200 HTML page, invalid JSON, a wrong `status`, extra unknown fields, a missing `factsText` (dropped), tag stripping, expired insight hidden on the device. Add a script `test:insights` (or fold into the existing test script).
- Run from `mobile/`: `npm run typecheck`, `npm run lint`, `npm run check:contrast`, the test scripts (including the new ones), then `EXPO_PUBLIC_WEB_SAME_ORIGIN=1 npx expo export --platform web` (no `localhost:3000` in the bundle).
- Visual check in the browser at desktop and phone width, light and dark, for all states. Use a throwaway local stub server in `mobile/tests/` (not shipped) that serves the three response shapes, and point `EXPO_PUBLIC_API_URL` at it.
  Screenshot the ok, empty and unavailable states.
- Release: follow section 9 of `MASTER-PROMPT-UI-INTEGRATION.md` when the user says "push to main" (stage only your own paths, gates, push, poll `version.json`, live smoke tests). For `/insights` the live smoke test is: the response is JSON with
  `status` in `ok | empty | unavailable` **or** (before the backend rollout) the app shows the unavailable state without errors. An empty result is not a failed release; a crash or a blank screen is.

## 7. What is not your job

Rolling out the backend (migration 0010, the engine service, the nginx route, the timer) is done by the backend/VM chat after the user approves it. If you need a field that is not in the contract, write down exactly what you need and why, and hand it to the user; do not infer it.

## 8. First actions

`git fetch && git log origin/main --oneline -5 && git status --short`; read `backend/src/insights/README.md` and `mobile/src/api/glucoseContract.ts` (the pattern to copy); run `npm run typecheck` in `mobile/` for a green baseline; then build in this order: parser + tests, provider, screen states, polish, optional Home card (ask first).
