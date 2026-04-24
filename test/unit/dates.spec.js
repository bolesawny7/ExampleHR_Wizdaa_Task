import { countDaysInclusive, parseIsoDate } from '../../src/time-off/dates.js';

describe('dates', () => {
  test('parseIsoDate rejects bad strings', () => {
    expect(() => parseIsoDate('2026/04/24')).toThrow();
    expect(() => parseIsoDate('2026-4-24')).toThrow();
    expect(() => parseIsoDate('2026-02-30')).toThrow();      // nonexistent
    expect(() => parseIsoDate('not-a-date')).toThrow();
    expect(() => parseIsoDate(null)).toThrow();
    expect(() => parseIsoDate(20260424)).toThrow();
  });

  test('parseIsoDate accepts valid ISO', () => {
    const d = parseIsoDate('2026-04-24');
    expect(d.getUTCFullYear()).toBe(2026);
    expect(d.getUTCMonth()).toBe(3);
    expect(d.getUTCDate()).toBe(24);
  });

  test('countDaysInclusive single day = 1', () => {
    expect(countDaysInclusive('2026-04-24', '2026-04-24')).toBe(1);
  });

  test('countDaysInclusive span across months', () => {
    expect(countDaysInclusive('2026-04-30', '2026-05-02')).toBe(3);
  });

  test('countDaysInclusive spans across leap day', () => {
    expect(countDaysInclusive('2028-02-28', '2028-03-01')).toBe(3);
  });

  test('countDaysInclusive throws if end before start', () => {
    expect(() => countDaysInclusive('2026-04-25', '2026-04-24')).toThrow();
  });
});
