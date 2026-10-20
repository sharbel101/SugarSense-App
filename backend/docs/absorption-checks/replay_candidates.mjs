// Read-only retrospective: replays every stored meal-aware prediction that has a scored outcome with
//   (a) the incumbent single-component profile, (b) absorption-v2 parameters (fibre 0.01/g), (c) absorption-v3 parameters (fibre 0.05/g).
// Needs DATABASE_URL (read-only queries) and the engine build in ./dist. Run from a folder that contains dist/ and node_modules/pg.
// Caveat (also in ABSORPTION-MODEL.md): few distinct meals, heavily autocorrelated; this is a direction, not evidence.
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

function withProfile(inputs, fibre) {
  P.fiberSlowingPerG = fibre;
  return inputs.meals.map((m) => {
    const f = m.absorptionFeatures ?? { legacyClass: m.timeClass, legacyClassIsUserSet: false, aiClass: null, aiConfidence: null, giEstimate: null, giConfidence: null, fatG: m.fatG ?? null, proteinG: m.proteinG ?? null, fiberG: null };
    return { ...m, absorption: resolveAbsorptionProfile(f, inputs.params.tauMMin) };
  });
}
const stats = new Map();
const add = (key, h, errs, ins) => {
  const k = `${key}|${h}`;
  const s = stats.get(k) ?? { n: 0, abs: [0, 0, 0], sq: [0, 0, 0], cov: [0, 0, 0], bias: [0, 0, 0] };
  s.n += 1;
  errs.forEach((e, i) => { s.abs[i] += Math.abs(e); s.sq[i] += e * e; s.bias[i] += e; s.cov[i] += ins[i] ? 1 : 0; });
  stats.set(k, s);
};
for (const [, list] of byRun) {
  const inputs = list[0].snap.inputs;
  if (!inputs?.meals?.length) continue;
  const hasFibre = inputs.meals.some((m) => (m.absorptionFeatures?.fiberG ?? 0) > 0);
  const inc = computeRun(inputs);
  const v2 = computeRun({ ...inputs, meals: withProfile(inputs, 0.01) });
  const v3 = computeRun({ ...inputs, meals: withProfile(inputs, 0.05) });
  for (const r of list) {
    const pts = [inc, v2, v3].map((x) => x.points.find((p) => p.minutes === r.h));
    if (pts.some((p) => !p)) continue;
    const obs = Number(r.obs);
    const errs = pts.map((p) => obs - p.adjusted);
    const ins = pts.map((p) => obs >= p.low && obs <= p.high);
    for (const key of ['all', hasFibre ? 'meals with fibre recorded' : 'no fibre recorded']) add(key, r.h, errs, ins);
  }
}
const out = [];
for (const [k, s] of stats) {
  const [key, h] = k.split('|');
  out.push({ stratum: key, h: Number(h), n: s.n, 'MAE inc/v2/v3': s.abs.map((a) => (a / s.n).toFixed(1)).join(' / '), 'bias inc/v2/v3': s.bias.map((a) => (a / s.n).toFixed(1)).join(' / '), 'cover inc/v2/v3': s.cov.map((a) => (a / s.n).toFixed(2)).join(' / ') });
}
out.sort((a, b) => a.stratum.localeCompare(b.stratum) || a.h - b.h);
console.table(out);
const seen = new Map(); for (const [, l] of byRun) for (const m of (l[0].snap.inputs?.meals ?? [])) seen.set(m.id, m);
console.log('distinct meals:', seen.size, [...seen.values()].map((m) => `${m.carbsG}C/${m.fatG ?? '-'}F/${m.proteinG ?? '-'}P/fib ${m.absorptionFeatures?.fiberG ?? '-'}`).join(' ; '));
