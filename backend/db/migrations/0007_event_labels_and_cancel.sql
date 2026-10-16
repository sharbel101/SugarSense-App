-- 0007: a short name for meals, and a way to withdraw an insulin entry that was a mistake.
-- Additive only. A cancelled insulin entry is kept (with its revision history) but no longer acts in
-- forecasts and no longer counts as "insulin recorded".

ALTER TABLE meal_events
  ADD COLUMN label text CHECK (label IS NULL OR length(btrim(label)) BETWEEN 1 AND 80);

ALTER TABLE insulin_events
  ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled'));

CREATE INDEX insulin_events_active_time_idx ON insulin_events (user_id, administered_at DESC) WHERE status = 'active';
