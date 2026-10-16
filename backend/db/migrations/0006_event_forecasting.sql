-- 0006: everything the meal-aware forecasting layer needs to store.
--   * versioned therapy settings (ICR and ISF by time of day), never overwritten
--   * provenance / timing / revision columns on meals and insulin
--   * a "planned" insulin state that can never count as a delivered dose
--   * forecast runs (immutable) + the settings and events each prediction used
--   * parameter and performance bookkeeping for recursive personalisation
-- Additive only: no existing data is touched, no table is dropped.

-- ---------------------------------------------------------------------------------------------
-- Therapy settings: clinician-supplied priors. A change is a NEW version; old versions stay.
-- ICR = grams of carbohydrate covered by 1 unit of rapid-acting insulin.
-- ISF = mg/dL lowered by 1 unit of rapid-acting insulin.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE therapy_profiles (
  profile_id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id               uuid NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  version               integer NOT NULL CHECK (version >= 1),
  effective_from        timestamptz NOT NULL,
  source                text NOT NULL CHECK (source IN ('clinician_prescribed','user_entered','import')),
  insulin_type          text CHECK (insulin_type IN ('rapid','ultra_rapid')),           -- NULL = not stated
  insulin_peak_min      numeric(5,1) CHECK (insulin_peak_min BETWEEN 35 AND 120),        -- NULL = type default
  insulin_duration_min  numeric(5,1) CHECK (insulin_duration_min BETWEEN 300 AND 480),   -- NULL = type default
  note                  text CHECK (length(note) <= 500),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT therapy_profiles_version_uq UNIQUE (user_id, version)
);
CREATE INDEX therapy_profiles_user_effective_idx ON therapy_profiles (user_id, effective_from DESC, version DESC);

CREATE TABLE therapy_segments (
  profile_id    bigint NOT NULL REFERENCES therapy_profiles(profile_id) ON DELETE RESTRICT,
  kind          text NOT NULL CHECK (kind IN ('icr','isf')),
  start_minute  smallint NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),   -- minutes after LOCAL midnight
  value         numeric(7,2) NOT NULL,
  PRIMARY KEY (profile_id, kind, start_minute),
  CONSTRAINT therapy_segments_range_ck CHECK (
    (kind = 'icr' AND value BETWEEN 1 AND 150) OR (kind = 'isf' AND value BETWEEN 5 AND 500))
);

CREATE TRIGGER therapy_profiles_append_only BEFORE UPDATE OR DELETE ON therapy_profiles
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER therapy_segments_append_only BEFORE UPDATE OR DELETE ON therapy_segments
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------------------------------------
-- Meals: where the carbohydrate number came from, how sure the timing is, how it is absorbed.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE meal_events
  ADD COLUMN carbs_provenance      text CHECK (carbs_provenance IN ('estimated','user_corrected','user_entered')),
  ADD COLUMN eaten_at_source       text NOT NULL DEFAULT 'user_entered'
                                     CHECK (eaten_at_source IN ('user_entered','photo_time','assumed')),
  ADD COLUMN timing_uncertainty_min smallint NOT NULL DEFAULT 0 CHECK (timing_uncertainty_min BETWEEN 0 AND 120),
  ADD COLUMN absorption_class      text NOT NULL DEFAULT 'medium' CHECK (absorption_class IN ('fast','medium','slow')),
  ADD COLUMN revision              integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  -- carbs unknown <=> no provenance: an unknown number never wears a label that suggests it is known
  ADD CONSTRAINT meal_events_provenance_ck CHECK ((carbs_g IS NULL) = (carbs_provenance IS NULL));

-- ---------------------------------------------------------------------------------------------
-- Insulin: a planned dose is not a delivered dose.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE insulin_events DROP CONSTRAINT insulin_events_confirmation_check;
ALTER TABLE insulin_events
  ADD CONSTRAINT insulin_events_confirmation_check CHECK (confirmation IN ('confirmed','uncertain','planned')),
  ADD CONSTRAINT insulin_events_planned_no_dose_ck CHECK (confirmation <> 'planned' OR units_administered IS NULL),
  ADD COLUMN revision         integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  ADD COLUMN timing_uncertain boolean NOT NULL DEFAULT false;

