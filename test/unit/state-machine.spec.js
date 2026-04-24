import {
  STATES, assertTransition, canTransition,
} from '../../src/time-off/state-machine.js';

describe('state-machine', () => {
  const allStates = Object.values(STATES);

  test.each([
    [STATES.PENDING, STATES.APPROVED, true],
    [STATES.PENDING, STATES.REJECTED, true],
    [STATES.PENDING, STATES.CANCELLED, true],
    [STATES.PENDING, STATES.CONSUMED, false],
    [STATES.APPROVED, STATES.CONSUMED, true],
    [STATES.APPROVED, STATES.CANCELLED, true],
    [STATES.APPROVED, STATES.HCM_FAILED, true],
    [STATES.APPROVED, STATES.REVIEW_REQUIRED, true],
    [STATES.APPROVED, STATES.PENDING, false],
    [STATES.REVIEW_REQUIRED, STATES.APPROVED, true],
    [STATES.REVIEW_REQUIRED, STATES.REJECTED, true],
    [STATES.REVIEW_REQUIRED, STATES.CANCELLED, true],
    [STATES.REJECTED, STATES.APPROVED, false],
    [STATES.CANCELLED, STATES.APPROVED, false],
    [STATES.CONSUMED, STATES.CANCELLED, false],
    [STATES.HCM_FAILED, STATES.CANCELLED, true],
    [STATES.HCM_FAILED, STATES.APPROVED, false],
  ])('canTransition %s -> %s = %s', (from, to, expected) => {
    expect(canTransition(from, to)).toBe(expected);
  });

  test('assertTransition throws on denied transitions', () => {
    expect(() => assertTransition(STATES.PENDING, STATES.CONSUMED))
      .toThrow(/Cannot transition/);
  });

  test('assertTransition is a no-op on allowed transitions', () => {
    expect(() => assertTransition(STATES.PENDING, STATES.APPROVED)).not.toThrow();
  });

  test('terminal states allow no forward transitions (except HCM_FAILED → CANCELLED)', () => {
    for (const from of [STATES.REJECTED, STATES.CANCELLED, STATES.CONSUMED]) {
      for (const to of allStates) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  test('unknown from-state is never a valid origin', () => {
    expect(canTransition('NOT_A_STATE', STATES.PENDING)).toBe(false);
  });
});
