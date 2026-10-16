// Run: npm run test:eventsapi  (pure modules only; fetch is stubbed)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildInsulinPayload,
  buildMealPayload,
  getRecent,
  patchMeal,
  postInsulin,
  postMeal,
} from '../src/api/eventsApi.ts';
import { getTherapySettings, putTherapySettings, validateTherapyForm } from '../src/api/therapyApi.ts';
import { buildInsulinEvent, buildMealEvent, buildNoInsulinEvent, isValidClientId } from '../src/services/events.ts';
import {
  addRecord,
  backoffMs,
  deserializeQueue,
  dueRecords,
  newRecord,
  resolveMealLink,
  sendRecord,
  serializeQueue,
} from '../src/services/eventQueue.ts';

const meal = (over = {}) =>
  buildMealEvent(
    'meal-00000001',
    {
      occurredAtUtc: '2026-10-16T10:00:00.000Z', utcOffsetMin: 180, label: 'Pasta', carbsG: 45.5, fatG: null, proteinG: null, fiberG: null,
      absorptionClass: null, timeApproximate: false, notes: null, ...over,
    },
    { source: 'manual', aiCarbsG: null },
  );
const insulin = (over = {}) =>
  buildInsulinEvent('ins-00000001', {
    occurredAtUtc: '2026-10-16T10:05:00.000Z', utcOffsetMin: 180, insulinKind: 'bolus', unitsAdministered: 4, insulinType: 'rapid',
    confirmation: 'confirmed', timingUncertain: false, mealId: null, glucoseMgdl: 190, notes: 'secret note', ...over,
  });

const MEAL_VIEW = {
  id: '11111111-1111-4111-8111-111111111111', eatenAt: '2026-10-16T10:00:00.000Z', status: 'confirmed',
  carbs: { grams: 45.5, kind: 'user_entered', estimateRangeG: null }, fatG: null, proteinG: null, fiberG: null, glycemicIndex: null,
  absorptionClass: null, timeApproximateMin: 0, edited: false, revision: 1,
};
const INS_VIEW = {
  id: '22222222-2222-4222-8222-222222222222', administeredAt: '2026-10-16T10:05:00.000Z', kind: 'bolus', insulinType: 'rapid',
  unitsTaken: 4, unitsPlanned: null, confirmation: 'confirmed', mealId: null, revision: 1,
};

function stub(status, body) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : undefined });
    if (status === 'throw') throw new Error('offline');
    return { status, ok: status < 300, json: async () => body };
  };
  return { fetchImpl, calls };
}

// ---------------------------------------------------------------------------------- payloads

test('meal payload: blank fat/protein/fibre/speed/approximate time are OMITTED, never 0', () => {
  const p = buildMealPayload(meal());
  assert.deepEqual(Object.keys(p).sort(), ['carbsG', 'clientId', 'eatenAt', 'note'].sort());
  assert.equal(p.carbsG, 45.5);
  assert.equal(p.note, 'Pasta');
  const full = buildMealPayload(meal({ fatG: 12, proteinG: 8, fiberG: 3, absorptionClass: 'slow', timeApproximate: true, notes: 'x' }), true);
  assert.equal(full.fatG, 12);
  assert.equal(full.absorptionClass, 'slow');
  assert.equal(full.timingUncertaintyMin, 15);
  assert.equal(full.allowDuplicate, true);
  assert.equal(full.note, 'Pasta: x');
  assert.ok(isValidClientId(full.clientId));
  assert.ok(buildMealPayload(meal({ label: 'x'.repeat(600) })).note.length <= 500);
});

