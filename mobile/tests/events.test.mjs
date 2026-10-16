// Run: npm run test:events  (pure modules only)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildInsulinEvent,
  buildMealEvent,
  buildNoInsulinEvent,
  describeEvent,
  insertEvent,
  isValidClientId,
  newEventId,
  parseNumber,
  photoMealSource,
  resolveEventTime,
  validateInsulin,
  validateMeal,
} from '../src/services/events.ts';

const NOW = new Date('2026-10-16T12:00:00Z');
const now = { mode: 'minutesAgo', minutes: 0 };
const mealIn = (over = {}) => ({
  carbs: '45', label: '', fat: '', protein: '', fiber: '', absorption: 'unset', timeApproximate: false, time: now, notes: '', ...over,
});
const insIn = (over = {}) => ({
  units: '4', insulinKind: 'bolus', insulinType: 'rapid', confirmedTaken: true, notSure: false, time: now, notes: '', mealId: null, glucose: '', ...over,
});

test('parseNumber accepts decimals and comma, rejects junk', () => {
  assert.equal(parseNumber('12'), 12);
  assert.equal(parseNumber('12,5'), 12.5);
  assert.equal(parseNumber(' .5 '), 0.5);
  assert.equal(parseNumber(''), null);
  assert.equal(parseNumber('abc'), null);
  assert.equal(parseNumber('1e3'), null);
  assert.equal(parseNumber('-4'), null);
});

test('newEventId always satisfies the server clientId rule', () => {
  for (let i = 0; i < 50; i++) assert.ok(isValidClientId(newEventId()));
  assert.equal(isValidClientId('short'), false);
  assert.equal(isValidClientId('has space in id'), false);
  assert.equal(isValidClientId('a'.repeat(81)), false);
  assert.equal(isValidClientId('abc-12345.XYZ_9'), true);
});

test('meal: carbs required, positive, capped, one decimal; field-level errors', () => {
  const empty = validateMeal(mealIn({ carbs: '' }), NOW);
  assert.equal(empty.ok, false);
  assert.match(empty.errors.carbs, /Enter/);
  assert.equal(validateMeal(mealIn({ carbs: '0' }), NOW).ok, false);
  assert.equal(validateMeal(mealIn({ carbs: '401' }), NOW).ok, false);
  const bad = validateMeal(mealIn({ fat: 'x', protein: '-1' }), NOW);
  assert.ok(bad.errors.fat && bad.errors.protein);
  const ok = validateMeal(mealIn({ carbs: '45,56', fat: '10', label: '  Pasta ', absorption: 'slow', timeApproximate: true }), NOW);
  assert.equal(ok.ok, true);
  assert.equal(ok.value.carbsG, 45.6);
  assert.equal(ok.value.fatG, 10);
  assert.equal(ok.value.proteinG, null);
  assert.equal(ok.value.label, 'Pasta');
  assert.equal(ok.value.absorptionClass, 'slow');
  assert.equal(ok.value.timeApproximate, true);
  assert.equal(validateMeal(mealIn(), NOW).value.label, 'Meal (entered manually)');
  assert.equal(validateMeal(mealIn(), NOW).value.absorptionClass, null);
});

test('insulin: units, type choice and the "actually took it" confirmation are mandatory', () => {
  assert.equal(validateInsulin(insIn({ units: '' }), NOW).ok, false);
  assert.equal(validateInsulin(insIn({ units: '0' }), NOW).ok, false, '0 U is only via the explicit "took none" action');
  assert.equal(validateInsulin(insIn({ units: '51' }), NOW).ok, false);
  assert.equal(validateInsulin(insIn({ units: '1.234' }), NOW).ok, false);
  const noType = validateInsulin(insIn({ insulinType: null }), NOW);
  assert.ok(noType.errors.insulinType, 'no assumed insulin type');
  const unconfirmed = validateInsulin(insIn({ confirmedTaken: false }), NOW);
  assert.ok(unconfirmed.errors.confirmedTaken);
  const ok = validateInsulin(insIn({ units: '4,5', notes: ' pen ' }), NOW);
  assert.equal(ok.ok, true);
  assert.equal(ok.value.unitsAdministered, 4.5);
  assert.equal(ok.value.confirmation, 'confirmed');
  assert.equal(ok.value.timingUncertain, false);
});

