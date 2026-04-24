import { Injectable, Logger } from '@nestjs/common';
import { HcmPermanentError } from '../common/errors.js';

/**
 * Drains the HCM outbox.
 *
 * On each tick:
 *   1. Claim due rows (INFLIGHT).
 *   2. For each, call `HcmClient.consumeBalance`.
 *   3. On success → mark request CONSUMED, outbox row DONE.
 *   4. On permanent failure (4xx) → mark request HCM_FAILED, outbox row DONE.
 *   5. On transient failure → reschedule with exponential backoff.
 *
 * Defensive step: before each CONSUME we re-read HCM's realtime balance.
 * If HCM now reports less than what we're about to consume we bail and
 * flag the request REVIEW_REQUIRED instead of relying on HCM to reject
 * (which the TRD §C4 documents cannot be trusted).
 *
 * CONSUME is currently the only outbox op; new ops can be added by
 * extending `_handleRow` with additional dispatch branches.
 */
@Injectable()
export class HcmOutboxWorker {
  constructor(outbox, hcmClient, timeOff, config) {
    this._logger = new Logger('HcmOutboxWorker');
    this._outbox = outbox;
    this._hcm = hcmClient;
    this._timeOff = timeOff;
    this._intervalMs = config.outboxIntervalMs;
    this._disabled = config.disableBackgroundJobs;
    this._timer = null;
    this._draining = false;
  }

  onModuleInit() { this.start(); }
  onModuleDestroy() { this.stop(); }

  start() {
    if (this._disabled || this._timer) return;
    this._timer = setInterval(() => this.tick().catch((err) => {
      this._logger.error(`Outbox tick failed: ${err.message}`);
    }), this._intervalMs);
    this._timer.unref?.();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /** Drain one batch.  Exposed so tests can step the worker deterministically. */
  async tick() {
    if (this._draining) return { processed: 0 };
    this._draining = true;
    try {
      const rows = this._outbox.claimDue();
      for (const row of rows) {
        await this._handleRow(row);
      }
      return { processed: rows.length };
    } finally {
      this._draining = false;
    }
  }

  async _handleRow(row) {
    try {
      const { employeeId, locationId, leaveType, days } = row.payload;
      let hcmView = null;
      try {
        hcmView = await this._hcm.getBalance({ employeeId, locationId, leaveType });
      } catch {
        // If we can't verify, fall through and let HCM be the authority on
        // whether the consume is OK.
      }
      if (hcmView && Number.isFinite(hcmView.balance) && hcmView.balance < days) {
        this._timeOff.markReviewRequired(
          row.requestId,
          `HCM balance ${hcmView.balance} < requested ${days} at submit time`,
        );
        this._outbox.markDone(row.id);
        return;
      }
      await this._hcm.consumeBalance(row.payload);
      this._timeOff.markConsumed(row.requestId);
      this._outbox.markDone(row.id);
    } catch (err) {
      if (err instanceof HcmPermanentError) {
        try {
          this._timeOff.markHcmFailed(row.requestId, err.message);
        } finally {
          this._outbox.markDone(row.id);
        }
        return;
      }
      this._outbox.scheduleRetry(row.id, err.message);
    }
  }
}
