# SugarSense insight engine

Personalized morning briefing, evening recap and event-triggered insights. **Python computes and decides; the LLM only explains;
Python validates.** Status: implemented and tested, **not deployed, not enabled, migration 0010 not applied to production**.
This is reporting of recorded data, not medical advice. It never changes glucose calculations, treatment settings or alert states,
and the forecast/alert services do not depend on it.

## 1. Architecture (and how it maps onto what exists)

```
existing Postgres tables (read-only session)
  glucose_readings, meal_events, insulin_events, activity_events, sleep_events,
  context_features, predictions, users.profile        -> db_source.PgSource  (one adapter per source -> Snapshot)
        |
  quality.py    sort, dedupe, drop implausible/spike/future; coverage; freshness; availability PER category
        |
  features.py   stats, time-weighted TIR, excursions, windows (all pure, typed)
        |
  patterns.py   detectors -> Candidate(facts[E1..], claims (Python-written text), boundaries, limitations, coverage, method)
        |
  ranking.py    deterministic dedupe key + facts hash, material-change rule, event cooldown, priority, cap, no padding
        |
  llm.py        versioned prompt + strict JSON schema, local Qwen3.5-4B via llama.cpp (127.0.0.1:8181), ~170 tokens/insight, batched
        |
  validate.py   deterministic gate: schema, ids, evidence refs, numbers+units traced to Python, interval labels, missing-data
        |        consistency, direction, untrusted-text echo, dose/diagnosis/reassurance/causal wording; 1 corrective retry
  render.py     facts_text (Python) + explanation (only if validated) ; fallback = Python text only
        |
  store.py      insight_runs (idempotent) + insights (versioned, supersede) -- the ONLY tables the engine writes
```

Reused rather than rebuilt: the Postgres schema and migration runner (`backend/db`), the least-privilege `sugarsense_app` role, the systemd-timer
pattern used by `forecast-eval`, the llama.cpp image and the Qwen3.5-4B Q4_K_M file already on the VM, the earlier benchmark
(`backend/docs/llm-benchmark`: its recommendations are the design here). Not touched: NestJS API, forecast service, bg_service,
collector monitor, alert logic. There is no public endpoint; a thin authenticated `GET /insights` can later read `insights` (see section 9).

## 2. Data contract and missing-data behaviour

`models.py`: `Reading`, `Meal`, `Insulin`, `Activity`, `Sleep`, `WearableSample`, `ForecastPoint`, `UserSettings`, `Snapshot`. Each has explicit
units (mg/dL only), UTC time and source; `None` means unknown, never zero. Cancelled meals/insulin are excluded by the adapter. Adding a source =
a new adapter that fills the Snapshot + optionally a new detector; nothing existing changes. Wearable samples are loaded from `context_features` when present
but no detector uses them yet (no wearable integration exists; none is faked).

Verified source coverage on 2026-10-20 (counts only): 1 user, 663 CGM readings over 5 days, 30 meals, 34 insulin events, **0 sleep, 0 activity, 0 context rows**, 3,641 predictions.

| Missing / weak input | Behaviour (tested) |
|---|---|
| No wearable | glucose-only insights; wearable never mentioned |
| No sleep | overnight insight states "no sleep record, so nothing is said about sleep quality"; the validator rejects any sleep claim |
| No meals / no insulin | no meal or insulin finding; a meal finding with no nearby insulin says insulin is not part of the explanation |
| No forecast, or older than 20 min | no forecast insight |
| Sparse CGM / long gap | detectors require coverage and reading counts (section 4); otherwise nothing is claimed |
| Stale latest reading | reported as "last recorded value, not a current measurement" (data-quality insight) |
| Conflicting values at one timestamp, implausible value, isolated spike | excluded from every analysis, flagged, mentioned as a limitation |
| Short history (< 5 days) | no recurring or week-over-week claim |
| Nothing supportable | a Python-written availability summary ("what the data allows today"), never invented insights |

A missing source never suppresses an unrelated insight. The target of 3 to 5 is a cap, not a quota: with fewer supported findings, fewer are shown.

## 2b. Episode-first mode (the default) and minimal metrics

The model is shown only the **episodes**: stays above or below the reporting range lasting at least 20 minutes. Covered time outside them counts as in range; time **without readings is unknown, not "in range"**, and the text says so.
Every other metric is optional context that adds insights when records exist, and is never required:

