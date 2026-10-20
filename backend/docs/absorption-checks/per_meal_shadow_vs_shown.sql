WITH pairs AS (
  SELECT s.horizon_min AS h,
         (r.input_snapshot -> 'inputs' -> 'meals' -> 0 ->> 'id') AS meal_id,
         (r.input_snapshot -> 'inputs' -> 'meals' -> 0 ->> 'carbsG')::numeric AS carbs,
         (r.input_snapshot -> 'inputs' -> 'meals' -> 0 ->> 'fatG')::numeric AS fat,
         (r.input_snapshot -> 'inputs' -> 'meals' -> 0 ->> 'proteinG')::numeric AS protein,
         jsonb_array_length(r.input_snapshot -> 'inputs' -> 'meals') AS n_meals,
         abs(m.predicted_mgdl - mo.observed_mgdl) AS err_shown,
         abs(s.predicted_mgdl - so.observed_mgdl) AS err_shadow,
         mo.observed_mgdl - m.predicted_mgdl AS bias_shown,
         so.observed_mgdl - s.predicted_mgdl AS bias_shadow
    FROM predictions s
    JOIN predictions m ON m.inputs_hash = s.input_snapshot ->> 'shadowOf' AND m.horizon_min = s.horizon_min
                      AND m.model_version = 'meal-aware-0.1+direct_120' AND m.feature_config <> 'glucose_only'
    JOIN forecast_runs r ON r.run_id = m.run_id
    JOIN prediction_outcomes so ON so.prediction_id = s.prediction_id
    JOIN prediction_outcomes mo ON mo.prediction_id = m.prediction_id
   WHERE s.model_version = 'meal-aware-0.2-shadow+direct_120'
)
SELECT meal_id, carbs, fat, protein, max(n_meals) AS meals_in_run,
       count(*) FILTER (WHERE h <= 60) AS n_early, round(avg(err_shown) FILTER (WHERE h <= 60), 1) AS early_mae_shown, round(avg(err_shadow) FILTER (WHERE h <= 60), 1) AS early_mae_shadow,
       count(*) FILTER (WHERE h >= 120) AS n_late, round(avg(err_shown) FILTER (WHERE h >= 120), 1) AS late_mae_shown, round(avg(err_shadow) FILTER (WHERE h >= 120), 1) AS late_mae_shadow,
       round(avg(bias_shown) FILTER (WHERE h >= 120), 1) AS late_bias_shown, round(avg(bias_shadow) FILTER (WHERE h >= 120), 1) AS late_bias_shadow
  FROM pairs GROUP BY meal_id, carbs, fat, protein ORDER BY meal_id;
