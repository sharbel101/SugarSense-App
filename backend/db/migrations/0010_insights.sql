-- 0010: insight engine storage (backend/insights, a separate Python batch worker). Additive only. NOT applied by this change.
--  * insight_runs: one row per (user, run_key). The run_key makes a job idempotent: a retry of the same morning / evening
--    run (or of the same event) finds the finished row and does nothing.
--  * insights: what was generated. A finding changes by writing a NEW row (content_version + 1, supersedes_insight_id set)
--    and marking the old one 'superseded'; the evidence and the rendered content are never rewritten after insert.
-- The engine reads existing tables read-only and only ever writes these two. It never touches glucose, event, forecast or alert tables.

CREATE TABLE insight_runs (
  run_id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  run_key          text NOT NULL CHECK (length(run_key) BETWEEN 1 AND 200),   -- e.g. morning:2026-10-21 / event:<dedupe_key>
  kind             text NOT NULL CHECK (kind IN ('morning','evening','event')),
  status           text NOT NULL CHECK (status IN ('running','complete','failed')),
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  engine_version   text NOT NULL,
  prompt_version   text,
  model_version    text,
  stats            jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(stats) = 'object'),  -- latency, token counts, validation failures, fallbacks; no health payloads
  CONSTRAINT insight_runs_key_uq UNIQUE (user_id, run_key)
);
CREATE INDEX insight_runs_user_started_idx ON insight_runs (user_id, started_at DESC);

CREATE TABLE insights (
  insight_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  run_id                bigint REFERENCES insight_runs(run_id) ON DELETE RESTRICT,
  category              text NOT NULL CHECK (length(category) BETWEEN 1 AND 40),
  trigger               text NOT NULL CHECK (trigger IN ('morning','evening','event')),
  dedupe_key            text NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 200),
  facts_hash            text NOT NULL CHECK (length(facts_hash) >= 16),      -- hash of the rounded evidence values: "same finding?"
  content_version       integer NOT NULL DEFAULT 1 CHECK (content_version >= 1),
  supersedes_insight_id uuid REFERENCES insights(insight_id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  observation_start     timestamptz NOT NULL,
  observation_end       timestamptz NOT NULL,
  priority              numeric(6,3) NOT NULL,
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','expired','suppressed')),
  validation_status     text NOT NULL CHECK (validation_status IN ('valid','fallback','not_applicable')),
  evidence              jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),  -- facts with refs, window, coverage, quality flags, method, boundaries
  content               jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object'),   -- rendered text: python-written claims + validated explanation
  expires_at            timestamptz,
  CONSTRAINT insights_window_ck CHECK (observation_end >= observation_start),
  CONSTRAINT insights_version_uq UNIQUE (user_id, dedupe_key, content_version)
);
CREATE INDEX insights_user_created_idx ON insights (user_id, created_at DESC);
CREATE INDEX insights_user_active_idx ON insights (user_id, status, priority DESC) WHERE status = 'active';
CREATE TRIGGER insights_updated_at BEFORE UPDATE ON insights FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- least privilege, same pattern as 0004/0006: SELECT+INSERT; the worker may only change the lifecycle columns.
GRANT SELECT, INSERT ON insight_runs, insights TO sugarsense_app;
GRANT UPDATE (status, started_at, finished_at, stats, engine_version, prompt_version, model_version) ON insight_runs TO sugarsense_app;  -- a failed/stale run may be re-claimed
GRANT UPDATE (status, expires_at, updated_at) ON insights TO sugarsense_app;