test('insulin payload: kind/type mapped, "none taken" is 0 + confirmed, uncertain time only when stated, no notes/glucose sent', () => {
  const p = buildInsulinPayload(insulin());
  assert.deepEqual(p, {
    clientId: 'ins-00000001', administeredAt: '2026-10-16T10:05:00.000Z', kind: 'bolus', confirmation: 'confirmed',
    unitsAdministered: 4, insulinType: 'rapid',
  });
  assert.equal('timingUncertain' in p, false, 'unknown timing is omitted');
  const unsure = buildInsulinPayload(insulin({ confirmation: 'uncertain', timingUncertain: true, mealId: 'abc', insulinKind: 'correction' }));
  assert.equal(unsure.confirmation, 'uncertain');
  assert.equal(unsure.timingUncertain, true);
  assert.equal(unsure.kind, 'correction');
  assert.equal(unsure.mealId, 'abc');
  const none = buildInsulinPayload(buildNoInsulinEvent('none-00000001', { occurredAtUtc: '2026-10-16T10:00:00.000Z', utcOffsetMin: 0, mealId: MEAL_VIEW.id }));
  assert.equal(none.unitsAdministered, 0);
  assert.equal(none.confirmation, 'confirmed');
  assert.equal(none.kind, 'bolus');
  assert.equal(none.mealId, MEAL_VIEW.id);
  assert.equal(JSON.stringify(p).includes('secret'), false);
  assert.equal(JSON.stringify(p).includes('190'), false);
});

// ---------------------------------------------------------------------------- result mapping

test('HTTP mapping: 201 created, 200 exists, 409 duplicate, 422 invalid, 400 validation, 404 route, 503, network', async () => {
  const ctx = (s) => ({ baseUrl: 'http://x', ...s });
  const created = await postMeal(ctx(stub(201, { result: 'created', meal: MEAL_VIEW, forecast: null })), meal());
  assert.equal(created.result, 'created');
  assert.equal(created.item.id, MEAL_VIEW.id);
  assert.equal(created.forecast, null, 'a null forecast stays null');
  assert.equal((await postMeal(ctx(stub(200, { result: 'exists', meal: MEAL_VIEW, forecast: null })), meal())).result, 'exists');
  const dup = await postMeal(ctx(stub(409, { result: 'duplicate', meal: null, duplicateOf: 'abc', reason: 'looks like a double entry', forecast: null })), meal());
  assert.equal(dup.result, 'duplicate');
  assert.equal(dup.duplicateOf, 'abc');
  assert.equal(dup.reason, 'looks like a double entry');
  const invalid = await postMeal(ctx(stub(422, { result: 'invalid', meal: null, reason: 'in the future', forecast: null })), meal());
  assert.equal(invalid.result, 'invalid');
  assert.equal(invalid.reason, 'in the future');
  const v400 = await postMeal(ctx(stub(400, { message: ['carbsG too big'] })), meal());
  assert.equal(v400.result, 'invalid');
  assert.equal(v400.reason, 'carbsG too big');
  assert.equal((await postMeal(ctx(stub(404, { message: 'Cannot POST /events/meals' })), meal())).result, 'server_unavailable');
  assert.equal((await postMeal(ctx(stub(503, { status: 'unavailable' })), meal())).result, 'server_unavailable');
  assert.equal((await postMeal(ctx(stub(429, {})), meal())).result, 'server_unavailable');
  assert.equal((await postMeal(ctx(stub('throw')), meal())).result, 'network_error');
  assert.equal((await postMeal(ctx(stub(200, { weird: true })), meal())).result, 'server_unavailable', 'an unrecognised 200 is not "saved"');
  const nf = await patchMeal(ctx(stub(404, { result: 'not_found', meal: null, forecast: null })), 'x', { status: 'cancelled' });
  assert.equal(nf.result, 'not_found');
});

test('a write response carries the forecast only when it parses; an off-shape forecast does not fail the save', async () => {
  const bad = await postInsulin({ baseUrl: '', ...stub(201, { result: 'created', insulin: INS_VIEW, forecast: { status: 'ok' } }) }, insulin());
  assert.equal(bad.result, 'created');
  assert.equal(bad.forecast, null);
});

