-- 0001: users, glucose readings, context features.
-- Conventions (CLAUDE.md section 3): glucose in mg/dL only; timestamptz (UTC) + separately recorded
-- local offset; NULL = unknown/not measured, never a stand-in zero; JSONB only for flexible metadata.

CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Blocks UPDATE and DELETE: used on append-only history tables.
CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: this table is append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END $$;

CREATE TABLE users (
  user_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  timezone    text NOT NULL DEFAULT 'UTC' CHECK (length(timezone) BETWEEN 1 AND 64),  -- IANA name, validated by the app
  profile     jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(profile) = 'object'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE glucose_readings (
  reading_id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id            uuid NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  measured_at        timestamptz NOT NULL,
  utc_offset_minutes smallint CHECK (utc_offset_minutes BETWEEN -840 AND 840),
  glucose_mgdl       numeric(5,1) NOT NULL CHECK (glucose_mgdl BETWEEN 20 AND 600),
  source             text NOT NULL CHECK (source IN ('manual','health_connect','healthkit','cgm','lab')),
  external_id        text,
  sensor_quality     numeric(3,2) CHECK (sensor_quality BETWEEN 0 AND 1),   -- NULL = unknown
  trend              text CHECK (trend IN ('rising_fast','rising','steady','falling','falling_fast')),
  trend_mgdl_per_min numeric(5,2),
  metadata           jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  ingested_at        timestamptz NOT NULL DEFAULT now(),
  -- idempotent ingest: the same source cannot report the same instant twice for a user
  CONSTRAINT glucose_readings_dedupe UNIQUE (user_id, source, measured_at)
);
CREATE UNIQUE INDEX glucose_readings_external_id_uq
  ON glucose_readings (user_id, source, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX glucose_readings_user_time_idx ON glucose_readings (user_id, measured_at DESC);

CREATE TABLE context_features (
  context_id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id              uuid NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  feature_at           timestamptz NOT NULL,
  local_minutes        smallint CHECK (local_minutes BETWEEN 0 AND 1439),   -- minutes since local midnight
  hour_sin             numeric(8,6) CHECK (hour_sin BETWEEN -1 AND 1),
  hour_cos             numeric(8,6) CHECK (hour_cos BETWEEN -1 AND 1),
  is_weekend           boolean,
  hr_mean_bpm          numeric(5,1) CHECK (hr_mean_bpm BETWEEN 20 AND 260),
  hr_rest_delta_bpm    numeric(5,1),
  hrv_rmssd_ms         numeric(6,1) CHECK (hrv_rmssd_ms >= 0),
  activity_load_2h     numeric(8,2) CHECK (activity_load_2h >= 0),
  skin_temp_delta_c    numeric(4,2),
  wearable_coverage    numeric(3,2) CHECK (wearable_coverage BETWEEN 0 AND 1), -- 0 = no coverage (a fact); NULL = not computed
  metadata             jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT context_features_dedupe UNIQUE (user_id, feature_at)
);
CREATE INDEX context_features_user_time_idx ON context_features (user_id, feature_at DESC);
