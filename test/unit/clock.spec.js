import { Clock } from '../../src/common/clock.js';
import { TestClock } from '../helpers/test-clock.js';

describe('Clock', () => {
  test('production Clock returns the current epoch millis', () => {
    const before = Date.now();
    const now = new Clock().now();
    const after = Date.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });

  test('TestClock is deterministic and steppable', () => {
    const c = new TestClock(1000);
    expect(c.now()).toBe(1000);
    c.advance(250);
    expect(c.now()).toBe(1250);
  });
});
