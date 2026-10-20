// Calibrates the fat/protein terms of the absorption profile against published type 1 diabetes matched-insulin results.
// Uses the LOCAL build (npm run build) of the engine: node docs/absorption-checks/t1d_calibration.mjs  (no database, no network, no writes)
import { computeRun } from '../../dist/engine/run.js';
import { resolveAbsorptionProfile, ABSORPTION_PARAMS as P } from '../../dist/engine/absorption.js';

const params = { cC: 0.25, cS: 0.25, mCsf: 1, mIsf: 1, tdMin: 300, alphaF: 0, alphaP: 0, tauMMin: 40, tpRapidMin: 75, tpUltraMin: 55, trendOverlap: false, uncertainDoseRel: 0.5 };
const ICR = 15, ISF = 50; // pediatric-like; the insulin covers the carbohydrate exactly, so only CSF scales the extra-glucose terms
const T0 = 1_800_000_000;
const feat = (m) => ({ legacyClass: 'medium', legacyClassIsUserSet: false, aiClass: null, aiConfidence: null, giEstimate: null, giConfidence: null, fatG: m.fat, proteinG: m.protein, fiberG: m.fiber ?? 0 });

export function sim(m, { v2 = true, insulin = true } = {}) {
  const meal = { id: 'm', tSec: T0, carbsG: m.carbs, fatG: m.fat, proteinG: m.protein, icrGPerU: ICR, isfMgdlPerU: ISF, revision: 1, timeClass: 'medium', provenance: 'user_entered', carbsSigmaG: 3, timingUncertaintyMin: 0 };
  if (v2) meal.absorption = resolveAbsorptionProfile(feat(m), params.tauMMin);
  const inputs = { layerVersion: 'x', anchorSec: T0, horizonMin: 300, baseline: Array.from({ length: 24 }, (_, i) => ({ minutes: (i + 1) * 5, value: 120 })), baselineSigmaKnots: [[0, 0], [60, 40], [300, 80]],
    meals: [meal], insulin: insulin ? [{ id: 'i', kind: 'bolus', tSec: T0, units: m.carbs / ICR, uncertain: false, ultraRapid: false, isfMgdlPerU: ISF, declaredMealId: 'm', revision: 1 }] : [],
    links: [{ mealId: 'm', status: insulin ? 'linked_declared' : 'confirmed_none', insulinIds: insulin ? ['i'] : [], unitsTotal: insulin ? m.carbs / ICR : 0 }],
    params, excludeMealIds: [], insulinHistory: insulin ? 'logged' : 'confirmed_none' };
  const { points } = computeRun(inputs, insulin ? {} : { forceApplyIds: ['m'] });
  const at = (min) => (points.find((p) => p.minutes === min)?.adjusted ?? 120) - 120;
  let pk = { minutes: 0, adjusted: 120 };
  for (const p of points) if (p.adjusted > pk.adjusted) pk = p;
  return { peakMin: pk.minutes, peak: pk.adjusted - 120, at: (x) => at(x), profile: meal.absorption };
}

// Smart 2013 (Diabetes Care 36:3897; n=33 children with T1D; 30 g carbohydrate; same insulin dose for every meal), mmol/L converted at 18 mg/dL per mmol/L
const MEALS = { LFLP: { carbs: 30, fat: 4, protein: 5 }, LFHP: { carbs: 30, fat: 4, protein: 40 }, HFLP: { carbs: 30, fat: 35, protein: 5 }, HFHP: { carbs: 30, fat: 35, protein: 40 } };
const PUB = { // [published value, scale used to normalise the residual]
  dPeakTime_LFHP: [96 - 79, 20], dPeakTime_HFLP: [126 - 79, 20], dPeakTime_HFHP: [143 - 79, 20],
  excess180_LFHP: [(2.4 - 0.5) * 18, 15], excess180_HFHP: [(4.2 - 0.5) * 18, 15], excess210_HFLP: [(1.8 + 0.5) * 18, 15], excess300_HFHP: [5.4 * 18, 25],
};
export function evaluate() {
  const r = Object.fromEntries(Object.entries(MEALS).map(([k, m]) => [k, sim(m)]));
  const ref = r.LFLP;
  const model = {
    dPeakTime_LFHP: r.LFHP.peakMin - ref.peakMin, dPeakTime_HFLP: r.HFLP.peakMin - ref.peakMin, dPeakTime_HFHP: r.HFHP.peakMin - ref.peakMin,
    excess180_LFHP: r.LFHP.at(180) - ref.at(180), excess180_HFHP: r.HFHP.at(180) - ref.at(180), excess210_HFLP: r.HFLP.at(210) - ref.at(210), excess300_HFHP: r.HFHP.at(300) - ref.at(300),
  };
  let loss = 0;
  for (const [k, [pub, sc]] of Object.entries(PUB)) loss += ((model[k] - pub) / sc) ** 2;
  return { loss, model, r };
}
const set = (th) => { P.stretchPerFatG = th[0]; P.stretchPerProteinG = th[1]; P.equivalentPerFatG = th[2]; P.equivalentPerProteinG = th[3]; };

if (process.argv[1].endsWith('t1d_calibration.mjs')) {
  const show = (label, th) => {
    set(th); const e = evaluate();
    console.log(`${label.padEnd(24)} loss ${e.loss.toFixed(2)} | ` + Object.entries(e.model).map(([k, v]) => `${k.replace('dPeakTime_', 'dT ').replace('excess', 'x')}=${v.toFixed(0)}(${PUB[k][0].toFixed(0)})`).join(' '));
    return e;
  };
  console.log('model value (published value in brackets); dT = peak time minus the low-fat/low-protein meal, min; x<minutes> = excess glucose vs that meal, mg/dL\n');
  show('current v2 (no terms)', [0, 0, 0, 0]);
  // random search over wide bounds, then coordinate refinement (the loss surface is cheap: 4 simulations per evaluation)
  const hi = [0.06, 0.06, 2.0, 2.0];
  let th = [0, 0, 0, 0], best = Infinity;
  let seed = 12345; const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  for (let i = 0; i < 3000; i += 1) {
    const t2 = hi.map((h) => rnd() * h); set(t2); const l = evaluate().loss;
    if (l < best) { best = l; th = t2; }
  }
  for (let step = 0.2; step > 0.002; step *= 0.7) {
    for (let it = 0; it < 6; it += 1) {
      for (let i = 0; i < 4; i += 1) for (const dir of [-1, 1]) {
        const t2 = th.slice(); t2[i] = Math.min(hi[i], Math.max(0, t2[i] + dir * step * hi[i])); set(t2); const l = evaluate().loss;
        if (l < best - 1e-9) { best = l; th = t2; }
      }
    }
  }
  const e = show('fitted', th);
  console.log('\nfitted: stretch/g fat above 15 g =', th[0].toFixed(4), '| stretch/g protein above 20 g =', th[1].toFixed(4), '| carb-equivalent g per g fat =', th[2].toFixed(3), '| per g protein =', th[3].toFixed(3));
  for (const k of Object.keys(MEALS)) console.log(k.padEnd(5), 'profile tauFast', e.r[k].profile.tauFastMin.toFixed(1), 'phi', e.r[k].profile.phi.toFixed(2), 'delay', e.r[k].profile.delayMin, 'extraG', (e.r[k].profile.extraEquivalentG ?? 0).toFixed(1), '| peak', e.r[k].peakMin, 'min +' + e.r[k].peak.toFixed(0));
}
