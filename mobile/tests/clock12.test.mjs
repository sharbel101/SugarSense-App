import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatHhmm12, formatTime12, hhmmTo12, parseClock12 } from '../src/services/clock12.ts';

const at = (h, m) => new Date(2026, 9, 18, h, m, 0, 0);

test('formatTime12: AM/PM for every hour of the day, midnight and noon are 12', () => {
  assert.equal(formatTime12(at(0, 5)), '12:05 AM');
  assert.equal(formatTime12(at(1, 25)), '1:25 AM');
  assert.equal(formatTime12(at(11, 59)), '11:59 AM');
  assert.equal(formatTime12(at(12, 0)), '12:00 PM');
  assert.equal(formatTime12(at(13, 7)), '1:07 PM');
  assert.equal(formatTime12(at(23, 30)), '11:30 PM');
  assert.equal(formatTime12(new Date('nope')), '');
});

test('hhmmTo12 / formatHhmm12: 24-hour strings shown as 12-hour, invalid input left alone', () => {
  assert.deepEqual(hhmmTo12('00:00'), { text: '12:00', meridiem: 'AM' });
  assert.deepEqual(hhmmTo12('14:30'), { text: '2:30', meridiem: 'PM' });
  assert.deepEqual(hhmmTo12('7:05'), { text: '7:05', meridiem: 'AM' });
  assert.equal(hhmmTo12('24:00'), null);
  assert.equal(hhmmTo12('abc'), null);
  assert.equal(formatHhmm12('07:30'), '7:30 AM');
  assert.equal(formatHhmm12('00:00'), '12:00 AM');
  assert.equal(formatHhmm12('oops'), 'oops');
});

test('parseClock12: typed time + AM/PM chip gives the right 24-hour time', () => {
  const ok = (text, mer) => parseClock12(text, mer);
  assert.deepEqual(ok('2:30', 'PM'), { ok: true, hhmm: '14:30', meridiem: 'PM' });
  assert.deepEqual(ok('2:30', 'AM'), { ok: true, hhmm: '02:30', meridiem: 'AM' });
  assert.deepEqual(ok('12:15', 'AM'), { ok: true, hhmm: '00:15', meridiem: 'AM' }, '12 AM is just after midnight');
  assert.deepEqual(ok('12:15', 'PM'), { ok: true, hhmm: '12:15', meridiem: 'PM' }, '12 PM is just after noon');
  assert.deepEqual(ok('230', 'PM'), { ok: true, hhmm: '14:30', meridiem: 'PM' }, 'no colon');
  assert.deepEqual(ok('9', 'PM'), { ok: true, hhmm: '21:00', meridiem: 'PM' }, 'hour only');
  assert.deepEqual(ok('1230', 'AM'), { ok: true, hhmm: '00:30', meridiem: 'AM' });
});

test('parseClock12: a typed am/pm wins over the chips; 13-23 is read as 24-hour and the chip is corrected', () => {
  assert.deepEqual(parseClock12('2:30 pm', 'AM'), { ok: true, hhmm: '14:30', meridiem: 'PM' });
  assert.deepEqual(parseClock12('2:30AM', 'PM'), { ok: true, hhmm: '02:30', meridiem: 'AM' });
  assert.deepEqual(parseClock12('7p', 'AM'), { ok: true, hhmm: '19:00', meridiem: 'PM' });
  assert.deepEqual(parseClock12('14:30', 'AM'), { ok: true, hhmm: '14:30', meridiem: 'PM' });
  assert.deepEqual(parseClock12('0:30', 'PM'), { ok: true, hhmm: '00:30', meridiem: 'AM' });
});

test('parseClock12: rejects what is not a time', () => {
  for (const bad of ['', '  ', 'abc', '2:5', '2:60', '25:00', '99', '2:30:10', '-1:00', '2.30']) {
    assert.equal(parseClock12(bad, 'AM').ok, false, `"${bad}" must be rejected`);
  }
});