test('requests are JSON with the clientId, to the right routes and verbs', async () => {
  const s = stub(201, { result: 'created', insulin: INS_VIEW, forecast: null });
  await postInsulin({ baseUrl: 'http://x', headers: { 'X-App-Token': 't' }, fetchImpl: s.fetchImpl }, insulin());
  assert.equal(s.calls[0].url, 'http://x/events/insulin');
  assert.equal(s.calls[0].init.method, 'POST');
  assert.equal(s.calls[0].init.headers['X-App-Token'], 't');
  assert.equal(s.calls[0].body.clientId, 'ins-00000001');
  const p = stub(200, { result: 'updated', meal: MEAL_VIEW, forecast: null });
  await patchMeal({ baseUrl: 'http://x', fetchImpl: p.fetchImpl }, MEAL_VIEW.id, { carbsG: 50, status: 'confirmed', expectedRevision: 1 });
  assert.equal(p.calls[0].init.method, 'PATCH');
  assert.equal(p.calls[0].url, `http://x/events/meals/${MEAL_VIEW.id}`);
});

test('getRecent: well-formed 200 only', async () => {
  const ok = await getRecent({ baseUrl: '', ...stub(200, { meals: [MEAL_VIEW], insulin: [INS_VIEW] }) }, 12);
  assert.equal(ok.kind, 'ok');
  assert.equal(ok.insulin[0].unitsTaken, 4);
  assert.equal((await getRecent({ baseUrl: '', ...stub(404, {}) }, 12)).kind, 'unavailable');
  assert.equal((await getRecent({ baseUrl: '', ...stub(200, { meals: [{ id: 1 }], insulin: [] }) }, 12)).kind, 'unavailable');
  const planned = await getRecent({ baseUrl: '', ...stub(200, { meals: [], insulin: [{ ...INS_VIEW, confirmation: 'planned', unitsTaken: null }] }) }, 12);
  assert.equal(planned.insulin[0].unitsTaken, null, 'a planned dose has no units taken - never 0');
});

// -------------------------------------------------------------------------------------- queue

test('queue: same id twice -> one record; a retry after a network failure stays pending with backoff', async () => {
  const r = newRecord(meal(), 0);
  let list = addRecord([], r);
  list = addRecord(list, newRecord(meal({ carbsG: 99 }), 0));
  assert.equal(list.length, 1);

  const offline = await sendRecord({ baseUrl: '', ...stub('throw') }, list, list[0], 1000);
  assert.equal(offline.record.status, 'pending');
  assert.equal(offline.record.attempts, 1);
  assert.equal(offline.record.nextAttemptAtMs, 1000 + backoffMs(1));
  assert.equal(dueRecords([offline.record], 1001).length, 0, 'not retried before its backoff');
  assert.equal(dueRecords([offline.record], 1001, true).length, 1, '"Send now" forces a retry');
  assert.equal(dueRecords([offline.record], 1000 + backoffMs(1)).length, 1);

  const s = stub(201, { result: 'created', meal: MEAL_VIEW, forecast: null });
  const online = await sendRecord({ baseUrl: '', ...s }, [offline.record], offline.record, 99_999);
  assert.equal(online.record.status, 'saved');
  assert.equal(online.record.serverId, MEAL_VIEW.id);
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].body.clientId, 'meal-00000001', 'the SAME clientId on every attempt');
});

test('queue: 404/503 keep it pending (never "saved"); invalid -> failed with the reason; 200 exists -> saved', async () => {
  const rec = newRecord(meal(), 0);
  for (const st of [404, 503]) {
    const out = await sendRecord({ baseUrl: '', ...stub(st, {}) }, [rec], rec, 0);
    assert.equal(out.record.status, 'pending');
  }
  const bad = await sendRecord({ baseUrl: '', ...stub(422, { result: 'invalid', meal: null, reason: 'too old', forecast: null }) }, [rec], rec, 0);
  assert.equal(bad.record.status, 'failed');
  assert.equal(bad.record.reason, 'too old');
  const ex = await sendRecord({ baseUrl: '', ...stub(200, { result: 'exists', meal: MEAL_VIEW, forecast: null }) }, [rec], rec, 0);
  assert.equal(ex.record.status, 'saved');
});

