import { describe, expect, it } from 'vitest';
import { dateRangeOf, rangeDates } from './inventory.service';

describe('date ranges', () => {
  it('stores inclusive end dates as half-open ranges and reads them back', () => {
    expect(dateRangeOf('2026-01-01', '2026-12-31')).toBe('[2026-01-01,2027-01-01)');
    expect(dateRangeOf('2026-02-28', '2026-02-28')).toBe('[2026-02-28,2026-03-01)');
    expect(dateRangeOf('2026-01-01', null)).toBe('[2026-01-01,)');
    expect(rangeDates('[2026-01-01,2027-01-01)')).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    expect(rangeDates('[2026-01-01,)')).toEqual({ from: '2026-01-01', to: null });
  });
});