-- Every edit of a meal or insulin event, as before/after snapshots. Append-only.
CREATE TABLE event_revisions (
  revision_id  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_type  text NOT NULL CHECK (entity_type IN ('meal','insulin')),
  entity_id    uuid NOT NULL,
  revision     integer NOT NULL CHECK (revision >= 1),
  changed_at   timestamptz NOT NULL DEFAULT now(),
  reason       text CHECK (length(reason) <= 200),
  before_state jsonb NOT NULL,
  after_state  jsonb NOT NULL,
  CONSTRAINT event_revisions_uq UNIQUE (entity_type, entity_id, revision)
);
CREATE TRIGGER event_revisions_append_only BEFORE UPDATE OR DELETE ON event_revisions
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------------------------------------
-- Forecast runs: one immutable row per distinct (anchor, inputs). The full trajectory and the full
-- normalised inputs live here so a forecast can be replayed byte-for-byte later.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE forecast_runs (
  run_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),
  anchor_at         timestamptz NOT NULL,
  inputs_hash       text NOT NULL CHECK (length(inputs_hash) >= 16),
  baseline_model    text NOT NULL,
  layer_version     text NOT NULL,
  parameter_version text NOT NULL,
  feature_config    text NOT NULL CHECK (feature_config IN ('glucose_only','meal+insulin','meal_only','insulin_only')),
  therapy_profile_id bigint REFERENCES therapy_profiles(profile_id) ON DELETE RESTRICT,
  icr_status        text NOT NULL CHECK (icr_status IN ('available','unavailable')),
  trajectory        jsonb NOT NULL CHECK (jsonb_typeof(trajectory) = 'array'),
  input_snapshot    jsonb NOT NULL CHECK (jsonb_typeof(input_snapshot) = 'object'),
  CONSTRAINT forecast_runs_dedupe UNIQUE (user_id, anchor_at, inputs_hash)
);
CREATE INDEX forecast_runs_user_anchor_idx ON forecast_runs (user_id, anchor_at DESC);
CREATE TRIGGER forecast_runs_append_only BEFORE UPDATE OR DELETE ON forecast_runs
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Settings and feature availability each prediction row was made with (history is never rewritten
-- when the ICR changes: the value used is copied here, not looked up later).
ALTER TABLE predictions
  ADD COLUMN run_id              uuid REFERENCES forecast_runs(run_id) ON DELETE RESTRICT,
  ADD COLUMN feature_config      text NOT NULL DEFAULT 'glucose_only'
                                   CHECK (feature_config IN ('glucose_only','meal+insulin','meal_only','insulin_only')),
  ADD COLUMN inputs_hash         text NOT NULL DEFAULT '',
  ADD COLUMN therapy_profile_id  bigint REFERENCES therapy_profiles(profile_id) ON DELETE RESTRICT,
  ADD COLUMN icr_status          text NOT NULL DEFAULT 'unavailable' CHECK (icr_status IN ('available','unavailable')),
  ADD COLUMN icr_g_per_u         numeric(7,2) CHECK (icr_g_per_u BETWEEN 1 AND 150),
  ADD COLUMN isf_mgdl_per_u      numeric(7,2) CHECK (isf_mgdl_per_u BETWEEN 5 AND 500);
ALTER TABLE predictions DROP CONSTRAINT predictions_dedupe;
ALTER TABLE predictions ADD CONSTRAINT predictions_dedupe
  UNIQUE (user_id, model_version, anchor_at, horizon_min, inputs_hash);
CREATE INDEX predictions_run_idx ON predictions (run_id);

-- Which events each run used and in what role (applied to the mean, scenario-only, ignored, excluded).
CREATE TABLE prediction_event_links (
  link_id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id           uuid NOT NULL REFERENCES forecast_runs(run_id) ON DELETE RESTRICT,
  meal_id          uuid REFERENCES meal_events(meal_id) ON DELETE RESTRICT,
  insulin_id       uuid REFERENCES insulin_events(insulin_id) ON DELETE RESTRICT,
  role             text NOT NULL CHECK (role IN ('applied','scenario_only','ignored','excluded')),
  role_reason      text CHECK (length(role_reason) <= 120),
  event_time       timestamptz NOT NULL,
  event_revision   integer NOT NULL,
  carbs_g          numeric(6,1),                                           -- NULL = unknown
  carbs_provenance text CHECK (carbs_provenance IN ('estimated','user_corrected','user_entered')),
  insulin_units    numeric(5,2),                                           -- NULL = unknown / not delivered
  insulin_confirmation text CHECK (insulin_confirmation IN ('confirmed','uncertain','planned')),
  link_type        text CHECK (link_type IN ('declared','auto_time_window','none_recorded','confirmed_none','ambiguous')),
  linked_insulin_id uuid REFERENCES insulin_events(insulin_id) ON DELETE RESTRICT,
  coverage_g       numeric(7,1),                                           -- units x ICR (analysis feature only)
  carbs_minus_coverage_g numeric(7,1),
  CONSTRAINT prediction_event_links_one_event_ck CHECK ((meal_id IS NULL) <> (insulin_id IS NULL))
);
CREATE INDEX prediction_event_links_run_idx ON prediction_event_links (run_id);
CREATE TRIGGER prediction_event_links_append_only BEFORE UPDATE OR DELETE ON prediction_event_links
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- ---------------------------------------------------------------------------------------------
-- Parameters and performance bookkeeping.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE model_parameters
  ADD COLUMN source text NOT NULL DEFAULT 'fit' CHECK (source IN ('prior','fit','rollback','manual')),
  ADD COLUMN note   text CHECK (length(note) <= 300);

ALTER TABLE model_performance
  ADD COLUMN feature_config text NOT NULL DEFAULT 'all';
ALTER TABLE model_performance DROP CONSTRAINT model_performance_dedupe;
ALTER TABLE model_performance ADD CONSTRAINT model_performance_dedupe
  UNIQUE NULLS NOT DISTINCT (user_id, model_version, feature_config, horizon_min, window_end);

-- ---------------------------------------------------------------------------------------------
-- Grants for the application role (same least-privilege shape as 0004).
-- ---------------------------------------------------------------------------------------------
GRANT SELECT, INSERT ON therapy_profiles, therapy_segments, event_revisions, forecast_runs,
  prediction_event_links TO sugarsense_app;
