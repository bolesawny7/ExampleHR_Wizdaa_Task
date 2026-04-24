import { Injectable } from '@nestjs/common';

/**
 * A single source of truth for "now".
 *
 * Centralising time access lets tests freeze or step time deterministically
 * without monkey-patching Date globally.
 */
@Injectable()
export class Clock {
  now() {
    return Date.now();
  }
}

/**
 * In-memory mutable clock for tests. Not exported from the barrel; tests
 * import directly to replace the provider.
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
  set(ms) {
    this._t = ms;
  }
}
