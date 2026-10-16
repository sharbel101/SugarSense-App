-- 0004: least-privilege grants for the application role (sugarsense_app). Run by the owner role.
-- The app can read and insert everywhere; it can change only the tables meant to be edited.
-- No TRUNCATE, no DDL, no DELETE except on meal_items (rewritten when a user edits a meal).
-- Append-only tables (predictions, prediction_outcomes) are additionally protected by triggers
-- that also bind the owner role; meal_corrections blocks UPDATE the same way.

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO sugarsense_app;
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA public TO sugarsense_app;

GRANT UPDATE ON users, meal_events, meal_items, insulin_events TO sugarsense_app;
GRANT UPDATE (status) ON model_parameters TO sugarsense_app;
GRANT DELETE ON meal_items TO sugarsense_app;
