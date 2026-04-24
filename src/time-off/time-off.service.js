import { Injectable } from '@nestjs/common';
import {
  BalanceNotFoundError, ConflictError, ForbiddenDomainError,
  InsufficientBalanceError,
} from '../common/errors.js';
import { newCorrelationId, newExternalRequestId, newRequestId } from '../common/ids.js';
import { countDaysInclusive } from './dates.js';
import { STATES, assertTransition } from './state-machine.js';

/**
 * Core business logic for the request lifecycle.
 *
 * Every method that mutates runs inside a single BEGIN IMMEDIATE transaction
 * to guarantee balance-integrity invariants under concurrency (see TRD §C2).
 */
@Injectable()
export class TimeOffService {
  constructor(dbService, repo, balancesRepo, audit, clock, outbox) {
    this._dbService = dbService;
    this._repo = repo;
    this._balancesRepo = balancesRepo;
    this._audit = audit;
    this._clock = clock;
    this._outbox = outbox;
  }

  /**
   * File a new time-off request.  Balance is verified and a reservation is
   * committed atomically — concurrent filings for the same key will queue
   * on the BEGIN IMMEDIATE lock and see each other's reservations.
   */
  createRequest({ actor, input }) {
    // `countDaysInclusive` throws a `ValidationError` on malformed / inverted
    // dates; otherwise returns ≥ 1 by construction.
    const days = countDaysInclusive(input.startDate, input.endDate);
    const id = newRequestId();
    const correlationId = newCorrelationId();
    const now = this._clock.now();

    const tx = this._dbService.transaction((db) => {
      const bal = this._balancesRepo.findBalance(
        actor.sub, input.locationId, input.leaveType, db,
      );
      if (!bal) {
        throw new BalanceNotFoundError({
          employeeId: actor.sub,
          locationId: input.locationId,
          leaveType: input.leaveType,
        });
      }
      const reserved = this._balancesRepo.sumOpenReservations(
        actor.sub, input.locationId, input.leaveType, db,
      );
      const effective = round(bal.hcmBalance - reserved);
      if (effective < days) {
        throw new InsufficientBalanceError(effective, days);
      }

      const row = {
        id,
        employeeId: actor.sub,
        managerId: actor.managerId ?? null,
        locationId: input.locationId,
        leaveType: input.leaveType,
        startDate: input.startDate,
        endDate: input.endDate,
        days,
        reason: input.reason ?? null,
        state: STATES.PENDING,
        createdAt: now,
        updatedAt: now,
        correlationId,
        externalRequestId: null,
      };
      this._repo.insert(db, row);
      this._balancesRepo.insertReservation(db, {
        requestId: id,
        employeeId: actor.sub,
        locationId: input.locationId,
        leaveType: input.leaveType,
        days,
      }, now);

      this._audit.logInTx(db, {
        actorId: actor.sub,
        actorType: 'USER',
        action: 'REQUEST_CREATED',
        targetType: 'REQUEST',
        targetId: id,
        after: row,
        correlationId,
      });

      return {
        ...row,
        effectiveBalanceAfter: round(effective - days),
      };
    });
    return tx();
  }

  /**
   * Approve a PENDING request.  We write to `hcm_outbox` *inside the same
   * transaction* as the state change so we can't leak a "silently approved
   * but never submitted" request if the process dies.
   */
  approve({ actor, requestId }) {
    const now = this._clock.now();
    const tx = this._dbService.transaction((db) => {
      const before = this._repo.findByIdOrThrow(requestId, db);
      this._authorizeManager(actor, before);
      assertTransition(before.state, STATES.APPROVED);

      const externalRequestId = before.externalRequestId ?? newExternalRequestId();
      const ok = this._repo.updateState(
        db, requestId, before.state, STATES.APPROVED, now,
        { approverId: actor.sub, approvedAt: now, externalRequestId },
      );
      if (!ok) {
        throw new ConflictError('CONCURRENT_UPDATE',
          'Request state changed concurrently; please retry.');
      }

      this._outbox.enqueue(db, {
        requestId,
        op: 'CONSUME',
        payload: {
          employeeId: before.employeeId,
          locationId: before.locationId,
          leaveType: before.leaveType,
          days: before.days,
          startDate: before.startDate,
          endDate: before.endDate,
          externalRequestId,
          correlationId: before.correlationId,
        },
        now,
      });

      const after = this._repo.findByIdOrThrow(requestId, db);
      this._audit.logInTx(db, {
        actorId: actor.sub,
        actorType: 'USER',
        action: 'REQUEST_APPROVED',
        targetType: 'REQUEST',
        targetId: requestId,
        before, after,
        correlationId: before.correlationId,
      });
      return after;
    });
    return tx();
  }

  reject({ actor, requestId, reason = null }) {
    const now = this._clock.now();
    const tx = this._dbService.transaction((db) => {
      const before = this._repo.findByIdOrThrow(requestId, db);
      this._authorizeManager(actor, before);
      assertTransition(before.state, STATES.REJECTED);

      const ok = this._repo.updateState(
        db, requestId, before.state, STATES.REJECTED, now,
        { approverId: actor.sub, hcmError: reason },
      );
      if (!ok) {
        throw new ConflictError('CONCURRENT_UPDATE',
          'Request state changed concurrently; please retry.');
      }

      this._balancesRepo.releaseReservation(db, requestId, now);

      const after = this._repo.findByIdOrThrow(requestId, db);
      this._audit.logInTx(db, {
        actorId: actor.sub,
        actorType: 'USER',
        action: 'REQUEST_REJECTED',
        targetType: 'REQUEST',
        targetId: requestId,
        before, after,
        correlationId: before.correlationId,
      });
      return after;
    });
    return tx();
  }