| Metrics available | Insights produced (examples) |
|---|---|
| Glucose only | `episode_digest` (counts, total minutes, worst peak/low; or "no stay outside the range"), `episode_time_pattern` ("a stay above range began between 12:00 and 15:00 on 9 of 9 days"; needs 3 days), forecast if one exists |
| + meals | `episode_context` (the meal logged before a stay, estimated carbohydrates), `meal_response`, `recurring_meal_response` |
| + insulin / activity | the same context lists (record counts, never dose sizes), plus gated associations |
| + sleep / wearables | sleep association (>= 7 paired nights); wearables are loaded but not yet used |

With glucose only the real model produced 2 to 3 validated insights per run (benchmark below). A source that does not exist produces a limitation ("No insulin records exist, so no link to insulin is described"), never a claim.
The per-run payload is small (about 850 to 1,260 prompt tokens). Lows appear only in the retrospective digest; they are never event insights. Set `users.profile.insights.mode = "full"` to also get the whole-window statistics (overnight/day summary, baseline, morning rise).

## 3. Workflows

- **Morning** (default 07:00 local, user timezone): overnight summary (window 22:00 to wake, coverage + min/max/mean + time-in-range + excursions + comparison with usual
  nights if >= 5), recurring morning rise (>= 5 comparable mornings, >= 60% showing a >= 30 mg/dL rise), previous-evening recorded events, current forecast with its interval
  (a lower bound under 70 is worded "a possible bound, not the predicted value"), sleep association only with >= 7 paired nights and |r| >= 0.5, data quality.
- **Evening** (default 21:00): day-to-date statistics, comparison with baseline (>= 5 prior well-covered days; 10 points of time-in-range or 15% mean), significant excursions,
  meal responses (top 2), recurring meal-slot response (>= 5 comparable days), exercise and insulin-timing associations (>= 7 pairs), data quality. No "good/bad day" labels.
- **Event** (Python-only detection every 15 min; the model is called only if something new exists): a stay above range peaking >= 40 mg/dL over the high threshold,
  a completed post-meal rise, or a data-quality problem. **Lows are never an event insight**: real-time lows belong to the existing alert system. Cooldown 120 min per category;
  a growing event is not re-announced inside the cooldown (the evening recap carries the update).

Thresholds: low 70 mg/dL (existing app constant), high 180 mg/dL default; both overridable per user in `users.profile.insights` (`low_mgdl`, `high_mgdl`, `wake`, `recap`, `overnight_start`);
invalid values are ignored. They are reporting thresholds only. All other thresholds and their rationale are in `config.py`.

## 4. Evidence requirements (config.py, each with a stated reason)

coverage >= 60% (overnight) / 70% (day) / 80% (post-meal) of the window; >= 12 readings for a summary; one reading vouches for <= 15 min; stale > 20 min (same as the backend);
plausible 20 to 600 mg/dL; sensor-artefact rate > 10 mg/dL/min (same as the forecast service); recurring needs >= 5 comparable days and >= 60% recurrence; associations need >= 7 pairs and |r| >= 0.5.

## 5. LLM contract

Prompt `insight-explain-v1` is in `llm.py` (`SYSTEM_PROMPT`, exactly the specified safety text plus the I/O format). Input per candidate: `insight_id`, `category`, Python `claims`
with `[E#]` tags (these carry every verified number), `refs` (the tags that may be cited), `boundaries`, `limitations`, optional `interval_level_percent`, and `untrusted_notes` (data, truncated).
The full facts table (ref, name, value, unit, kind) stays on the Python side for validation and storage; sending it too only inflated the prompt (measured: -34% prompt tokens without it). Output (strict JSON, enforced
by the server grammar **and** re-checked by `validate.check_schema`):

```json
{"results":[{"schema_version":"insight-explain-v1","insight_id":"I1","explanation":"<=300 chars, 2 short sentences",
             "evidence_refs":["E2"],"limitation":null,"insufficient_evidence":false}]}
```
Temperature 0, seed fixed, thinking off, `max_tokens = 60 + 170 x candidates` (cap 900). No chain of thought is requested or stored.

## 6. Validation rules (validate.py)

