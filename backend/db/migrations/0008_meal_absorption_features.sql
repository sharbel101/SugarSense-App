-- 0008: meal features for glycaemic-response-aware absorption (feature schema "meal-features-v2").
-- Additive only. NULL always means "not provided" (an older meal, an older prompt, a model that omitted the field).
--  * absorption_class_ai / absorption_confidence: the vision model's likely absorption profile for the whole meal and how sure it is.
--    The existing absorption_class (fast / medium / slow) stays what the PERSON chose; the two are never merged in storage.
--  * absorption_class_user: true when the person (not the default) set absorption_class; a person's choice outranks the model's.
--  * glycemic_load: GI x carbohydrate / 100, derived server-side only when GI and the carbohydrate range are reliable enough.
--  * meal_factors: form, carbohydrate quality, preparation, mixed-meal flag as the model reported them.
--  * feature_schema_version: which feature definitions produced the values (the full raw response is already in analysis_raw).

ALTER TABLE meal_events
  ADD COLUMN absorption_class_ai     text CHECK (absorption_class_ai IN ('fast','moderate_fast','moderate_mixed','slow_delayed')),
  ADD COLUMN absorption_confidence   text CHECK (absorption_confidence IN ('low','medium','high')),
  ADD COLUMN glycemic_load           numeric(5,1) CHECK (glycemic_load >= 0),
  ADD COLUMN meal_factors            jsonb CHECK (meal_factors IS NULL OR jsonb_typeof(meal_factors) = 'object'),
  ADD COLUMN feature_schema_version  text CHECK (feature_schema_version IS NULL OR length(feature_schema_version) <= 40),
  ADD COLUMN absorption_class_user   boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT meal_events_absorption_conf_ck CHECK ((absorption_class_ai IS NULL) = (absorption_confidence IS NULL));

-- Meals created before this migration: a class other than the default 'medium' can only have been chosen by the person.
UPDATE meal_events SET absorption_class_user = true WHERE absorption_class <> 'medium';
