import { __testing } from '../../src/hcm/hcm-outbox.service.js';

const { computeBackoffMs } = __testing;

describe('computeBackoffMs', () => {
  test('is monotonically non-decreasing on average', () => {
    const avg = (n, iters = 100) => {
      let sum = 0;
      for (let i = 0; i < iters; i++) sum += computeBackoffMs(n);
      return sum / iters;
    };
    expect(avg(1)).toBeLessThan(avg(2));
    expect(avg(2)).toBeLessThan(avg(3));
    expect(avg(3)).toBeLessThan(avg(4));
  });

  test('is capped at 60s ± jitter', () => {
    // After enough attempts, even with + 30% jitter, we are bounded to ~ 78s.
    for (let i = 0; i < 50; i++) {
      expect(computeBackoffMs(20)).toBeLessThan(78_001);
    }
  });

  test('never returns negative', () => {
    for (let n = 1; n <= 15; n++) {
      for (let i = 0; i < 50; i++) {
        expect(computeBackoffMs(n)).toBeGreaterThan(0);
      }
    }
  });
});
