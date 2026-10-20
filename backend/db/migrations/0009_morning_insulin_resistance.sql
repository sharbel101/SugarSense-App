-- 0009: morning insulin resistance (a per-version therapy setting).
-- Additive only. The person says whether their FIRST rapid-acting dose of the day needs more insulin for the same effect, and optionally how much more.
--  * morning_resistance: yes/no. Default false (existing versions behave exactly as before).
--  * morning_resistance_percent: percent EXTRA insulin needed (25 = the dose lowers glucose 1/1.25 as much). NULL while the flag is on = use the
--    engine default (MORNING_RESISTANCE.defaultPercent); must be NULL while the flag is off. 0-50.
-- It changes the forecast only. It is never applied to a dose, and the ICR/ISF the person entered are not touched.

ALTER TABLE therapy_profiles
  ADD COLUMN morning_resistance          boolean NOT NULL DEFAULT false,
  ADD COLUMN morning_resistance_percent  numeric(4,1) CHECK (morning_resistance_percent >= 0 AND morning_resistance_percent <= 50),
  ADD CONSTRAINT therapy_profiles_morning_pct_needs_flag CHECK (morning_resistance OR morning_resistance_percent IS NULL);
