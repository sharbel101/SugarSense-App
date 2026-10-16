-- 0002: meals (+ items, + corrections), insulin, activity, sleep.
-- NULL always means "unknown / not provided"; a confirmed zero is stored as 0.

CREATE TABLE meal_events (
  meal_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  client_uuid         uuid NOT NULL,                       -- generated on the phone; makes retries idempotent
  eaten_at            timestamptz NOT NULL,
  utc_offset_minutes  smallint CHECK (utc_offset_minutes BETWEEN -840 AND 840),
  status              text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','confirmed','manual_entry','cancelled')),
  -- final values (what the user confirmed). NULL = unknown.
  carbs_g             numeric(6,1) CHECK (carbs_g BETWEEN 0 AND 400),
  carbs_sigma_g       numeric(6,1) CHECK (carbs_sigma_g >= 0),
  fat_g               numeric(6,1) CHECK (fat_g >= 0),
  protein_g           numeric(6,1) CHECK (protein_g >= 0),
  fiber_g             numeric(6,1) CHECK (fiber_g >= 0),
  glycemic_index      smallint CHECK (glycemic_index BETWEEN 0 AND 100),
  gi_confidence       text CHECK (gi_confidence IN ('low','medium')),
  -- photo analysis, stored exactly as the model returned it (never edited afterwards)
  analysis_status     text CHECK (analysis_status IN ('ok','no_food_detected','needs_manual_entry')),
  ai_carbs_g          numeric(6,1) CHECK (ai_carbs_g BETWEEN 0 AND 400),
  ai_carbs_low_g      numeric(6,1) CHECK (ai_carbs_low_g >= 0),
  ai_carbs_high_g     numeric(6,1) CHECK (ai_carbs_high_g >= 0),
  ai_confidence       text CHECK (ai_confidence IN ('low','medium','high')),
  model_version       text,
  prompt_version      text,
  analysis_raw        jsonb CHECK (analysis_raw IS NULL OR jsonb_typeof(analysis_raw) = 'object'),
  user_edited         boolean NOT NULL DEFAULT false,
  note                text CHECK (length(note) <= 500),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meal_events_client_uuid_uq UNIQUE (user_id, client_uuid),
  CONSTRAINT meal_events_ai_range_ck CHECK (ai_carbs_low_g IS NULL OR ai_carbs_high_g IS NULL OR ai_carbs_low_g <= ai_carbs_high_g),
  CONSTRAINT meal_events_confirmed_has_carbs_ck CHECK (status <> 'confirmed' OR carbs_g IS NOT NULL)
);
CREATE TRIGGER meal_events_updated_at BEFORE UPDATE ON meal_events FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX meal_events_user_time_idx ON meal_events (user_id, eaten_at DESC);

CREATE TABLE meal_items (
  item_id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  meal_id              uuid NOT NULL REFERENCES meal_events(meal_id) ON DELETE CASCADE,
  position             smallint NOT NULL CHECK (position >= 0),
  name                 text NOT NULL CHECK (length(btrim(name)) > 0),
  portion_description  text,
  estimated_grams      numeric(7,1) CHECK (estimated_grams >= 0),
  carbs_g              numeric(6,1) CHECK (carbs_g >= 0),
  calories_kcal        numeric(7,1) CHECK (calories_kcal >= 0),
  confidence           text CHECK (confidence IN ('low','medium','high')),
  from_ai              boolean NOT NULL DEFAULT false,
  CONSTRAINT meal_items_position_uq UNIQUE (meal_id, position)
);

-- Every user correction of an AI estimate (CLAUDE.md section 9: capture from day one). Append-only.
CREATE TABLE meal_corrections (
  correction_id  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  meal_id        uuid NOT NULL REFERENCES meal_events(meal_id) ON DELETE CASCADE,
  corrected_at   timestamptz NOT NULL DEFAULT now(),
  field          text NOT NULL CHECK (length(field) BETWEEN 1 AND 64),
  item_position  smallint,
  old_value      numeric(8,1),
  new_value      numeric(8,1),
  old_text       text,
  new_text       text
);
CREATE INDEX meal_corrections_meal_idx ON meal_corrections (meal_id, corrected_at);
CREATE TRIGGER meal_corrections_no_update BEFORE UPDATE ON meal_corrections
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE TABLE insulin_events (
  insulin_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  client_uuid         uuid NOT NULL,
  administered_at     timestamptz NOT NULL,
  utc_offset_minutes  smallint CHECK (utc_offset_minutes BETWEEN -840 AND 840),
  kind                text NOT NULL CHECK (kind IN ('bolus','correction','basal','other')),
  insulin_type        text CHECK (length(insulin_type) BETWEEN 1 AND 64),   -- e.g. rapid, long; NULL = unknown
  -- Suggestion is not a dose (CLAUDE.md section 2): separate columns, neither derived from the other.
  units_administered  numeric(5,2) CHECK (units_administered >= 0),         -- NULL = unknown, 0 = confirmed none
  units_suggested     numeric(5,2) CHECK (units_suggested >= 0),
  suggestion_accepted boolean,
  source              text NOT NULL CHECK (source IN ('manual','pump','pen','import')),
  confirmation        text NOT NULL DEFAULT 'uncertain' CHECK (confirmation IN ('confirmed','uncertain')),
  meal_id             uuid REFERENCES meal_events(meal_id) ON DELETE SET NULL,
  external_id         text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT insulin_events_client_uuid_uq UNIQUE (user_id, client_uuid),
  CONSTRAINT insulin_events_confirmed_has_dose_ck CHECK (confirmation <> 'confirmed' OR units_administered IS NOT NULL)
);
CREATE TRIGGER insulin_events_updated_at BEFORE UPDATE ON insulin_events FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE UNIQUE INDEX insulin_events_external_id_uq
  ON insulin_events (user_id, source, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX insulin_events_user_time_idx ON insulin_events (user_id, administered_at DESC);

CREATE TABLE activity_events (
  activity_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  started_at     timestamptz NOT NULL,
  activity_type  text NOT NULL CHECK (length(btrim(activity_type)) > 0),
  duration_min   numeric(6,1) CHECK (duration_min >= 0),                    -- NULL = unknown
  intensity      text CHECK (intensity IN ('light','moderate','vigorous')),
  steps          integer CHECK (steps >= 0),                                -- NULL = unknown, 0 = none counted
  source         text NOT NULL CHECK (source IN ('manual','wearable','health_connect','healthkit','import')),
  external_id    text,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT activity_events_dedupe UNIQUE (user_id, source, started_at, activity_type)
);
CREATE UNIQUE INDEX activity_events_external_id_uq
  ON activity_events (user_id, source, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX activity_events_user_time_idx ON activity_events (user_id, started_at DESC);

CREATE TABLE sleep_events (
  sleep_id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  started_at       timestamptz NOT NULL,
  ended_at         timestamptz NOT NULL,
  duration_min     integer CHECK (duration_min >= 0),                       -- NULL = unavailable
  quality_score    numeric(3,2) CHECK (quality_score BETWEEN 0 AND 1),      -- NULL = unavailable
  efficiency       numeric(3,2) CHECK (efficiency BETWEEN 0 AND 1),
  source           text NOT NULL CHECK (source IN ('manual','wearable','health_connect','healthkit','import')),
  external_id      text,
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sleep_events_order_ck CHECK (ended_at > started_at),
  CONSTRAINT sleep_events_dedupe UNIQUE (user_id, source, started_at)
);
CREATE UNIQUE INDEX sleep_events_external_id_uq
  ON sleep_events (user_id, source, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX sleep_events_user_time_idx ON sleep_events (user_id, started_at DESC);