test('queue: a 409 duplicate asks the person once and does not loop; "Save anyway" resends with allowDuplicate', async () => {
  const rec = newRecord(meal(), 0);
  const dup = await sendRecord({ baseUrl: '', ...stub(409, { result: 'duplicate', meal: null, duplicateOf: 'x', reason: 'same as one at 10:00', forecast: null }) }, [rec], rec, 0);
  assert.equal(dup.record.awaitingDuplicateDecision, true);
  assert.equal(dup.record.status, 'pending');
  assert.equal(dueRecords([dup.record], 10 ** 9, true).length, 0, 'never retried automatically');
  const again = { ...dup.record, awaitingDuplicateDecision: false, allowDuplicate: true };
  const s = stub(201, { result: 'created', meal: MEAL_VIEW, forecast: null });
  const out = await sendRecord({ baseUrl: '', ...s }, [again], again, 0);
  assert.equal(out.record.status, 'saved');
  assert.equal(s.calls[0].body.allowDuplicate, true);
});

test('queue: a dose for a still-unsent meal waits, then goes with the meal\'s server id', async () => {
  const m = newRecord(meal(), 0);
  const d = newRecord(insulin({ mealId: 'meal-00000001' }), 0);
  const all = [d, m];
  assert.equal(resolveMealLink(all, 'meal-00000001'), 'defer');
  const skipped = await sendRecord({ baseUrl: '', ...stub(201, {}) }, all, d, 0);
  assert.equal(skipped.skipped, true);
  const savedMeal = { ...m, status: 'saved', serverId: MEAL_VIEW.id };
  assert.equal(resolveMealLink([d, savedMeal], 'meal-00000001'), MEAL_VIEW.id);
  const s = stub(201, { result: 'created', insulin: INS_VIEW, forecast: null });
  const sent = await sendRecord({ baseUrl: '', ...s }, [d, savedMeal], d, 0);
  assert.equal(s.calls[0].body.mealId, MEAL_VIEW.id);
  assert.equal(sent.record.status, 'saved');
  assert.equal(resolveMealLink([], 'server-uuid'), 'server-uuid');
  assert.equal(resolveMealLink([], null), null);
});

test('queue persistence round-trip: pending kept, saved dropped, garbage tolerated', () => {
  const pending = newRecord(meal(), 5);
  const saved = { ...newRecord(insulin(), 5), status: 'saved', serverId: 'x' };
  const text = serializeQueue([pending, saved]);
  const back = deserializeQueue(text);
  assert.equal(back.length, 1);
  assert.equal(back[0].event.id, 'meal-00000001');
  assert.equal(back[0].status, 'pending');
  assert.equal(back[0].event.carbsG, 45.5);
  assert.deepEqual(deserializeQueue(null), []);
  assert.deepEqual(deserializeQueue('not json'), []);
  assert.deepEqual(deserializeQueue('{"v":2,"records":[]}'), []);
  assert.deepEqual(deserializeQueue('{"v":1,"records":[{"event":{"id":1}}]}'), []);
});

// ------------------------------------------------------------------------------------ therapy

const row = (over = {}) => ({ startTime: '00:00', icr: '10', isf: '40', ...over });
const form = (over = {}) => ({ rows: [row()], source: 'user_entered', insulinType: 'rapid', note: '', ...over });

