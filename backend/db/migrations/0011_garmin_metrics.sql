-- 0011: Garmin wearable metrics polled from the Garmin MCP gateway (garmin-service/).
-- Tables: garmin_observations (one row per measurement / interval / daily summary), garmin_poll_runs (one row per job run, for the status API),
-- garmin_job_state (when each job last ran and is next due; also one '_worker' row holding the worker heartbeat).
-- Semantics (see garmin-service/README.md): measured_at is UTC; ts_semantics says what that instant means; kind says what the value is
-- (a sample, an interval aggregate, a running day total, a daily summary or an event). Cumulative values are stored as returned, never summed.
-- Missing is missing: there are no zero placeholders. Roles garmin_svc (read/write) and garmin_ro (read only) are created by ops, not here
-- (a migration must not carry passwords); the grants below apply only if they already exist.

CREATE TABLE garmin_observations (
  id               bigserial PRIMARY KEY,
  metric           text        NOT NULL,
  kind             text        NOT NULL CHECK (kind IN ('instant', 'interval', 'cumulative', 'daily_summary', 'event')),
  measured_at      timestamptz NOT NULL,
  ts_semantics     text        NOT NULL CHECK (ts_semantics IN ('instant', 'interval_start', 'period_start', 'period_end')),
  interval_s       integer     CHECK (interval_s IS NULL OR interval_s > 0),
  value_num        double precision,
  value_json       jsonb,
  unit             text,
  period           text,
  period_date      date,
  source_tool      text        NOT NULL,
  origin           text        NOT NULL CHECK (origin IN ('raw_sensor', 'garmin_derived')),
  fetched_at       timestamptz NOT NULL,
  first_fetched_at timestamptz NOT NULL,
  revisions        integer     NOT NULL DEFAULT 0,
  meta             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT garmin_obs_has_value CHECK (value_num IS NOT NULL OR value_json IS NOT NULL),
  CONSTRAINT garmin_obs_idempotent UNIQUE (metric, measured_at, source_tool)
);
CREATE INDEX garmin_obs_metric_time ON garmin_observations (metric, measured_at DESC, id DESC);
CREATE INDEX garmin_obs_time ON garmin_observations (measured_at DESC);

CREATE TABLE garmin_poll_runs (
  id          bigserial PRIMARY KEY,
  job         text        NOT NULL,
  started_at  timestamptz NOT NULL,
  finished_at timestamptz,
  outcome     text        NOT NULL CHECK (outcome IN ('ok', 'empty', 'unchanged', 'partial', 'error', 'rate_limited', 'needs_login', 'auth_failed', 'blocked', 'schema_drift')),
  requests    integer     NOT NULL DEFAULT 0,
  cache_hits  integer     NOT NULL DEFAULT 0,
  rows_seen   integer     NOT NULL DEFAULT 0,
  rows_new    integer     NOT NULL DEFAULT 0,
  latest_measured_at timestamptz,
  error_class text,
  error_text  text,
  duration_ms integer
);
CREATE INDEX garmin_poll_runs_job_time ON garmin_poll_runs (job, started_at DESC);
CREATE INDEX garmin_poll_runs_time ON garmin_poll_runs (started_at DESC);

CREATE TABLE garmin_job_state (
  job                  text PRIMARY KEY,
  last_attempt_at      timestamptz,
  last_success_at      timestamptz,
  last_new_data_at     timestamptz,
  last_measured_at     timestamptz,
  last_outcome         text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  slot_key             text,
  slot_attempts        integer NOT NULL DEFAULT 0,
  extra                jsonb   NOT NULL DEFAULT '{}'::jsonb,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'garmin_svc') THEN
    GRANT SELECT, INSERT, UPDATE ON garmin_observations, garmin_job_state TO garmin_svc;
    GRANT SELECT, INSERT, UPDATE, DELETE ON garmin_poll_runs TO garmin_svc;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO garmin_svc;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'garmin_ro') THEN
    GRANT SELECT ON garmin_observations, garmin_poll_runs, garmin_job_state TO garmin_ro;
  END IF;
END
$$;
