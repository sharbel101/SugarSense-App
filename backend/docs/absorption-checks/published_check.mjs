// Read-only: imports the DEPLOYED engine build and runs clean what-if simulations. No database, no writes.
import { computeRun } from '/home/ubuntu/sugarsense-app/backend/dist/engine/run.js';
import { resolveAbsorptionProfile, profileRate } from '/home/ubuntu/sugarsense-app/backend/dist/engine/absorption.js';

const params = { cC: 0.25, cS: 0.25, mCsf: 1, mIsf: 1, tdMin: 300, alphaF: 0, alphaP: 0, tauMMin: 40, tpRapidMin: 75, tpUltraMin: 55, trendOverlap: false, uncertainDoseRel: 0.5 };
const ICR = 15, ISF = 50; // arbitrary but matched: insulin covers the carbohydrate exactly, so the shape does not depend on them
const T0 = 1_800_000_000;

function features(m) {
  return { legacyClass: 'medium', legacyClassIsUserSet: false, aiClass: null, aiConfidence: null, giEstimate: m.gi ?? null, giConfidence: m.giConf ?? null,
    fatG: m.fat ?? null, proteinG: m.protein ?? null, fiberG: m.fiber ?? null };
}
function sim(m, v2, insulin = true) {
  const meal = { id: 'm', tSec: T0, carbsG: m.carbs, fatG: m.fat, proteinG: m.protein, icrGPerU: ICR, isfMgdlPerU: ISF, revision: 1, timeClass: 'medium',
    provenance: 'user_entered', carbsSigmaG: 3, timingUncertaintyMin: 0 };
  if (v2) meal.absorption = resolveAbsorptionProfile(features(m), params.tauMMin);
  const inputs = { layerVersion: v2 ? 'meal-aware-0.2' : 'meal-aware-0.1', anchorSec: T0, horizonMin: 300,
    baseline: Array.from({ length: 24 }, (_, i) => ({ minutes: (i + 1) * 5, value: 120 })), baselineSigmaKnots: [[0, 0], [60, 40], [180, 80]],
    meals: [meal], insulin: insulin ? [{ id: 'i', kind: 'bolus', tSec: T0, units: m.carbs / ICR, uncertain: false, ultraRapid: false, isfMgdlPerU: ISF, declaredMealId: 'm', revision: 1 }] : [],
    links: [{ mealId: 'm', status: insulin ? 'linked_declared' : 'confirmed_none', insulinIds: insulin ? ['i'] : [], unitsTotal: insulin ? m.carbs / ICR : 0 }],
    params, excludeMealIds: [], insulinHistory: insulin ? 'logged' : 'confirmed_none' };
  const { points } = computeRun(inputs, insulin ? {} : { forceApplyIds: ['m'] });
  let best = { minutes: 0, adjusted: 120 }, best180 = { minutes: 0, adjusted: 120 };
  for (const p of points) { if (p.adjusted > best.adjusted) best = p; if (p.minutes <= 180 && p.adjusted > best180.adjusted) best180 = p; }
  const at = (min) => (points.find((p) => p.minutes === min) || {}).adjusted;
  return { peak180: best180.minutes, rise180: Math.round(best180.adjusted - 120), at240: Math.round(((points.find((p) => p.minutes === 240) || {}).adjusted ?? 120) - 120), at300: Math.round(((points.find((p) => p.minutes === 300) || {}).adjusted ?? 120) - 120), peakMin: best.minutes, peakRise: Math.round(best.adjusted - 120), at60: Math.round(at(60) - 120), at120: Math.round(at(120) - 120), at180: Math.round(at(180) - 120), profile: meal.absorption };
}
function rateArgmax(p) { let b = 0, bt = 0; for (let t = 1; t <= 300; t += 1) { const r = profileRate(t, p); if (r > b) { b = r; bt = t; } } return bt; }
const row = (label, a, b, pub) => console.log(label.padEnd(26), `incumbent peak ${String(a.peakMin).padStart(3)} min (+${a.peakRise})`.padEnd(34), `absorption-v2 peak ${String(b.peakMin).padStart(3)} min (+${b.peakRise}) [<=180: ${b.peak180}, +240: ${b.at240}, +300: ${b.at300}]`.padEnd(78), pub ?? '');

