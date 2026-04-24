import { Clock } from '../../src/common/clock.js';

/**
 * Deterministic clock for tests.  Subclasses `Clock` so it satisfies the
 * same DI contract.
 */
export class TestClock extends Clock {
  constructor(start = 1_700_000_000_000) {
    super();
    this._t = start;
  }
  now() {
    return this._t;
  }
  advance(ms) {
    this._t += ms;
  }
}
