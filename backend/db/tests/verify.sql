-- Constraint / permission checks. Run as a superuser (it only creates a throwaway helper function, then
-- SET ROLE sugarsense_app so every check runs with the application role privileges). All rolled back.
--   sudo -u postgres psql -d sugarsense -X -v ON_ERROR_STOP=1 -f db/tests/verify.sql
-- Each check prints PASS or FAIL. A FAIL aborts the script with an error.
\set ON_ERROR_STOP on
BEGIN;
SET client_min_messages = notice;


-- expect(label, sql, sqlstate): runs sql, passes only if it raises that SQLSTATE ('OK' = must succeed)
CREATE FUNCTION public.t_expect(label text, stmt text, want text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE got text := 'OK';
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN
    got := SQLSTATE;
  END;
  IF got = want THEN
    RAISE NOTICE 'PASS  %', label;
  ELSE
    RAISE EXCEPTION 'FAIL  % (wanted %, got %)', label, want, got;
  END IF;
END $$;

SET LOCAL ROLE sugarsense_app;
INSERT INTO users (timezone) VALUES ('Asia/Beirut') RETURNING user_id \gset u_
\echo user created

SELECT public.t_expect('insert glucose reading', format($q$INSERT INTO glucose_readings (user_id, measured_at, glucose_mgdl, source, sensor_quality) VALUES (%L, '2026-10-16T08:00:00Z', 110.5, 'cgm', NULL)$q$, :'u_user_id'), 'OK');
SELECT public.t_expect('duplicate reading rejected (idempotency)', format($q$INSERT INTO glucose_readings (user_id, measured_at, glucose_mgdl, source) VALUES (%L, '2026-10-16T08:00:00Z', 111, 'cgm')$q$, :'u_user_id'), '23505');
SELECT public.t_expect('implausible glucose rejected', format($q$INSERT INTO glucose_readings (user_id, measured_at, glucose_mgdl, source) VALUES (%L, '2026-10-16T08:05:00Z', 5, 'cgm')$q$, :'u_user_id'), '23514');
SELECT public.t_expect('bad source rejected', format($q$INSERT INTO glucose_readings (user_id, measured_at, glucose_mgdl, source) VALUES (%L, '2026-10-16T08:05:00Z', 100, 'guess')$q$, :'u_user_id'), '23514');
SELECT public.t_expect('foreign key: unknown user rejected', $q$INSERT INTO glucose_readings (user_id, measured_at, glucose_mgdl, source) VALUES (gen_random_uuid(), now(), 100, 'cgm')$q$, '23503');
SELECT public.t_expect('external_id uniqueness', format($q$INSERT INTO glucose_readings (user_id, measured_at, glucose_mgdl, source, external_id) VALUES (%1$L, '2026-10-16T09:00:00Z', 100, 'lab', 'x1'), (%1$L, '2026-10-16T09:01:00Z', 101, 'lab', 'x1')$q$, :'u_user_id'), '23505');

-- unknown vs confirmed zero
SELECT public.t_expect('meal with unknown carbs allowed as draft', format($q$INSERT INTO meal_events (user_id, client_uuid, eaten_at) VALUES (%L, gen_random_uuid(), now())$q$, :'u_user_id'), 'OK');
SELECT public.t_expect('confirmed meal needs carbs (NULL is not zero)', format($q$INSERT INTO meal_events (user_id, client_uuid, eaten_at, status) VALUES (%L, gen_random_uuid(), now(), 'confirmed')$q$, :'u_user_id'), '23514');
SELECT public.t_expect('confirmed zero-carb meal allowed', format($q$INSERT INTO meal_events (user_id, client_uuid, eaten_at, status, carbs_g, carbs_provenance) VALUES (%L, gen_random_uuid(), now(), 'confirmed', 0, 'user_entered')$q$, :'u_user_id'), 'OK');
SELECT public.t_expect('a carbohydrate number without a provenance label is rejected (0006)', format($q$INSERT INTO meal_events (user_id, client_uuid, eaten_at, carbs_g) VALUES (%L, gen_random_uuid(), now(), 30)$q$, :'u_user_id'), '23514');
SELECT public.t_expect('carbs above 400 g rejected', format($q$INSERT INTO meal_events (user_id, client_uuid, eaten_at, carbs_g, carbs_provenance) VALUES (%L, gen_random_uuid(), now(), 401, 'user_entered')$q$, :'u_user_id'), '23514');
SELECT public.t_expect('meal client_uuid idempotency', format($q$INSERT INTO meal_events (user_id, client_uuid, eaten_at) VALUES (%1$L, '11111111-1111-1111-1111-111111111111', now()), (%1$L, '11111111-1111-1111-1111-111111111111', now())$q$, :'u_user_id'), '23505');
SELECT public.t_expect('meal item + update + delete by app role', format($q$
  WITH m AS (INSERT INTO meal_events (user_id, client_uuid, eaten_at) VALUES (%L, gen_random_uuid(), now()) RETURNING meal_id),
       i AS (INSERT INTO meal_items (meal_id, position, name, carbs_g) SELECT meal_id, 0, 'rice', 45 FROM m RETURNING meal_id)
  SELECT 1 FROM i$q$, :'u_user_id'), 'OK');
SELECT public.t_expect('app role can UPDATE meal_items', $q$UPDATE meal_items SET carbs_g = 50 WHERE name = 'rice'$q$, 'OK');
SELECT public.t_expect('app role can DELETE meal_items', $q$DELETE FROM meal_items WHERE name = 'rice'$q$, 'OK');

-- suggestion is not a dose
SELECT public.t_expect('uncertain insulin event with unknown dose allowed', format($q$INSERT INTO insulin_events (user_id, client_uuid, administered_at, kind, source, units_suggested) VALUES (%L, gen_random_uuid(), now(), 'bolus', 'manual', 5.5)$q$, :'u_user_id'), 'OK');
SELECT public.t_expect('confirmed insulin event requires units_administered', format($q$INSERT INTO insulin_events (user_id, client_uuid, administered_at, kind, source, confirmation, units_suggested) VALUES (%L, gen_random_uuid(), now(), 'bolus', 'manual', 'confirmed', 5.5)$q$, :'u_user_id'), '23514');
SELECT public.t_expect('a planned dose cannot carry an administered amount (0006)', format($q$INSERT INTO insulin_events (user_id, client_uuid, administered_at, kind, source, confirmation, units_administered) VALUES (%L, gen_random_uuid(), now(), 'bolus', 'manual', 'planned', 4)$q$, :'u_user_id'), '23514');
SELECT public.t_expect('a planned dose with only the planned amount is allowed (0006)', format($q$INSERT INTO insulin_events (user_id, client_uuid, administered_at, kind, source, confirmation, units_suggested) VALUES (%L, gen_random_uuid(), now(), 'bolus', 'manual', 'planned', 4)$q$, :'u_user_id'), 'OK');
SELECT public.t_expect('confirmed zero-unit dose allowed', format($q$INSERT INTO insulin_events (user_id, client_uuid, administered_at, kind, source, confirmation, units_administered) VALUES (%L, gen_random_uuid(), now(), 'bolus', 'manual', 'confirmed', 0)$q$, :'u_user_id'), 'OK');

-- activity / sleep
SELECT public.t_expect('activity with unknown duration/steps allowed', format($q$INSERT INTO activity_events (user_id, started_at, activity_type, source) VALUES (%L, now(), 'walk', 'manual')$q$, :'u_user_id'), 'OK');
SELECT public.t_expect('negative steps rejected', format($q$INSERT INTO activity_events (user_id, started_at, activity_type, source, steps) VALUES (%L, now(), 'run', 'manual', -1)$q$, :'u_user_id'), '23514');
SELECT public.t_expect('sleep with unavailable quality allowed', format($q$INSERT INTO sleep_events (user_id, started_at, ended_at, source) VALUES (%L, '2026-10-15T21:00:00Z', '2026-10-16T05:00:00Z', 'manual')$q$, :'u_user_id'), 'OK');
SELECT public.t_expect('sleep end before start rejected', format($q$INSERT INTO sleep_events (user_id, started_at, ended_at, source) VALUES (%L, '2026-10-16T05:00:00Z', '2026-10-15T21:00:00Z', 'manual')$q$, :'u_user_id'), '23514');

-- predictions are immutable
INSERT INTO predictions (user_id, anchor_at, target_at, horizon_min, predicted_mgdl, lower_mgdl, upper_mgdl, model_version, parameter_version, input_snapshot)
  VALUES (:'u_user_id', '2026-10-16T08:00:00Z', '2026-10-16T08:30:00Z', 30, 120, 100, 140, 'direct_120', 'p1', '{"last_glucose": 110.5}') RETURNING prediction_id \gset p_
SELECT public.t_expect('prediction target must equal anchor + horizon', format($q$INSERT INTO predictions (user_id, anchor_at, target_at, horizon_min, predicted_mgdl, lower_mgdl, upper_mgdl, model_version, parameter_version, input_snapshot) VALUES (%L, '2026-10-16T08:00:00Z', '2026-10-16T09:00:00Z', 30, 120, 100, 140, 'm', 'p', '{}')$q$, :'u_user_id'), '23514');
SELECT public.t_expect('prediction bounds must bracket the estimate', format($q$INSERT INTO predictions (user_id, anchor_at, target_at, horizon_min, predicted_mgdl, lower_mgdl, upper_mgdl, model_version, parameter_version, input_snapshot) VALUES (%L, '2026-10-16T08:00:00Z', '2026-10-16T08:30:00Z', 30, 120, 130, 140, 'm2', 'p', '{}')$q$, :'u_user_id'), '23514');
SELECT public.t_expect('duplicate prediction rejected', format($q$INSERT INTO predictions (user_id, anchor_at, target_at, horizon_min, predicted_mgdl, lower_mgdl, upper_mgdl, model_version, parameter_version, input_snapshot) VALUES (%L, '2026-10-16T08:00:00Z', '2026-10-16T08:30:00Z', 30, 120, 100, 140, 'direct_120', 'p1', '{}')$q$, :'u_user_id'), '23505');
SELECT public.t_expect('outcome insert works', format($q$INSERT INTO prediction_outcomes (prediction_id, observed_mgdl, observed_at, signed_error_mgdl, abs_error_mgdl, within_interval, match_offset_sec, matching_quality) VALUES (%L, 126, '2026-10-16T08:30:00Z', 6, 6, true, 0, 'exact')$q$, :'p_prediction_id'), 'OK');
SELECT public.t_expect('inconsistent abs error rejected', format($q$INSERT INTO prediction_outcomes (prediction_id, observed_mgdl, observed_at, signed_error_mgdl, abs_error_mgdl, match_offset_sec, matching_quality) VALUES (%L, 126, now(), -6, 7, 0, 'exact')$q$, :'p_prediction_id'), '23514');
SELECT public.t_expect('second outcome for same prediction rejected', format($q$INSERT INTO prediction_outcomes (prediction_id, observed_mgdl, observed_at, signed_error_mgdl, abs_error_mgdl, match_offset_sec, matching_quality) VALUES (%L, 126, now(), 6, 6, 0, 'exact')$q$, :'p_prediction_id'), '23505');
SELECT public.t_expect('prediction UPDATE blocked (app role)', format($q$UPDATE predictions SET predicted_mgdl = 999 WHERE prediction_id = %L$q$, :'p_prediction_id'), '42501');
SELECT public.t_expect('prediction DELETE blocked (app role)', format($q$DELETE FROM predictions WHERE prediction_id = %L$q$, :'p_prediction_id'), '42501');
SELECT public.t_expect('outcome UPDATE blocked (app role)', $q$UPDATE prediction_outcomes SET abs_error_mgdl = 0$q$, '42501');

-- parameters: versioned, bounded
SELECT public.t_expect('parameter version inserted', format($q$INSERT INTO model_parameters (user_id, name, version, value, lower_bound, upper_bound, evidence_count) VALUES (%L, 'm_isf', 1, 1.0, 0.7, 1.3, 0)$q$, :'u_user_id'), 'OK');
SELECT public.t_expect('same parameter version twice rejected', format($q$INSERT INTO model_parameters (user_id, name, version, value, lower_bound, upper_bound) VALUES (%L, 'm_isf', 1, 1.1, 0.7, 1.3)$q$, :'u_user_id'), '23505');
SELECT public.t_expect('population prior duplicate (NULL user) rejected', $q$INSERT INTO model_parameters (user_id, name, version, value, lower_bound, upper_bound) VALUES (NULL, 'tmax', 1, 45, 20, 90), (NULL, 'tmax', 1, 46, 20, 90)$q$, '23505');
SELECT public.t_expect('parameter outside bounds rejected', format($q$INSERT INTO model_parameters (user_id, name, version, value, lower_bound, upper_bound) VALUES (%L, 'm_icr', 1, 1.5, 0.7, 1.3)$q$, :'u_user_id'), '23514');
SELECT public.t_expect('app role may change parameter status only', $q$UPDATE model_parameters SET status = 'active' WHERE name = 'm_isf'$q$, 'OK');
SELECT public.t_expect('app role may NOT change parameter value', $q$UPDATE model_parameters SET value = 1.2 WHERE name = 'm_isf'$q$, '42501');

-- performance, context
SELECT public.t_expect('performance row with no samples (metrics NULL) allowed', format($q$INSERT INTO model_performance (user_id, model_version, horizon_min, window_start, window_end, sample_count) VALUES (%L, 'direct_120', 30, '2026-10-01', '2026-10-08', 0)$q$, :'u_user_id'), 'OK');
SELECT public.t_expect('context row: coverage 0 is a fact, NULL wearables allowed', format($q$INSERT INTO context_features (user_id, feature_at, hour_sin, hour_cos, wearable_coverage) VALUES (%L, now(), 0.5, 0.866, 0)$q$, :'u_user_id'), 'OK');

-- 0006: therapy settings and forecast runs
INSERT INTO therapy_profiles (user_id, version, effective_from, source) VALUES (:'u_user_id', 1, now(), 'user_entered') RETURNING profile_id \gset t_
SELECT public.t_expect('ICR segment inserted', format($q$INSERT INTO therapy_segments (profile_id, kind, start_minute, value) VALUES (%L, 'icr', 0, 10)$q$, :'t_profile_id'), 'OK');
SELECT public.t_expect('ICR of zero rejected', format($q$INSERT INTO therapy_segments (profile_id, kind, start_minute, value) VALUES (%L, 'icr', 60, 0)$q$, :'t_profile_id'), '23514');
SELECT public.t_expect('ICR above 150 g/U rejected', format($q$INSERT INTO therapy_segments (profile_id, kind, start_minute, value) VALUES (%L, 'icr', 120, 400)$q$, :'t_profile_id'), '23514');
SELECT public.t_expect('the same segment twice rejected', format($q$INSERT INTO therapy_segments (profile_id, kind, start_minute, value) VALUES (%L, 'icr', 0, 11)$q$, :'t_profile_id'), '23505');
SELECT public.t_expect('two profiles with the same version rejected', format($q$INSERT INTO therapy_profiles (user_id, version, effective_from, source) VALUES (%L, 1, now(), 'user_entered')$q$, :'u_user_id'), '23505');
SELECT public.t_expect('a therapy setting cannot be edited (new version instead)', $q$UPDATE therapy_segments SET value = 99$q$, '42501');
SELECT public.t_expect('a therapy setting cannot be deleted', $q$DELETE FROM therapy_profiles$q$, '42501');

-- 0007: meal label and insulin status
SELECT public.t_expect('a meal label of 1-80 characters is allowed', format($q$INSERT INTO meal_events (user_id, client_uuid, eaten_at, label) VALUES (%L, gen_random_uuid(), now(), 'Pasta')$q$, :'u_user_id'), 'OK');
SELECT public.t_expect('an empty meal label is rejected', format($q$INSERT INTO meal_events (user_id, client_uuid, eaten_at, label) VALUES (%L, gen_random_uuid(), now(), '   ')$q$, :'u_user_id'), '23514');
SELECT public.t_expect('an insulin entry can be cancelled (status change)', format($q$WITH i AS (INSERT INTO insulin_events (user_id, client_uuid, administered_at, kind, source, confirmation, units_administered) VALUES (%L, gen_random_uuid(), now(), 'bolus', 'manual', 'confirmed', 2) RETURNING insulin_id) UPDATE insulin_events SET status = 'cancelled' WHERE insulin_id IN (SELECT insulin_id FROM i)$q$, :'u_user_id'), 'OK');
SELECT public.t_expect('an unknown insulin status is rejected', format($q$INSERT INTO insulin_events (user_id, client_uuid, administered_at, kind, source, confirmation, units_administered, status) VALUES (%L, gen_random_uuid(), now(), 'bolus', 'manual', 'confirmed', 2, 'deleted')$q$, :'u_user_id'), '23514');
-- 0008: meal absorption features
SELECT public.t_expect('a meal can store the vision model absorption class and confidence', format($q$INSERT INTO meal_events (user_id, client_uuid, eaten_at, absorption_class_ai, absorption_confidence, glycemic_load, meal_factors, feature_schema_version) VALUES (%L, gen_random_uuid(), now(), 'slow_delayed', 'medium', 39.0, '{"form":"solid"}', 'meal-features-v2')$q$, :'u_user_id'), 'OK');
SELECT public.t_expect('an unknown absorption class is rejected', format($q$INSERT INTO meal_events (user_id, client_uuid, eaten_at, absorption_class_ai, absorption_confidence) VALUES (%L, gen_random_uuid(), now(), 'turbo', 'low')$q$, :'u_user_id'), '23514');
SELECT public.t_expect('an absorption class needs a confidence (and the reverse)', format($q$INSERT INTO meal_events (user_id, client_uuid, eaten_at, absorption_class_ai) VALUES (%L, gen_random_uuid(), now(), 'fast')$q$, :'u_user_id'), '23514');
SELECT public.t_expect('a negative glycaemic load is rejected', format($q$INSERT INTO meal_events (user_id, client_uuid, eaten_at, glycemic_load) VALUES (%L, gen_random_uuid(), now(), -1)$q$, :'u_user_id'), '23514');
SELECT public.t_expect('meal factors must be a JSON object', format($q$INSERT INTO meal_events (user_id, client_uuid, eaten_at, meal_factors) VALUES (%L, gen_random_uuid(), now(), '[1]')$q$, :'u_user_id'), '23514');
SELECT public.t_expect('a meal without any of the new fields still inserts (older clients)', format($q$INSERT INTO meal_events (user_id, client_uuid, eaten_at, carbs_g, carbs_provenance, status) VALUES (%L, gen_random_uuid(), now(), 30, 'user_entered', 'manual_entry')$q$, :'u_user_id'), 'OK');
-- 0009: morning insulin resistance
SELECT public.t_expect('a therapy version defaults to no morning resistance', format($q$INSERT INTO therapy_profiles (user_id, version, effective_from, source) VALUES (%L, 91, now(), 'user_entered')$q$, :'u_user_id'), 'OK');
SELECT public.t_expect('morning resistance with a percent is accepted', format($q$INSERT INTO therapy_profiles (user_id, version, effective_from, source, morning_resistance, morning_resistance_percent) VALUES (%L, 92, now(), 'user_entered', true, 30)$q$, :'u_user_id'), 'OK');
SELECT public.t_expect('morning resistance switched on without a percent is accepted (engine default applies)', format($q$INSERT INTO therapy_profiles (user_id, version, effective_from, source, morning_resistance) VALUES (%L, 93, now(), 'user_entered', true)$q$, :'u_user_id'), 'OK');
SELECT public.t_expect('a percent while the flag is off is rejected', format($q$INSERT INTO therapy_profiles (user_id, version, effective_from, source, morning_resistance, morning_resistance_percent) VALUES (%L, 94, now(), 'user_entered', false, 20)$q$, :'u_user_id'), '23514');
SELECT public.t_expect('a percent above 50 is rejected', format($q$INSERT INTO therapy_profiles (user_id, version, effective_from, source, morning_resistance, morning_resistance_percent) VALUES (%L, 95, now(), 'user_entered', true, 80)$q$, :'u_user_id'), '23514');
SELECT public.t_expect('a negative percent is rejected', format($q$INSERT INTO therapy_profiles (user_id, version, effective_from, source, morning_resistance, morning_resistance_percent) VALUES (%L, 96, now(), 'user_entered', true, -5)$q$, :'u_user_id'), '23514');
-- privileges
SELECT public.t_expect('app role cannot DDL', $q$CREATE TABLE should_not_exist (a int)$q$, '42501');
SELECT public.t_expect('app role cannot TRUNCATE', $q$TRUNCATE glucose_readings$q$, '42501');
SELECT public.t_expect('app role cannot DELETE glucose', $q$DELETE FROM glucose_readings$q$, '42501');
SELECT public.t_expect('deleting a user with history is blocked', format($q$DELETE FROM users WHERE user_id = %L$q$, :'u_user_id'), '42501');
SELECT public.t_expect('app role cannot read migration table', $q$SELECT * FROM schema_migrations$q$, '42501');
SELECT current_user AS tested_as, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser;

ROLLBACK;
\echo all checks passed, test data rolled back
