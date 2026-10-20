-- Read-only: did the stored forecasts run too LOW (observed above predicted) after the person's first dose of the local day, compared with after other doses?
-- bias = observed - predicted (mg/dL); positive = glucose ended higher than forecast = the dose worked less than the model assumed.
-- Only anchors within 0-180 min AFTER a dose and with that dose the latest one are used. The day starts at 03:00 local.
WITH u AS (SELECT user_id, timezone FROM users ORDER BY created_at LIMIT 1),
doses AS (
  SELECT i.insulin_id, i.administered_at AS t, i.units_administered AS units,
         row_number() OVER (PARTITION BY ((i.administered_at AT TIME ZONE u.timezone) - interval '3 hours')::date ORDER BY i.administered_at) AS nth_today
    FROM insulin_events i JOIN u ON u.user_id = i.user_id
   WHERE i.status = 'active' AND i.kind IN ('bolus', 'correction') AND i.units_administered > 0 AND i.confirmation <> 'planned'
),
pairs AS (
  SELECT p.horizon_min AS h, d.nth_today = 1 AS first_dose, d.units, o.observed_mgdl - p.predicted_mgdl AS bias,
         (SELECT d2.t FROM doses d2 WHERE d2.t <= r.anchor_at ORDER BY d2.t DESC LIMIT 1) AS last_t, d.t AS dose_t
    FROM predictions p
    JOIN forecast_runs r USING (run_id)
    JOIN prediction_outcomes o USING (prediction_id)
    JOIN doses d ON d.t <= r.anchor_at AND r.anchor_at < d.t + interval '60 minutes'
   WHERE p.model_version LIKE 'meal-aware-0.1+%' AND p.feature_config <> 'glucose_only' AND p.horizon_min IN (60, 120)
)
SELECT first_dose, h AS horizon_min, count(*) AS n, count(DISTINCT dose_t) AS doses, round(avg(bias), 1) AS mean_bias, round(avg(abs(bias)), 1) AS mae
  FROM pairs WHERE last_t = dose_t
 GROUP BY first_dose, h ORDER BY first_dose DESC, h;
