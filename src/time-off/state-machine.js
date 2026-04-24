import { InvalidStateTransitionError } from '../common/errors.js';

/**
 * Time-off request state machine (see TRD §5.3).
 *
 * Keeping this as a pure, data-only module lets us test it exhaustively
 * without DB or HTTP plumbing.
 */
export const STATES = Object.freeze({
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
  CONSUMED: 'CONSUMED',
  HCM_FAILED: 'HCM_FAILED',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
});

export const TERMINAL = new Set([
  STATES.REJECTED, STATES.CANCELLED, STATES.CONSUMED, STATES.HCM_FAILED,
]);

/**
 * Maps fromState -> Set(toState).  Sparse on purpose: every missing edge
 * throws InvalidStateTransitionError.
 */
const TRANSITIONS = {
  [STATES.PENDING]: new Set([
    STATES.APPROVED, STATES.REJECTED, STATES.CANCELLED,
  ]),
  [STATES.APPROVED]: new Set([
    STATES.CONSUMED, STATES.CANCELLED, STATES.HCM_FAILED, STATES.REVIEW_REQUIRED,
  ]),
  [STATES.REVIEW_REQUIRED]: new Set([
    STATES.APPROVED, STATES.REJECTED, STATES.CANCELLED,
  ]),
  [STATES.REJECTED]: new Set(),
  [STATES.CANCELLED]: new Set(),
  [STATES.CONSUMED]: new Set(),
  [STATES.HCM_FAILED]: new Set([STATES.CANCELLED]),
};

export function canTransition(from, to) {
  return TRANSITIONS[from]?.has(to) === true;
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new InvalidStateTransitionError(from, to);
  }
}

/**
 * Does entering `to` imply releasing the reservation?
 *   CANCELLED / REJECTED / HCM_FAILED -> yes
 *   CONSUMED -> no (consumed, not released)
 *   others -> no
 */
export function entryReleasesReservation(to) {
  return to === STATES.CANCELLED
      || to === STATES.REJECTED
      || to === STATES.HCM_FAILED;
}

export function entryConsumesReservation(to) {
  return to === STATES.CONSUMED;
}

export function isTerminal(state) {
  return TERMINAL.has(state);
}
