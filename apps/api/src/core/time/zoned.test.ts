import { describe, expect, it } from 'vitest';
import { atLocalTime } from './zoned';

describe('atLocalTime', () => {
  it('follows daylight saving time', () => {
    expect(atLocalTime('2026-10-20', 17, 'Europe/Bucharest').toISOString()).toBe('2026-10-20T14:00:00.000Z'); // EEST
    expect(atLocalTime('2026-11-20', 17, 'Europe/Bucharest').toISOString()).toBe('2026-11-20T15:00:00.000Z'); // EET
  });

  it('works for other zones and UTC', () => {
    expect(atLocalTime('2026-07-01', 9, 'Asia/Seoul').toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(atLocalTime('2026-07-01', 17, 'UTC').toISOString()).toBe('2026-07-01T17:00:00.000Z');
  });
});
