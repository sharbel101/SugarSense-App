import { describe, expect, it } from 'vitest';
import { SHORT_HISTORY_HORIZON_MIN, shortHistoryBaseline, shortHistorySigma } from './short-history.js';

const T0 = 1_800_000_000;
const at = (minAgo: number, mgdl: number) => ({ sec: T0 - minAgo * 60, mgdl });

describe('short-history fallback', () => {
  it('works with 4 readings and stops at 60 minutes', () => {
    const r = shortHistoryBaseline([at(15, 100), at(10, 100), at(5, 100), at(0, 100)]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.readingsUsed).toBe(4);
    expect(r.baseline[0]?.minutes).toBe(5);
    expect(r.baseline.at(-1)?.minutes).toBe(SHORT_HISTORY_HORIZON_MIN);
    expect(r.baseline.every((p) => p.value === 100)).toBe(true); // flat in, flat out
  });

  it('follows a rising trend but far less than a straight line', () => {
    const r = shortHistoryBaseline([at(15, 100), at(10, 110), at(5, 120), at(0, 130)]); // +2 mg/dL/min
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const h60 = r.baseline.find((p) => p.minutes === 60)?.value as number;
    expect(h60).toBeGreaterThan(130);
    expect(h60).toBeLessThan(130 + 2 * 60 * 0.5);
  });

  it('refuses fewer than 4 readings, a hole over 10 minutes, and readings that are all old', () => {
    expect(shortHistoryBaseline([at(10, 100), at(5, 100), at(0, 100)]).ok).toBe(false);
    expect(shortHistoryBaseline([at(30, 100), at(20, 100), at(5, 100), at(0, 100)]).ok).toBe(false);
    expect(shortHistoryBaseline([at(40, 100), at(35, 100), at(30, 100), at(0, 100)]).ok).toBe(false);
    expect(shortHistoryBaseline([]).ok).toBe(false);
  });

  it('uses only the latest 5 readings and ignores order of input', () => {
    const r = shortHistoryBaseline([at(0, 150), at(20, 80), at(5, 140), at(15, 120), at(10, 130), at(25, 60)]);
    expect(r.ok && r.readingsUsed).toBe(5);
  });

  it('sigma is zero at now, grows with the horizon, and is capped past 60', () => {
    expect(shortHistorySigma(0)).toBe(0);
    expect(shortHistorySigma(30)).toBeCloseTo(29, 5);
    expect(shortHistorySigma(60)).toBeGreaterThan(shortHistorySigma(30));
    expect(shortHistorySigma(90)).toBe(shortHistorySigma(60));
  });
});
