# GET /insights

The current insights from the Python engine (`backend/insights`): morning briefing, evening recap and event-triggered findings, already ranked.
**Read-only.** The API never generates, edits or re-ranks anything; it returns active, unexpired rows from the `insights` table in the engine's
order (`priority DESC, created_at DESC`). Health data: `Cache-Control: no-store`, rate limited (60/min per IP, 180/min global), optional `X-App-Token`
(same rule as the other routes). Same origin on the web build (nginx proxies `/insights` on :8090; the :80 gateway already forwards it).

`GET /insights?limit=5` (limit 1 to 10, default 5; anything else is 400/422).

## Responses

HTTP 200, `status` discriminates:

```jsonc
{ "status": "ok", "generatedAt": "2026-10-21T18:00:00.000Z", "count": 2, "notice": "These insights describe your recorded data. They are not medical advice, ...",
  "insights": [{
    "id": "uuid", "category": "episode_digest", "headline": "Time outside your range", "trigger": "evening", "priority": 5.6,
    "createdAt": "...Z", "expiresAt": "...Z", "observationStart": "...Z", "observationEnd": "...Z",
    "factsText": ["Today so far: 3 stay(s) above 180 mg/dL totalling about 185 minutes, ..."],   // authoritative, always present
    "paragraph": "One paragraph for the front of the card.", "source": "ai",                      // ai | rules; always present
    "reasoning": "How it was reasoned.", "safety": "What it cannot tell you.",                    // back of the card; string | null
    "explanation": "Same as reasoning (kept field).",                                              // back of the card; string | null
    "limitations": ["Time without readings is unknown, not assumed in range."],                   // show them
    "validation": "valid",                                                                         // valid | fallback | not_applicable
    "evidenceRefs": ["E2"],
    "evidence": { "coverage": 1, "method": "...", "qualityFlags": [], "facts": [{ "ref": "E1", "name": "coverage", "value": 100, "unit": "%", "kind": "computed" }] },
    "contentVersion": 1 }] }

{ "status": "empty", "reason": "not_generated_yet" | "none_active", "lastRunAt": "...Z" | null, "insights": [], "notice": "..." }
```
HTTP 503 `{ "status": "unavailable", "reason": "Insights are not available right now." }` when storage cannot be read (including before migration 0010 is applied).
No database text, SQL, user id or connection detail is ever returned.

Categories: `episode_digest`, `episode_context`, `episode_time_pattern`, `meal_response`, `recurring_meal_response`, `forecast_outlook`, `previous_day_context`, `data_quality`,
`data_availability` (the honest "what the data allows today" summary), `exercise_association`, `sleep_association`, `insulin_timing_association`, and in `full` mode `overnight_summary`,
`morning_rise_pattern`, `day_summary`, `baseline_change`, `glucose_excursion`. New categories can appear: unknown ones must still render from `headline` + `factsText`.

## Rules the client must keep

Front of the card = `paragraph`. Back = `factsText` (evidence, source of truth for numbers), `explanation` (how it was reasoned) and `limitations` (safety text first, then data limits). Never show a number that is not in `factsText`. Show `limitations`. Lows appear only as past episodes: this endpoint
is not an alert channel. An insight past `expiresAt` is already excluded by the server; do not cache it past the response.

## Verified (2026-10-21)

`insights.http.spec.ts` (9 tests, mocked DB) and `backend/insights/tests/e2e_api.sh` (29 checks on the VM against the test database with the real engine and model: response equals stored rows, order,
limit, expiry, empty, 503 without driver text, nginx proxy rule). Not deployed.
