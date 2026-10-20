import { describe, expect, it } from 'vitest';
import { firstDoseIdsOfLocalDays } from './first-dose.js';
import { localDayKey, localDayStartSec } from './time.js';

const utc = (y: number, mo: number, d: number, h: number, mi = 0): number => Date.UTC(y, mo - 1, d, h, mi) / 1000;

describe('first dose of the local day', () => {
  it('picks the earliest dose of each day, whenever the person wakes', () => {
    const doses = [
      { id: 'lunch', tSec: utc(2026, 10, 19, 12, 30) },
      { id: 'wake-late', tSec: utc(2026, 10, 19, 9, 40) }, // wakes at 9:40
      { id: 'dinner', tSec: utc(2026, 10, 19, 19) },
      { id: 'wake-early', tSec: utc(2026, 10, 20, 5, 10) }, // next day, wakes at 5:10
      { id: 'lunch2', tSec: utc(2026, 10, 20, 13) },
    ];
    expect([...firstDoseIdsOfLocalDays(doses, 'UTC')].sort()).toEqual(['wake-early', 'wake-late']);
  });

  it('a late-night dose still belongs to the previous day (day starts at 03:00), so the next morning dose is first', () => {
    const doses = [
      { id: 'night-snack', tSec: utc(2026, 10, 20, 1, 15) }, // 01:15 belongs to 19 Oct
      { id: 'dinner', tSec: utc(2026, 10, 19, 20) },
      { id: 'morning', tSec: utc(2026, 10, 20, 7) },
    ];
    expect([...firstDoseIdsOfLocalDays(doses, 'UTC')].sort()).toEqual(['dinner', 'morning']);
  });

  it('uses the person local time zone, not UTC', () => {
    // c = 22:00 UTC on 19 Oct and d = 00:30 UTC on 20 Oct. In UTC both fall on the 19th (before 03:00), so only c is first.
    // In Beirut (UTC+3) c is 01:00 on the 20th (still the 19th by the 03:00 rule) and d is 03:30 on the 20th (a new day), so both are first.
    const doses = [{ id: 'c', tSec: utc(2026, 10, 19, 22) }, { id: 'd', tSec: utc(2026, 10, 20, 0, 30) }];
    expect([...firstDoseIdsOfLocalDays(doses, 'UTC')]).toEqual(['c']);
    expect([...firstDoseIdsOfLocalDays(doses, 'Asia/Beirut')].sort()).toEqual(['c', 'd']);
  });

  it('is deterministic for ties, ignores order, and handles no doses', () => {
    const t = utc(2026, 10, 19, 8);
    expect([...firstDoseIdsOfLocalDays([{ id: 'z', tSec: t }, { id: 'a', tSec: t }], 'UTC')]).toEqual(['a']);
    expect(firstDoseIdsOfLocalDays([], 'UTC').size).toBe(0);
    const a = [{ id: '1', tSec: t }, { id: '2', tSec: t + 3600 }];
    expect([...firstDoseIdsOfLocalDays(a, 'UTC')]).toEqual([...firstDoseIdsOfLocalDays([...a].reverse(), 'UTC')]);
  });

  it('localDayKey / localDayStartSec: the day starts at 03:00 local', () => {
    expect(localDayKey(utc(2026, 10, 20, 2, 59), 'UTC')).toBe('2026-10-19');
    expect(localDayKey(utc(2026, 10, 20, 3, 0), 'UTC')).toBe('2026-10-20');
    expect(localDayStartSec(utc(2026, 10, 20, 14, 5), 'UTC')).toBe(utc(2026, 10, 20, 3));
    expect(localDayStartSec(utc(2026, 10, 20, 1, 0), 'UTC')).toBe(utc(2026, 10, 19, 3));
    expect(localDayStartSec(utc(2026, 10, 20, 14, 5), 'Asia/Beirut')).toBe(utc(2026, 10, 20, 0)); // 03:00 Beirut = 00:00 UTC
  });
});