console.log('=== 1. Smart et al. 2013 (n=33 children with T1D, 30 g carbohydrate, same insulin dose): published mean time to peak glucose');
const smart = [['LF/LP fat 4  prot 5', { carbs: 30, fat: 4, protein: 5 }, 79], ['LF/HP fat 4  prot 40', { carbs: 30, fat: 4, protein: 40 }, 96],
               ['HF/LP fat 35 prot 5', { carbs: 30, fat: 35, protein: 5 }, 126], ['HF/HP fat 35 prot 40', { carbs: 30, fat: 35, protein: 40 }, 143]];
const peaks = [];
for (const [label, m, pub] of smart) { const a = sim(m, false), b = sim(m, true); peaks.push([pub, a.peakMin, b.peakMin]); row(label, a, b, `published ${pub} min`); }
const corr = (xs, ys) => { const n = xs.length, mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n; const sxy = xs.reduce((s, v, i) => s + (v - mx) * (ys[i] - my), 0); const sx = Math.sqrt(xs.reduce((s, v) => s + (v - mx) ** 2, 0)), sy = Math.sqrt(ys.reduce((s, v) => s + (v - my) ** 2, 0)); return sy === 0 ? NaN : sxy / (sx * sy); };
console.log('order published:', peaks.map((p) => p[0]).join(' < '), '| v2 peaks:', peaks.map((p) => p[2]).join(', '), '| incumbent peaks:', peaks.map((p) => p[1]).join(', '));
console.log('correlation published vs v2:', corr(peaks.map((p) => p[0]), peaks.map((p) => p[2])).toFixed(2), '| vs incumbent:', corr(peaks.map((p) => p[0]), peaks.map((p) => p[1])).toFixed(2));

console.log('\n=== 2. Wolpert 2013 (n=7 adults with T1D): time of maximum meal glucose appearance, low-fat 71 min -> high-fat 102 min (fat 10 g vs 60 g)');
for (const protein of [20, 30, 40]) {
  const lo = resolveAbsorptionProfile(features({ fat: 10, protein }), 40), hi = resolveAbsorptionProfile(features({ fat: 60, protein }), 40);
  console.log(`protein ${protein} g: incumbent rate peak 40 -> 40 min | v2 low-fat ${rateArgmax(lo)} min -> high-fat ${rateArgmax(hi)} min   (phi ${hi.phi.toFixed(2)}, delay ${hi.delayMin} min)`);
}

console.log('\n=== 3. Glycemic index: what the model does with it (no source found that gives a transferable mg/dL effect)');
const base = { carbs: 60, fat: 5, protein: 10 };
for (const [label, extra] of [['GI unknown', {}], ['GI 40, medium conf', { gi: 40, giConf: 'medium' }], ['GI 75, low conf', { gi: 75, giConf: 'low' }], ['GI 75, medium conf', { gi: 75, giConf: 'medium' }], ['GI 90, high conf', { gi: 90, giConf: 'high' }]]) {
  const m = { ...base, ...extra }; const b = sim(m, true); console.log(label.padEnd(22), `v2 peak ${b.peakMin} min (+${b.peakRise}) | at 60 min +${b.at60}`, '| source', b.profile.source, '| tau', b.profile.tauFastMin);
}

console.log('\n=== 4. Your 2026-10-19 lunch (62 g carbs, 75 g fat, 37 g protein, 5 g fibre), no insulin so the carbohydrate effect alone is visible');
const lunch = { carbs: 62, fat: 75, protein: 37, fiber: 5, gi: 60, giConf: 'low' };
const a = sim(lunch, false, false), b = sim(lunch, true, false);
console.log('incumbent: +60 min', a.at60, ' +120', a.at120, ' +180', a.at180, '| v2: +60', b.at60, ' +120', b.at120, ' +180', b.at180, '| v2 profile', JSON.stringify(b.profile));
