import { Injectable, Logger } from '@nestjs/common';

/**
 * Drift detection and healing (see TRD §C3).
 *
 * Two entry points the app wires up:
 *   - `handleBatch(batch)`:    apply a full-corpus batch pushed from HCM.
 *   - `reconcileKey(key)`:     pull a single key from HCM (admin / ops).
 *
 * A third convenience, `reconcileActive(opts)`, iterates `reconcileKey`
 * over recently-active keys and is exposed on the admin endpoint for
 * on-demand bulk reconciliation.
 *
 * All paths converge on `applyHcmBalanceSnapshot()` in `BalancesService`
 * so invariant checks, audit trail, and negative-drift handling stay
 * consistent regardless of where the snapshot came from.
 */
@Injectable()
export class ReconciliationService {
  constructor(balancesService, balancesRepo, timeOffRepo, timeOff, hcmClient, clock) {
    this._logger = new Logger('ReconciliationService');
    this._balancesService = balancesService;
    this._balancesRepo = balancesRepo;
    this._timeOffRepo = timeOffRepo;
    this._timeOff = timeOff;
    this._hcm = hcmClient;
    this._clock = clock;
  }

  async reconcileKey({ employeeId, locationId, leaveType }) {
    let snapshot;
    try {
      snapshot = await this._hcm.getBalance({ employeeId, locationId, leaveType });
    } catch (err) {
      this._logger.warn(
        `reconcileKey ${employeeId}/${locationId}/${leaveType} HCM fetch failed: ${err.message}`,
      );
      return { skipped: true, reason: err.message };
    }
    const result = this._balancesService.applyHcmBalanceSnapshot({
      employeeId,
      locationId,
      leaveType,
      balance: snapshot.balance,
      asOf: snapshot.asOf ?? this._clock.now(),
      source: 'HCM_PULL',
    });
    if (result.negativeDrift) this._escalateAffectedRequests(result.balance);
    return result;
  }

  async reconcileActive({ sinceMs = 7 * 24 * 60 * 60 * 1000, limit = 200 } = {}) {
    const cutoff = this._clock.now() - sinceMs;
    const keys = this._balancesRepo.activeKeysSince(cutoff).slice(0, limit);
    const results = [];
    for (const key of keys) {
      results.push(await this.reconcileKey(key));
    }
    return { scanned: keys.length, results };
  }

  /**
   * Apply an inbound batch from HCM.  Each row is applied in its own
   * transaction so one bad row can't poison the batch.
   */
  handleBatch({ batchId, asOf, balances }) {
    const applied = [];
    for (const b of balances) {
      const r = this._balancesService.applyHcmBalanceSnapshot({
        employeeId: b.employeeId,
        locationId: b.locationId,
        leaveType: b.leaveType,
        balance: b.balance,
        asOf: b.asOf ?? asOf ?? this._clock.now(),
        source: 'HCM_BATCH',
      });
      if (r.negativeDrift) this._escalateAffectedRequests(r.balance);
      applied.push({
        key: `${b.employeeId}:${b.locationId}:${b.leaveType}`,
        ignored: r.ignored,
        negativeDrift: r.negativeDrift,
      });
    }
    return { batchId, appliedCount: applied.length, applied };
  }

  _escalateAffectedRequests(balance) {
    const ids = this._timeOffRepo.listApprovedIdsForKey(
      balance.employeeId,
      balance.locationId,
      balance.leaveType,
    );
    for (const id of ids) {
      try {
        this._timeOff.markReviewRequired(id, 'HCM balance fell below open reservations');
      } catch (err) {
        this._logger.warn(`Escalation failed for ${id}: ${err.message}`);
      }
    }
  }
}