Schema and lengths; id match; every evidence ref exists; **every number in the text exists in that candidate's evidence or claims, with a matching unit**; `%` interval level equals the forecast's own
level; mmol/L rejected; missing-data statements must agree with the availability assessment (both directions); direction words must not contradict a rise/fall finding; any 4-word run copied from
user free text is rejected; dose advice, pre-bolus talk, diagnoses (insulin resistance, basal adequacy, ...), reassurance, "ignore the alert", causal wording, good/bad verdicts and future predictions
are rejected; duplicate explanations rejected. On failure: one corrective retry for that item (only if the model answered; never after a timeout), then the Python text. Lexical rules are a backstop and will miss paraphrases:
the structural checks and the fact that the model never supplies numbers or evidence are the main defence.

## 7. Scheduling, deduplication, persistence

`cli tick` runs every 15 min (timer, **not enabled**), computes due kinds per user in their timezone (window: 6 h after the scheduled time), always checks events, exits. Run key =
`morning|evening:<local date>` or `event:<date>:<15-min bucket>`; `claim_run` makes retries safe (complete -> skipped, failed or 30-min-stale running -> re-claimable, running -> busy);
a file lock prevents overlapping passes. Dedupe key = category + window bucket; `facts_hash` identifies "the same finding"; a delivered finding is re-issued (content_version + 1, `supersedes_insight_id`,
old row `superseded`) only if its numbers moved >= 15%. Stored rows are never rewritten (the app role cannot update evidence/content). Scheduled insights expire after 30 h, events after 6 h.
Logs and the journal contain counts, categories and timings only; `--show` prints content for local debugging and is not used by the units.

## 8. Tests

`PYTHONPATH=.:tests python3 -m unittest discover -s tests` (stdlib only; 99 tests, synthetic data only) covers every scenario in the brief. `tests/integration_pg.py` exercises the Postgres adapter, store,
privileges and idempotency against a TEST database. `benchmark/run_benchmark.py` measures the real model on synthetic payloads with live production-health monitoring that stops the model container if
the forecast or backend degrades. See `BENCHMARK.md` for the measured numbers. Synthetic tests do not establish clinical safety.

## 9. Rollout (nothing below has been done)

1. Review the code; apply `backend/db/migrations/0010_insights.sql` with the normal runner (additive: two new tables, least-privilege grants).
2. Install: `python3 -m venv ~/sugarsense-insights/venv && pip install -r requirements.txt`, copy `sugarsense_insights/`, create `/etc/sugarsense-insights.env` (mode 640) with only `DATABASE_URL` (app role) and `INSIGHTS_LLM_URL=http://127.0.0.1:8181`.
3. Dry run first: `python -m sugarsense_insights run evening --all-users --no-llm --dry-run` (writes nothing).
4. Copy the three unit files from `systemd/`, `systemctl daemon-reload`, start `sugarsense-llm`, run one `tick` by hand, check `journalctl`, then enable the timer.
5. The API: `GET /insights` is implemented in the NestJS backend (`backend/src/insights`, contract in its README; read-only, rate limited, optional `X-App-Token`). To expose it on the web site run `nginx/add-insights-route.sh` (backs up the site file, tests, reloads, restores on failure); the :80 gateway already forwards it. Until migration 0010 is applied the route answers `503 unavailable`, so deploying the backend first is safe. Order: apply 0010, push the backend (auto-deploy), run the nginx script, start `sugarsense-llm`, run one `tick` by hand, then enable the timer. Rollback: `systemctl disable --now sugarsense-insights-tick.timer sugarsense-llm`; the tables can stay.

## 10. Known limitations

- Roughly 5 days of history and no sleep/activity/wearable rows: most recurring and association insights will not fire yet, by design.
- Latency is dominated by token generation on a CPU: expect on the order of a minute or two per batch (see BENCHMARK.md); never put it behind a spinner.
- The validator proves numbers, units, refs and many wording rules; it cannot prove every sentence is a faithful paraphrase. A clinician review of real outputs has not been done.
- `morning rise` and `meal response` definitions are simple windows, not clinical definitions; thresholds are defaults to be reviewed against the user's prescribed targets.
- DST: local windows use zoneinfo (tested for the November fall-back night); an unknown timezone name falls back to UTC rather than guessing.
- Event detection polls every 15 min; very short events can be missed. This is deliberate: it is not an alerting channel.
