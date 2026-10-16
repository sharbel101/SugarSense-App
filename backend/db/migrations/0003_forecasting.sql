-- 0003: predictions (immutable), outcomes (immutable), parameter versions, performance.
-- A prediction row is never updated or deleted; its outcome is a separate row (CLAUDE.md section 3.4).

CREATE TABLE predictions (
  prediction_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  created_at         timestamptz NOT NULL DEFAULT now(),
  anchor_at          timestamptz NOT NULL,                  -- t0: time of the last reading used
  target_at          timestamptz NOT NULL,
  horizon_min        smallint NOT NULL CHECK (horizon_min > 0 AND horizon_min <= 480),
  predicted_mgdl     numeric(5,1) NOT NULL CHECK (predicted_mgdl BETWEEN 20 AND 600),
  lower_mgdl         numeric(5,1) NOT NULL,
  upper_mgdl         numeric(5,1) NOT NULL,
  interval_level     numeric(3,2) NOT NULL DEFAULT 0.80 CHECK (interval_level > 0 AND interval_level < 1),
  model_version      text NOT NULL CHECK (length(model_version) > 0),
  parameter_version  text NOT NULL CHECK (length(parameter_version) > 0),
  input_snapshot     jsonb NOT NULL CHECK (jsonb_typeof(input_snapshot) = 'object'),
  CONSTRAINT predictions_bounds_ck CHECK (lower_mgdl <= predicted_mgdl AND predicted_mgdl <= upper_mgdl),
  CONSTRAINT predictions_target_ck CHECK (target_at = anchor_at + horizon_min * interval '1 minute'),
  CONSTRAINT predictions_dedupe UNIQUE (user_id, model_version, anchor_at, horizon_min)
);
CREATE INDEX predictions_user_target_idx ON predictions (user_id, target_at DESC);
CREATE INDEX predictions_model_idx ON predictions (model_version, horizon_min);
CREATE TRIGGER predictions_append_only BEFORE UPDATE OR DELETE ON predictions
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE TABLE prediction_outcomes (
  outcome_id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  prediction_id      uuid NOT NULL UNIQUE REFERENCES predictions(prediction_id) ON DELETE RESTRICT,
  reading_id         bigint REFERENCES glucose_readings(reading_id) ON DELETE RESTRICT,
  observed_mgdl      numeric(5,1) NOT NULL CHECK (observed_mgdl BETWEEN 20 AND 600),
  observed_at        timestamptz NOT NULL,
  signed_error_mgdl  numeric(6,1) NOT NULL,                 -- observed minus predicted
  abs_error_mgdl     numeric(6,1) NOT NULL CHECK (abs_error_mgdl >= 0),
  within_interval    boolean,
  match_offset_sec   integer NOT NULL,                      -- observed_at minus target_at
  matching_quality   text NOT NULL CHECK (matching_quality IN ('exact','nearest_within_tolerance','interpolated')),
  scored_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prediction_outcomes_abs_ck CHECK (abs_error_mgdl = abs(signed_error_mgdl))
);
CREATE INDEX prediction_outcomes_reading_idx ON prediction_outcomes (reading_id);
CREATE TRIGGER prediction_outcomes_append_only BEFORE UPDATE OR DELETE ON prediction_outcomes
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- One row per (user, name, version); a new fit is a new version, history is kept.
-- user_id NULL = population prior.
CREATE TABLE model_parameters (
  parameter_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         uuid REFERENCES users(user_id) ON DELETE RESTRICT,
  name            text NOT NULL CHECK (length(btrim(name)) > 0),
  version         integer NOT NULL CHECK (version >= 1),
  value           numeric(12,6) NOT NULL,
  lower_bound     numeric(12,6) NOT NULL,
  upper_bound     numeric(12,6) NOT NULL,
  uncertainty_sd  numeric(12,6) CHECK (uncertainty_sd >= 0),   -- NULL = unknown
  evidence_count  integer NOT NULL DEFAULT 0 CHECK (evidence_count >= 0),
  status          text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','active','retired')),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT model_parameters_bounds_ck CHECK (lower_bound <= value AND value <= upper_bound),
  CONSTRAINT model_parameters_version_uq UNIQUE NULLS NOT DISTINCT (user_id, name, version)
);
CREATE INDEX model_parameters_user_idx ON model_parameters (user_id, name, version DESC);
CREATE TRIGGER model_parameters_updated_at BEFORE UPDATE ON model_parameters
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE model_performance (
  performance_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  evaluated_at       timestamptz NOT NULL DEFAULT now(),
  user_id            uuid REFERENCES users(user_id) ON DELETE RESTRICT,   -- NULL = pooled over users
  model_version      text NOT NULL,
  horizon_min        smallint NOT NULL CHECK (horizon_min > 0),
  window_start       timestamptz NOT NULL,
  window_end         timestamptz NOT NULL,
  sample_count       integer NOT NULL CHECK (sample_count >= 0),
  mae_mgdl           numeric(6,2) CHECK (mae_mgdl >= 0),       -- NULL when sample_count = 0
  rmse_mgdl          numeric(6,2) CHECK (rmse_mgdl >= 0),
  bias_mgdl          numeric(6,2),                             -- signed (observed minus predicted)
  interval_coverage  numeric(4,3) CHECK (interval_coverage BETWEEN 0 AND 1),
  nominal_coverage   numeric(3,2) CHECK (nominal_coverage > 0 AND nominal_coverage < 1),
  CONSTRAINT model_performance_window_ck CHECK (window_end > window_start),
  CONSTRAINT model_performance_dedupe UNIQUE NULLS NOT DISTINCT (user_id, model_version, horizon_min, window_end)
);
CREATE INDEX model_performance_model_idx ON model_performance (model_version, horizon_min, evaluated_at DESC);
