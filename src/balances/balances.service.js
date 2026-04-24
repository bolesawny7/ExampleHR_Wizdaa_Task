import { Injectable } from '@nestjs/common';
import { BalanceNotFoundError } from '../common/errors.js';

/**
 * Read-only balance queries + the single entry point for applying HCM
 * snapshots.  Mutations that deduct (reservations) live in TimeOffService
 * because they are coupled to the request state machine.
 */
@Injectable()
export class BalancesService {
  constructor(dbService, balancesRepo, audit, clock) {
    this._dbService = dbService;
    this._repo = balancesRepo;
    this._audit = audit;
    this._clock = clock;
  }

  getEffectiveBalance(employeeId, locationId, leaveType) {
    const bal = this._repo.findBalance(employeeId, locationId, leaveType);
    if (!bal) throw new BalanceNotFoundError({ employeeId, locationId, leaveType });
    const reserved = this._repo.sumOpenReservations(employeeId, locationId, leaveType);
    return {
      ...bal,
      reserved,
      effectiveBalance: round(bal.hcmBalance - reserved),
    };
  }

  getEffectiveBalancesForEmployee(employeeId) {
    const list = this._repo.listBalancesForEmployee(employeeId);
    return list.map((bal) => {
      const reserved = this._repo.sumOpenReservations(
        bal.employeeId, bal.locationId, bal.leaveType,
      );
      return {
        ...bal,
        reserved,
        effectiveBalance: round(bal.hcmBalance - reserved),
      };
    });
  }

  /**
   * Apply an HCM-authoritative balance snapshot.
   *
   * Invariants enforced:
   *  - Monotonic asOf: older snapshots are ignored.
   *  - Reservations are never touched.
   *  - If new hcm_balance < open reservations for key, a `NEGATIVE_DRIFT`
   *    audit event is emitted and returned to the caller so it can escalate
   *    affected requests to REVIEW_REQUIRED.
   *
   * Idempotent: calling with identical asOf is a no-op.
   */
  applyHcmBalanceSnapshot({ employeeId, locationId, leaveType, balance, asOf,
                            source = 'HCM_BATCH', correlationId = null }) {
    const now = this._clock.now();
    const tx = this._dbService.transaction((db) => {
      const before = this._repo.findBalance(employeeId, locationId, leaveType, db);
      const updated = this._repo.upsertBalance(db, {
        employeeId, locationId, leaveType,
        hcmBalance: balance,
        hcmSnapshotAt: asOf,
      }, now);

      const ignored = before && asOf < before.hcmSnapshotAt;
      const reserved = this._repo.sumOpenReservations(employeeId, locationId, leaveType, db);
      const negativeDrift = !ignored && balance < reserved;

      this._audit.logInTx(db, {
        actorType: 'HCM',
        action: ignored ? 'BALANCE_SNAPSHOT_IGNORED_STALE' :
                negativeDrift ? 'BALANCE_SNAPSHOT_NEGATIVE_DRIFT' :
                                'BALANCE_SNAPSHOT_APPLIED',
        targetType: 'BALANCE',
        targetId: `${employeeId}:${locationId}:${leaveType}`,
        before,
        after: updated,
        correlationId,
      });

      return {
        balance: updated,
        ignored,
        negativeDrift,
        reserved,
        source,
      };
    });
    return tx();
  }
}

function round(n) {
  // Balances are days; 2 decimals is enough and avoids float noise.
  return Math.round(n * 100) / 100;
}
