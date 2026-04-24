import {
  STATES, assertTransition, canTransition, entryConsumesReservation,
  entryReleasesReservation, isTerminal,
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

  test('terminal states do not allow forward transitions (except HCM_FAILED → CANCELLED)', () => {
    for (const from of [STATES.REJECTED, STATES.CANCELLED, STATES.CONSUMED]) {
      for (const to of allStates) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  test('entryReleasesReservation only for CANCELLED/REJECTED/HCM_FAILED', () => {
    expect(entryReleasesReservation(STATES.CANCELLED)).toBe(true);
    expect(entryReleasesReservation(STATES.REJECTED)).toBe(true);
    expect(entryReleasesReservation(STATES.HCM_FAILED)).toBe(true);
    expect(entryReleasesReservation(STATES.CONSUMED)).toBe(false);
    expect(entryReleasesReservation(STATES.APPROVED)).toBe(false);
    expect(entryReleasesReservation(STATES.PENDING)).toBe(false);
  });

  test('entryConsumesReservation only for CONSUMED', () => {
    expect(entryConsumesReservation(STATES.CONSUMED)).toBe(true);
    for (const s of allStates.filter((x) => x !== STATES.CONSUMED)) {
      expect(entryConsumesReservation(s)).toBe(false);
    }
  });

  test('isTerminal classification', () => {
    expect(isTerminal(STATES.REJECTED)).toBe(true);
    expect(isTerminal(STATES.CANCELLED)).toBe(true);
    expect(isTerminal(STATES.CONSUMED)).toBe(true);
    expect(isTerminal(STATES.HCM_FAILED)).toBe(true);
    expect(isTerminal(STATES.PENDING)).toBe(false);
    expect(isTerminal(STATES.APPROVED)).toBe(false);
    expect(isTerminal(STATES.REVIEW_REQUIRED)).toBe(false);
  });
});