test('insulin: "not sure" -> uncertain + timingUncertain; meal link only for meal doses; glucose only for corrections', () => {
  const unsure = validateInsulin(insIn({ notSure: true }), NOW).value;
  assert.equal(unsure.confirmation, 'uncertain');
  assert.equal(unsure.timingUncertain, true);
  assert.equal(validateInsulin(insIn({ mealId: 'm1-local' }), NOW).value.mealId, 'm1-local');
  assert.equal(validateInsulin(insIn({ insulinKind: 'correction', mealId: 'm1-local' }), NOW).value.mealId, null);
  assert.equal(validateInsulin(insIn({ insulinKind: 'correction', glucose: '190' }), NOW).value.glucoseMgdl, 190);
  assert.equal(validateInsulin(insIn({ insulinKind: 'bolus', glucose: '190' }), NOW).value.glucoseMgdl, null);
  assert.ok(validateInsulin(insIn({ insulinKind: 'correction', glucose: '10' }), NOW).errors.glucose);
  assert.ok(validateInsulin(insIn({ insulinKind: 'correction', glucose: '700' }), NOW).errors.glucose);
});

test('"I took no insulin" is a confirmed 0 U meal bolus at the meal time, linked to the meal', () => {
  const ev = buildNoInsulinEvent('none-12345678', { occurredAtUtc: '2026-10-16T11:00:00.000Z', utcOffsetMin: 180, mealId: 'meal-uuid' });
  assert.equal(ev.unitsAdministered, 0);
  assert.equal(ev.confirmation, 'confirmed');
  assert.equal(ev.insulinKind, 'bolus');
  assert.equal(ev.mealId, 'meal-uuid');
  assert.equal(ev.occurredAtUtc, '2026-10-16T11:00:00.000Z');
  assert.match(describeEvent(ev).title, /No insulin taken/);
});

test('time: minutes-ago and clock are UTC ISO; future clock rolls to yesterday; >48 h refused', () => {
  const ago = resolveEventTime({ mode: 'minutesAgo', minutes: 30 }, NOW);
  assert.equal(ago.utcIso, '2026-10-16T11:30:00.000Z');
  assert.equal(ago.utcOffsetMin, -NOW.getTimezoneOffset());
  const local = new Date(NOW);
  local.setHours(local.getHours() + 1);
  const hhmm = `${local.getHours()}:${String(local.getMinutes()).padStart(2, '0')}`;
  const clock = resolveEventTime({ mode: 'clock', hhmm }, NOW);
  assert.ok(Date.parse(clock.utcIso) < NOW.getTime(), 'never in the future');
  assert.ok('error' in resolveEventTime({ mode: 'clock', hhmm: '25:00' }, NOW));
  assert.ok('error' in resolveEventTime({ mode: 'clock', hhmm: 'abc' }, NOW));
  assert.ok('error' in resolveEventTime({ mode: 'minutesAgo', minutes: -5 }, NOW));
  assert.ok('error' in resolveEventTime({ mode: 'minutesAgo', minutes: 49 * 60 }, NOW));
});

test('insertEvent is idempotent by id and keeps newest first', () => {
  const m = validateMeal(mealIn({ time: { mode: 'minutesAgo', minutes: 60 } }), NOW).value;
  const i = validateInsulin(insIn(), NOW).value;
  const meal = buildMealEvent('aaaaaaaa', m, { source: 'manual', aiCarbsG: null });
  const ins = buildInsulinEvent('bbbbbbbb', i);
  let list = insertEvent([], meal);
  list = insertEvent(list, meal);
  assert.equal(list.length, 1);
  list = insertEvent(list, ins);
  assert.deepEqual(list.map((e) => e.id), ['bbbbbbbb', 'aaaaaaaa']);
  assert.equal(insertEvent(list, { ...ins, unitsAdministered: 99 }).length, 2, 'same id never overwrites');
});

test('provenance: AI total kept beside the user value', () => {
  assert.equal(photoMealSource(false), 'gemini');
  assert.equal(photoMealSource(true), 'gemini_edited');
  const m = validateMeal(mealIn({ carbs: '60' }), NOW).value;
  const ev = buildMealEvent('xxxxxxxx', m, { source: photoMealSource(true), aiCarbsG: 48 });
  assert.equal(ev.carbsG, 60);
  assert.equal(ev.aiCarbsG, 48);
  assert.equal(ev.source, 'gemini_edited');
});
