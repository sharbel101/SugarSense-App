// Read-only: does adding the extra late glucose from fat/protein (carbohydrate-equivalent grams per gram above 15 g fat / 20 g protein)
// reduce the late (2-3 h) under-prediction on the person's own stored forecasts, and is it consistent across meals?
import pg from 'pg';
import { computeRun } from './dist/engine/run.js';
import { resolveAbsorptionProfile, ABSORPTION_PARAMS as P } from './dist/engine/absorption.js';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const rows = (await client.query(
  `SELECT r.run_id, r.input_snapshot AS snap, p.horizon_min AS h, o.observed_mgdl AS obs
     FROM predictions p JOIN forecast_runs r USING (run_id) JOIN prediction_outcomes o USING (prediction_id)
    WHERE p.model_version LIKE 'meal-aware-0.1+%' AND p.feature_config <> 'glucose_only' ORDER BY r.run_id, p.horizon_min`)).rows;
await client.end();
const byRun = new Map();
for (const r of rows) (byRun.get(r.run_id) ?? byRun.set(r.run_id, []).get(r.run_id)).push(r);

const SETTINGS = [['v3 (no extra)', 0, 0], ['+ extra 0.1/0.1', 0.1, 0.1], ['+ extra 0.2/0.2', 0.2, 0.2], ['+ extra 0.35/0.25', 0.35, 0.25], ['+ extra 0.5/0.5', 0.5, 0.5]];
function profiles(inputs, ef, ep) {
  P.equivalentPerFatG = ef; P.equivalentPerProteinG = ep;
  return inputs.meals.map((m) => {
    const f = m.absorptionFeatures ?? { legacyClass: m.timeClass, legacyClassIsUserSet: false, aiClass: null, aiConfidence: null, giEstimate: null, giConfidence: null, fatG: m.fatG ?? null, proteinG: m.proteinG ?? null, fiberG: null };
    return { ...m, absorption: resolveAbsorptionProfile(f, inputs.params.tauMMin) };
  });
}
const agg = SETTINGS.map(() => ({ early: [], late: [], lateBias: [], byMeal: new Map(), cov: [] }));
const incAgg = { late: [], lateBias: [], byMeal: new Map() };
for (const [, list] of byRun) {
  const inputs = list[0].snap.inputs;
  if (!inputs?.meals?.length) continue;
  const mealId = inputs.meals[0].id;
  const runs = SETTINGS.map(([, ef, ep]) => computeRun({ ...inputs, meals: profiles(inputs, ef, ep) }));
  const inc = computeRun(inputs);
  for (const r of list) {
    const obs = Number(r.obs);
    const pi = inc.points.find((p) => p.minutes === r.h);
    runs.forEach((x, i) => {
      const p = x.points.find((q) => q.minutes === r.h);
      if (!p) return;
      const e = obs - p.adjusted;
      (r.h <= 60 ? agg[i].early : agg[i].late).push(Math.abs(e));
      if (r.h >= 120) { agg[i].lateBias.push(e); agg[i].cov.push(obs >= p.low && obs <= p.high ? 1 : 0); const a = agg[i].byMeal.get(mealId) ?? []; a.push(Math.abs(e)); agg[i].byMeal.set(mealId, a); }
    });
    if (pi && r.h >= 120) { incAgg.late.push(Math.abs(obs - pi.adjusted)); incAgg.lateBias.push(obs - pi.adjusted); const a = incAgg.byMeal.get(mealId) ?? []; a.push(Math.abs(obs - pi.adjusted)); incAgg.byMeal.set(mealId, a); }
  }
}
const mean = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
console.log('late = horizons 120 and 180 min; early = 15..60 min. MAE and bias (observed minus predicted, mg/dL)');
console.log('incumbent'.padEnd(20), 'late n', incAgg.late.length, 'MAE', mean(incAgg.late).toFixed(1), 'bias', mean(incAgg.lateBias).toFixed(1));
const base = agg[0];
SETTINGS.forEach(([name], i) => {
  const a = agg[i];
  let better = 0, worse = 0, total = 0;
  for (const [id, errs] of a.byMeal) { const b = mean(base.byMeal.get(id) ?? errs); const m = mean(errs); total += 1; if (m < b - 0.5) better += 1; else if (m > b + 0.5) worse += 1; }
  console.log(name.padEnd(20), 'early MAE', mean(a.early).toFixed(1), '| late MAE', mean(a.late).toFixed(1), 'bias', mean(a.lateBias).toFixed(1), 'coverage', mean(a.cov).toFixed(2), '| vs "v3 (no extra)" per meal (first meal of run):', `${better} better, ${worse} worse, of ${total}`);
});
