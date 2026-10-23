// Run: npm run test:toasts  - the words and rules for in-app toasts (Sileo draws them on the web build only).
process.env.TZ = 'Asia/Beirut';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alertToast, editedToast, failedToast, forecastToast, savedToast, shouldToastForecast } from '../src/services/toastText.ts';
import { predictedNotification } from '../src/services/riskAlerts.ts';

const meal = { kind: 'meal', id: 'm', occurredAtUtc: '2026-10-21T11:30:00.000Z', utcOffsetMin: 180, notes: null, label: 'Pasta', carbsG: 40, fatG: null, proteinG: null, fiberG: null, absorptionClass: 'fast', timeApproximate: false, source: 'manual', original: null };
const dose = (units) => ({ kind: 'insulin', id: 'i', occurredAtUtc: '2026-10-21T11:30:00.000Z', utcOffsetMin: 180, notes: null, insulinKind: 'bolus', unitsAdministered: units, insulinType: 'rapid', confirmation: 'confirmed', mealId: null });
const fc = (anchor, mgdl) => ({ status: 'ok', anchor: { measuredAt: anchor, glucoseMgdl: mgdl, ageMinutes: 1 } });

test('saved meal: says what was saved and whether the forecast was refreshed', () => {
  const a = savedToast(meal, true);
  assert.deepEqual([a.tone, a.title], ['success', 'Carbs saved']);
  assert.equal(a.description, '40 g at 2:30 PM. Forecast updated.');
  assert.match(savedToast(meal, false).description, /The forecast updates on the next reading\.$/, 'not claimed when the server returned no forecast');
});

test('saved insulin: units shown as entered; a confirmed 0 U is "No insulin recorded", never "0 U saved"', () => {
  assert.equal(savedToast(dose(3.5), true).title, 'Insulin saved');
  assert.equal(savedToast(dose(3.5), true).description, '3.5 U at 2:30 PM. Forecast updated.');
  const none = savedToast(dose(0), true);
  assert.equal(none.title, 'No insulin recorded');
  assert.ok(!/0 U/.test(none.description));
});

test('failure and edit toasts', () => {
  assert.equal(failedToast('Server said no').tone, 'error');
  assert.equal(failedToast(null).description, 'It was not saved. Open it to try again.');
  assert.equal(editedToast(true).title, 'Entry removed');
  assert.equal(editedToast(false).title, 'Entry updated');
});

test('forecast toast: only for a NEW reading, never the first one of a session or the same reading again', () => {
  const a = fc('2026-10-21T11:00:00.000Z', 118);
  assert.equal(shouldToastForecast(null, a), false, 'first forecast');
  assert.equal(shouldToastForecast(a.anchor.measuredAt, a), false, 'same reading (e.g. recomputed after a save)');
  const b = fc('2026-10-21T11:05:00.000Z', 124);
  assert.equal(shouldToastForecast(a.anchor.measuredAt, b), true);
  assert.equal(forecastToast(b).description, 'New reading 124 mg/dL at 2:05 PM. Estimate only.');
  assert.equal(forecastToast(b).tone, 'info');
});

test('alerts: the toast uses the same words as the notification; a cleared alert is success, others warning; keys replace, not stack', () => {
  const n = { kind: 'low', type: 'predicted', title: 'Low blood sugar predicted', body: 'Predicted to go below 80 mg/dL at about 2:30 PM. Estimate only; check your glucose.', tag: 'sugarsense-risk-low' };
  const t = alertToast(n);
  assert.deepEqual([t.tone, t.title, t.description, t.key], ['warning', n.title, n.body, 'sugarsense-risk-low']);
  assert.equal(alertToast({ ...n, type: 'cleared' }).tone, 'success');
  assert.equal(alertToast({ kind: 'meal', type: 'missed_meal', title: 'Glucose rose quickly', body: 'b', tag: 'sugarsense-missed-meal' }).tone, 'warning');
  assert.equal(typeof predictedNotification, 'function');
});

test('no toast text gives a dose or says "will" about glucose', () => {
  const all = [savedToast(meal, true), savedToast(dose(3), false), failedToast(null), editedToast(false), forecastToast(fc('2026-10-21T11:05:00.000Z', 124))];
  for (const t of all) assert.ok(!/\b(take|inject|will be|will go)\b/i.test(`${t.title} ${t.description}`), t.title);
});
