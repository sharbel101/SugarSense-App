-- Checks that hold even for the table owner / superuser: foreign keys restrict deletes and the
-- append-only triggers block UPDATE/DELETE on history. Everything is rolled back.
--   sudo -u postgres psql -d sugarsense -X -v ON_ERROR_STOP=1 < db/tests/verify_owner.sql
BEGIN;
SET client_min_messages = notice;

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

INSERT INTO users (user_id) VALUES ('00000000-0000-0000-0000-000000000001');
INSERT INTO glucose_readings (user_id, measured_at, glucose_mgdl, source)
  VALUES ('00000000-0000-0000-0000-000000000001', now(), 100, 'cgm');
INSERT INTO predictions (user_id, anchor_at, target_at, horizon_min, predicted_mgdl, lower_mgdl, upper_mgdl, model_version, parameter_version, input_snapshot)
  VALUES ('00000000-0000-0000-0000-000000000001', '2026-10-16T08:00Z', '2026-10-16T08:30Z', 30, 120, 100, 140, 'm', 'p', '{}');

SELECT public.t_expect('FK restricts deleting a user that has history', $q$DELETE FROM users WHERE user_id = '00000000-0000-0000-0000-000000000001'$q$, '23503');
SELECT public.t_expect('trigger blocks UPDATE of a prediction (even for the owner)', $q$UPDATE predictions SET predicted_mgdl = 130$q$, '23001');
SELECT public.t_expect('trigger blocks DELETE of a prediction (even for the owner)', $q$DELETE FROM predictions$q$, '23001');

INSERT INTO prediction_outcomes (prediction_id, observed_mgdl, observed_at, signed_error_mgdl, abs_error_mgdl, match_offset_sec, matching_quality)
  SELECT prediction_id, 126, '2026-10-16T08:30Z', 6, 6, 0, 'exact' FROM predictions;
SELECT public.t_expect('trigger blocks UPDATE of an outcome', $q$UPDATE prediction_outcomes SET observed_mgdl = 1$q$, '23001');
SELECT public.t_expect('prediction row unchanged after its outcome arrived', $q$SELECT 1 FROM predictions WHERE predicted_mgdl = 120 AND lower_mgdl = 100 AND upper_mgdl = 140$q$, 'OK');
SELECT public.t_expect('FK restricts deleting a prediction that has an outcome', $q$ALTER TABLE predictions DISABLE TRIGGER predictions_append_only; DELETE FROM predictions$q$, '23503');
ROLLBACK;
\echo owner-level checks done, rolled back