  cancel({ actor, requestId }) {
    const now = this._clock.now();
    const tx = this._dbService.transaction((db) => {
      const before = this._repo.findByIdOrThrow(requestId, db);
      // Only the owning employee or an admin may cancel.
      const isOwner = before.employeeId === actor.sub;
      const isAdmin = actor.roles?.includes('admin');
      if (!isOwner && !isAdmin) {
        throw new ForbiddenDomainError('Cannot cancel another employee\'s request');
      }
      // Throws if not a legal transition.  CONSUMED requests cannot be
      // cancelled because the balance is already gone from HCM — a separate
      // "restore" flow would be needed and is out of scope.
      assertTransition(before.state, STATES.CANCELLED);
      this._repo.updateState(db, requestId, before.state, STATES.CANCELLED, now);
      this._balancesRepo.releaseReservation(db, requestId, now);

      const after = this._repo.findByIdOrThrow(requestId, db);
      this._audit.logInTx(db, {
        actorId: actor.sub,
        actorType: 'USER',
        action: 'REQUEST_CANCELLED',
        targetType: 'REQUEST',
        targetId: requestId,
        before, after,
        correlationId: before.correlationId,
      });
      return after;
    });
    return tx();
  }

  /**
   * Called by the outbox worker on a successful HCM consume.  Moves the
   * request to CONSUMED and marks the reservation consumed (not released —
   * the balance is actually gone).
   */
  markConsumed(requestId) {
    const now = this._clock.now();
    const tx = this._dbService.transaction((db) => {
      const before = this._repo.findByIdOrThrow(requestId, db);
      if (before.state === STATES.CONSUMED) return before;
      assertTransition(before.state, STATES.CONSUMED);
      this._repo.updateState(db, requestId, before.state, STATES.CONSUMED, now);
      this._balancesRepo.consumeReservation(db, requestId, now);
      const after = this._repo.findByIdOrThrow(requestId, db);
      this._audit.logInTx(db, {
        actorType: 'SYSTEM',
        action: 'REQUEST_CONSUMED',
        targetType: 'REQUEST',
        targetId: requestId,
        before, after,
        correlationId: before.correlationId,
      });
      return after;
    });
    return tx();
  }

  /**
   * Called by the outbox worker when HCM permanently rejects.  Moves the
   * request to HCM_FAILED and releases the reservation so the employee gets
   * their balance back.
   */
  markHcmFailed(requestId, errorMessage) {
    const now = this._clock.now();
    const tx = this._dbService.transaction((db) => {
      const before = this._repo.findByIdOrThrow(requestId, db);
      if (before.state === STATES.HCM_FAILED) return before;
      assertTransition(before.state, STATES.HCM_FAILED);
      this._repo.updateState(
        db, requestId, before.state, STATES.HCM_FAILED, now,
        { hcmError: errorMessage },
      );
      this._balancesRepo.releaseReservation(db, requestId, now);
      const after = this._repo.findByIdOrThrow(requestId, db);
      this._audit.logInTx(db, {
        actorType: 'SYSTEM',
        action: 'REQUEST_HCM_FAILED',
        targetType: 'REQUEST',
        targetId: requestId,
        before, after,
        correlationId: before.correlationId,
      });
      return after;
    });
    return tx();
  }

  /**
   * Called by the reconciliation service when HCM drift would make an
   * approved request unserviceable.  Pauses it for human review.
   */
  markReviewRequired(requestId, reason) {
    const now = this._clock.now();
    const tx = this._dbService.transaction((db) => {
      const before = this._repo.findByIdOrThrow(requestId, db);
      if (before.state === STATES.REVIEW_REQUIRED) return before;
      assertTransition(before.state, STATES.REVIEW_REQUIRED);
      this._repo.updateState(
        db, requestId, before.state, STATES.REVIEW_REQUIRED, now,
        { hcmError: reason },
      );
      const after = this._repo.findByIdOrThrow(requestId, db);
      this._audit.logInTx(db, {
        actorType: 'SYSTEM',
        action: 'REQUEST_REVIEW_REQUIRED',
        targetType: 'REQUEST',
        targetId: requestId,
        before, after,
        correlationId: before.correlationId,
      });
      return after;
    });
    return tx();
  }

  listForEmployee(employeeId) { return this._repo.listForEmployee(employeeId); }
  listForManager(managerId) { return this._repo.listPendingForManager(managerId); }
  getById(id) { return this._repo.findByIdOrThrow(id); }

  _authorizeManager(actor, request) {
    const isAdmin = actor.roles?.includes('admin');
    if (isAdmin) return;
    if (!actor.roles?.includes('manager')) {
      throw new ForbiddenDomainError('Requires manager role');
    }
    if (request.managerId && request.managerId !== actor.sub) {
      throw new ForbiddenDomainError('Not this employee\'s manager');
    }
  }
}

function round(n) { return Math.round(n * 100) / 100; }