test('therapy form: server limits, first row at 00:00, increasing starts, ICR-only allowed', () => {
  const ok = validateTherapyForm(form());
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.body.icrSegments, [{ startMinute: 0, gramsPerUnit: 10 }]);
  assert.deepEqual(ok.body.isfSegments, [{ startMinute: 0, mgdlPerUnit: 40 }]);
  assert.equal(ok.body.source, 'user_entered');

  const icrOnly = validateTherapyForm(form({ rows: [row({ isf: '' })] }));
  assert.equal(icrOnly.ok, true);
  assert.equal('isfSegments' in icrOnly.body, false, 'blank correction factor is omitted so the server keeps the previous one');

  assert.equal(validateTherapyForm(form({ rows: [row({ icr: '0.5' })] })).ok, false);
  assert.equal(validateTherapyForm(form({ rows: [row({ icr: '151' })] })).ok, false);
  assert.equal(validateTherapyForm(form({ rows: [row({ isf: '4' })] })).ok, false);
  assert.equal(validateTherapyForm(form({ rows: [row({ isf: '501' })] })).ok, false);
  assert.equal(validateTherapyForm(form({ rows: [row({ icr: '10.123' })] })).ok, false);
  assert.equal(validateTherapyForm(form({ rows: [row({ startTime: '01:00' })] })).ok, false);
  assert.equal(validateTherapyForm(form({ rows: [row(), row({ startTime: '00:00' })] })).ok, false);
  assert.equal(validateTherapyForm(form({ rows: [row(), row({ startTime: '12:00', isf: '' })] })).ok, false, 'ISF on some rows only');
  assert.equal(validateTherapyForm(form({ source: null })).ok, false);
  assert.equal(validateTherapyForm(form({ rows: Array.from({ length: 9 }, (_, i) => row({ startTime: `${String(i).padStart(2, '0')}:00` })) })).ok, false);
  const two = validateTherapyForm(form({ rows: [row(), row({ startTime: '12:30', icr: '8,5', isf: '35' })] }));
  assert.equal(two.ok, true);
  assert.deepEqual(two.body.icrSegments[1], { startMinute: 750, gramsPerUnit: 8.5 });
});

test('therapy API: not_set view parses; PUT 400 surfaces the server text; 404 = unavailable', async () => {
  const notSet = { status: 'not_set', version: null, effectiveFrom: null, source: null, icrSegments: [], isfSegments: [], insulinType: null, insulinPeakMin: null, insulinDurationMin: null, note: null, whenMissing: 'w', disclaimer: 'd' };
  const v = await getTherapySettings({ baseUrl: '', ...stub(200, notSet) });
  assert.equal(v.kind, 'ok');
  assert.equal(v.value.status, 'not_set');
  assert.equal((await getTherapySettings({ baseUrl: '', ...stub(404, {}) })).kind, 'unavailable');
  const rejected = await putTherapySettings({ baseUrl: '', ...stub(400, { message: ['icrSegments.0.gramsPerUnit too big'] }) }, { icrSegments: [{ startMinute: 0, gramsPerUnit: 10 }], source: 'user_entered' });
  assert.equal(rejected.kind, 'invalid');
  assert.match(rejected.reason, /too big/);
});

// --------------------------------------------------------------------------------- wording lint

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

test('wording lint: no dosing language in the new UI strings', () => {
  const files = [
    'src/components/QuickAdd.tsx',
    'src/components/ForecastExtras.tsx',
    'src/screens/InsulinSettingsScreen.tsx',
    'src/services/forecastView.ts',
  ];
  const forbidden = [/\binject\b/i, /dose needed/i, /\brecommended\b/i, /\baccurate\b/i, /\boptimal\b/i, /\byou need\b/i, /\badd \d+(\.\d+)? units\b/i, /\byour glucose will\b/i, /\bwill be \d/i, /\btake \d/i];
  for (const f of files) {
    let text;
    try {
      text = readFileSync(join(process.cwd(), f), 'utf8');
    } catch {
      continue;
    }
    // Only quoted string/JSX text, not identifiers; the disclaimers that NEGATE dosing are allowed.
    const literals = [...text.matchAll(/(['"`])((?:\\.|(?!\1).)*)\1|>([^<>{}]{6,})</g)].map((m) => m[2] ?? m[3] ?? '');
    for (const lit of literals) {
      const cleaned = lit.replace(/does not (suggest|tell you|calculate|recommend)[^.]*\./gi, '').replace(/never (calculates|delivers)[^.]*\./gi, '');
      for (const re of forbidden) assert.equal(re.test(cleaned), false, `${f}: "${lit}" matches ${re}`);
    }
  }
  assert.ok(readdirSync('src').length > 0);
});
