-- 0005: the application role has no business reading migration bookkeeping. Migration 0004 granted
-- SELECT/INSERT on every table that existed at that moment, including schema_migrations; take it back.
-- (0004 is left untouched because applied migrations must never be edited.)

REVOKE ALL ON schema_migrations FROM sugarsense_app;
