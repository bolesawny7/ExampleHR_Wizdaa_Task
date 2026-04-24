import { Injectable, Logger } from '@nestjs/common';
import { STATES } from '../time-off/state-machine.js';

/**
 * Drift detection and healing (see TRD §C3).
 *
 * Three entry points:
 *   - reconcileKey(key): reconcile a single (employee, location, leaveType).
 *   - reconcileActive({ sinceMs }): pull-style reconciliation over recently
 *     active keys, intended to run on a cron.
 *   - handleBatch(batch): apply a full-corpus batch from HCM, one key at a
 *     time, within its own transaction.
 *
 * All three converge on the same `applyHcmBalanceSnapshot()` in BalancesService
 * so the audit trail, invariant checks, and negative-drift handling are
 * consistent regardless of which direction the drift was noticed from.
 */
@Injectable()
export class ReconciliationService {
  constructor(balancesService, balancesRepo, timeOff, hcmClient, clock) {
    this._logger = new Logger('ReconciliationService');
    this._balancesService = balancesService;
    this._balancesRepo = balancesRepo;
    this._timeOff = timeOff;
    this._hcm = hcmClient;
    this._clock = clock;
  }

  async reconcileKey({ employeeId, locationId, leaveType, correlationId = null }) {
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
      correlationId,
    });
    if (result.negativeDrift) this._escalateAffectedRequests(result);
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
   * transaction so a single bad row can't poison the batch.  Returns a
   * per-row summary for observability.
   */
  handleBatch({ batchId, asOf, balances, correlationId = null }) {
    const applied = [];
    for (const b of balances) {
      const r = this._balancesService.applyHcmBalanceSnapshot({
        employeeId: b.employeeId,
        locationId: b.locationId,
        leaveType: b.leaveType,
        balance: b.balance,
        asOf: b.asOf ?? asOf ?? this._clock.now(),
        source: 'HCM_BATCH',
        correlationId,
      });
      if (r.negativeDrift) this._escalateAffectedRequests(r);
      applied.push({
        key: `${b.employeeId}:${b.locationId}:${b.leaveType}`,
        ignored: r.ignored,
        negativeDrift: r.negativeDrift,
      });
    }
    return { batchId, appliedCount: applied.length, applied };
  }

  _escalateAffectedRequests({ balance }) {
    // All APPROVED requests for the affected key get REVIEW_REQUIRED so a
    // human can decide between cancel / partial / retry.
    const rows = this._balancesRepo.db.prepare(`
      SELECT id FROM requests
       WHERE employee_id = ? AND location_id = ? AND leave_type = ?
             AND state = ?
    `).all(balance.employeeId, balance.locationId, balance.leaveType, STATES.APPROVED);
    for (const r of rows) {
      try {
        this._timeOff.markReviewRequired(
          r.id,
          `HCM balance fell below open reservations`,
        );
      } catch (err) {
        this._logger.warn(`Escalation failed for ${r.id}: ${err.message}`);
      }
    }
  }
}
