import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, daysBetween, isKiokuDay, kiokuDay } from '../../src/review/day.ts';

// Kioku days use local wall-clock time. This file runs in its own worker process (vitest forks).
const originalTz = process.env.TZ;
afterAll(() => { if (originalTz === undefined) delete process.env.TZ; else process.env.TZ = originalTz; });

describe('Kioku day with the default 04:00 boundary', () => {
  beforeAll(() => { process.env.TZ = 'Asia/Tokyo'; });
  it('counts 00:00–03:59 local time as the previous day', () => {
    expect(kiokuDay(new Date(2026, 9, 2, 3, 59, 59), 4)).toBe('2026-10-01');
    expect(kiokuDay(new Date(2026, 9, 2, 4, 0, 0), 4)).toBe('2026-10-02');
    expect(kiokuDay(new Date(2026, 9, 2, 23, 59), 4)).toBe('2026-10-02');
    expect(kiokuDay(new Date(2026, 0, 1, 1, 0), 4)).toBe('2025-12-31');
    expect(kiokuDay(new Date(2028, 2, 1, 2, 0), 4)).toBe('2028-02-29');
  });
  it('follows a configured boundary (0 = midnight, 23)', () => {
    expect(kiokuDay(new Date(2026, 9, 2, 0, 0), 0)).toBe('2026-10-02');
    expect(kiokuDay(new Date(2026, 9, 2, 22, 59), 23)).toBe('2026-10-01');
    expect(kiokuDay(new Date(2026, 9, 2, 23, 0), 23)).toBe('2026-10-02');
  });
  it('does day arithmetic on calendar dates', () => {
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(daysBetween('2026-10-02', '2026-10-05')).toBe(3);
    expect(daysBetween('2026-10-05', '2026-10-02')).toBe(-3);
    expect(['2026-10-02', '2028-02-29'].every(isKiokuDay)).toBe(true);
    expect(['2026-02-29', '2026-13-01', '2026-1-2', '', null].some(isKiokuDay)).toBe(false);
  });
});

describe('Kioku day across daylight-saving transitions', () => {
  beforeAll(() => { process.env.TZ = 'America/New_York'; });
  it('keeps the local 04:00 boundary on spring-forward and fall-back days', () => {
    // 2026-03-08: 02:00 → 03:00. 2026-11-01: 02:00 → 01:00.
    expect(new Date(2026, 2, 8, 12).getTimezoneOffset()).not.toBe(new Date(2026, 2, 7, 12).getTimezoneOffset());
    expect(kiokuDay(new Date(2026, 2, 8, 3, 30), 4)).toBe('2026-03-07');
    expect(kiokuDay(new Date(2026, 2, 8, 4, 0), 4)).toBe('2026-03-08');
    expect(kiokuDay(new Date(2026, 10, 1, 1, 30), 4)).toBe('2026-10-31');
    expect(kiokuDay(new Date(Date.UTC(2026, 10, 1, 6, 30)), 4)).toBe('2026-10-31'); // second 01:30 (EST)
    expect(kiokuDay(new Date(2026, 10, 1, 4, 0), 4)).toBe('2026-11-01');
    // A boundary inside the skipped hour: 03:00 is already after 02:00.
    expect(kiokuDay(new Date(2026, 2, 8, 3, 0), 2)).toBe('2026-03-08');
    expect(daysBetween('2026-03-07', '2026-03-10')).toBe(3);
    expect(addDays('2026-10-31', 2)).toBe('2026-11-02');
  });
});
