import { Injectable } from '@nestjs/common';

/**
 * Single source of truth for "now".  Centralising time access lets tests
 * freeze or step time deterministically without monkey-patching `Date`.
 *
 * The deterministic `TestClock` lives in `test/helpers/test-clock.js` so it
 * is never included in a production build.
 */
@Injectable()
export class Clock {
  now() {
    return Date.now();
  }
}
