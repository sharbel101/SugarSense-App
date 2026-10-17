// Run: npm run test:history  (pure module)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { carbsText, dayKey, dayLabel, groupMealsByDay, lastDays, mealTitle, trendDisplay } from '../src/services/mealHistory.ts';

const NOW = new Date(2026, 9, 17, 14, 0, 0);
const at = (dayOffset, h, m = 0) => new Date(2026, 9, 17 + dayOffset, h, m, 0).toISOString();
const meal = (id, eatenAt, grams, over = {}) => ({
  id, label: null, eatenAt, status: 'confirmed', carbs: { grams, kind: 'estimated', estimateRangeG: null },
  fatG: null, proteinG: null, fiberG: null, absorptionClass: null, timeApproximateMin: 0, edited: false, revision: 1, ...over,
});

test('days are local calendar days, newest first, with Today and Yesterday labels', () => {
  assert.deepEqual(lastDays(NOW, 3), ['2026-10-17', '2026-10-16', '2026-10-15']);
  assert.equal(dayKey(NOW), '2026-10-17');
  assert.equal(dayLabel('2026-10-17', NOW), 'Today');
  assert.equal(dayLabel('2026-10-16', NOW), 'Yesterday');
  assert.notEqual(dayLabel('2026-10-15', NOW), 'Yesterday');
});

test('meals are grouped by day, newest first, cancelled meals dropped', () => {
  const meals = [
    meal('a', at(0, 8), 40),
    meal('b', at(0, 12, 30), 60),
    meal('c', at(-1, 19), 55),
    meal('d', at(0, 9), 20, { status: 'cancelled' }),
  ];
  const [today, yesterday, before] = groupMealsByDay(meals, NOW);
  assert.deepEqual(today.meals.map((m) => m.id), ['b', 'a']);
  assert.equal(today.totalCarbsG, 100);
  assert.deepEqual(yesterday.meals.map((m) => m.id), ['c']);
  assert.equal(before.meals.length, 0, 'an empty day is still returned so the screen can say so');
  assert.equal(before.totalCarbsG, null);
});

test('unknown carbs are listed but never counted as 0 g', () => {
  const [today] = groupMealsByDay([meal('a', at(0, 8), null), meal('b', at(0, 9), 30)], NOW);
  assert.equal(today.totalCarbsG, 30);
  assert.equal(today.unknownCount, 1);
  assert.equal(carbsText(today.meals[1]), 'carbs unknown');
  const [onlyUnknown] = groupMealsByDay([meal('a', at(0, 8), null)], NOW);
  assert.equal(onlyUnknown.totalCarbsG, null);
});

test('titles use the stored name or a plain default', () => {
  assert.equal(mealTitle(meal('a', at(0, 8), 10, { label: 'Pasta' })), 'Pasta');
  assert.equal(mealTitle(meal('a', at(0, 8), 10)), 'Meal');
});

test('trend text: null is not supplied, never "steady"', () => {
  assert.equal(trendDisplay(null), null);
  assert.equal(trendDisplay(Number.NaN), null);
  assert.equal(trendDisplay(0.1).text, 'Steady');
  assert.equal(trendDisplay(1.2).arrow, '↗');
  assert.equal(trendDisplay(2.5).arrow, '↑');
  assert.equal(trendDisplay(-1).arrow, '↘');
  assert.equal(trendDisplay(-3).arrow, '↓');
});
