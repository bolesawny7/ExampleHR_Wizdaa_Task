import { InvalidStateTransitionError } from '../common/errors.js';

/**
 * Time-off request state machine (see TRD §5.3).
 *
 * Pure, data-only module — no DB or HTTP plumbing — so it can be tested
 * exhaustively in isolation.
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

/**
 * Adjacency set for allowed transitions.  Sparse on purpose: any missing
 * edge is rejected by `assertTransition`.  Terminal states are represented
 * as empty sets (CONSUMED/REJECTED/CANCELLED).  HCM_FAILED is allowed to
 * move to CANCELLED so ops can clean up after permanent HCM failures.
 */
const TRANSITIONS = {
  [STATES.PENDING]: new Set([STATES.APPROVED, STATES.REJECTED, STATES.CANCELLED]),
  [STATES.APPROVED]: new Set([
    STATES.CONSUMED,
    STATES.CANCELLED,
    STATES.HCM_FAILED,
    STATES.REVIEW_REQUIRED,
  ]),
  [STATES.REVIEW_REQUIRED]: new Set([STATES.APPROVED, STATES.REJECTED, STATES.CANCELLED]),
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
