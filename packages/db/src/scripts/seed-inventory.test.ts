import { describe, expect, it } from 'vitest';
import { apportion } from './seed-inventory';

describe('apportion', () => {
  it('splits a total by weights, adding up exactly', () => {
    expect(apportion(20_000, [50, 25, 8, 7, 7, 3])).toEqual([10_000, 5_000, 1_600, 1_400, 1_400, 600]);
    // 95 weights: the rounding remainder goes to the largest fractions.
    const cities = [30, 7, 7, 7, 6, 5, 5, 5, 4, 4, 3, 3, 3, 3, 2, 1];
    for (const total of [1, 22, 9_999, 10_000, 20_000]) {
      const parts = apportion(total, cities);
      expect(
        parts.reduce((a, b) => a + b, 0),
        String(total),
      ).toBe(total);
      expect(Math.min(...parts)).toBeGreaterThanOrEqual(0);
    }
    expect(apportion(0, [1, 2])).toEqual([0, 0]);
  });
});
