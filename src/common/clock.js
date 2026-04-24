import { Injectable } from '@nestjs/common';

/**
 * Single source of truth for "now".  Centralising time access lets tests
 * freeze or step time deterministically without monkey-patching `Date`.
 */
@Injectable()
export class Clock {
  now() {
    return Date.now();
  }
}

/** Deterministic clock for tests. */
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
