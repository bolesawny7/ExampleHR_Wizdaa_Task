import { Injectable, Logger } from '@nestjs/common';

/**
 * Transactional outbox for HCM writes.
 *
 * The point of this pattern: approving a request and "decide to call HCM"
 * must be atomic.  So we write the intent to a row in the same DB
 * transaction as the state change.  A background worker consumes that table.
 *
 * Retry policy: exponential backoff with jitter, capped at maxAttempts.
 * Permanent (4xx) errors short-circuit the retry loop.
 */
@Injectable()
export class HcmOutboxService {
  constructor(dbService, clock, config) {
    this._logger = new Logger('HcmOutboxService');
    this._dbService = dbService;
    this._clock = clock;
    this._maxAttempts = config.outboxMaxAttempts;
    this._batchSize = config.outboxBatchSize;
  }

  /** Must be called from inside a `db.transaction()` callback. */
  enqueue(db, { requestId, op, payload, now }) {
    db.prepare(`
      INSERT INTO hcm_outbox
        (request_id, op, payload, attempts, next_attempt_at, status, created_at, updated_at)
      VALUES (?, ?, ?, 0, ?, 'PENDING', ?, ?)
    `).run(requestId, op, JSON.stringify(payload), now, now, now);
  }

  /**
   * Atomically claim up to `batchSize` due entries and mark them INFLIGHT.
   * The caller processes them and then calls `markDone` or `scheduleRetry`.
   */
  claimDue() {
    const now = this._clock.now();
    const tx = this._dbService.transaction((db) => {
      const rows = db.prepare(`
        SELECT id, request_id AS requestId, op, payload, attempts
          FROM hcm_outbox
         WHERE status = 'PENDING' AND next_attempt_at <= ?
         ORDER BY id ASC LIMIT ?
      `).all(now, this._batchSize);
      if (rows.length === 0) return [];
      const ids = rows.map((r) => r.id);
      const placeholders = ids.map(() => '?').join(',');
      db.prepare(`
        UPDATE hcm_outbox SET status = 'INFLIGHT', updated_at = ?
         WHERE id IN (${placeholders})
      `).run(now, ...ids);
      return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
    });
    return tx();
  }

  markDone(id) {
    const now = this._clock.now();
    this._dbService.db.prepare(`
      UPDATE hcm_outbox
         SET status = 'DONE', updated_at = ?, last_error = NULL
       WHERE id = ?
    `).run(now, id);
  }

  scheduleRetry(id, errorMessage) {
    const now = this._clock.now();
    const tx = this._dbService.transaction((db) => {
      const row = db.prepare(
        'SELECT attempts FROM hcm_outbox WHERE id = ?',
      ).get(id);
      if (!row) return;
      const nextAttempts = row.attempts + 1;
      if (nextAttempts >= this._maxAttempts) {
        db.prepare(`
          UPDATE hcm_outbox
             SET status = 'DEAD', attempts = ?, updated_at = ?, last_error = ?
           WHERE id = ?
        `).run(nextAttempts, now, errorMessage, id);
        return;
      }
      const backoff = computeBackoffMs(nextAttempts);
      db.prepare(`
        UPDATE hcm_outbox
           SET status = 'PENDING', attempts = ?, updated_at = ?,
               next_attempt_at = ?, last_error = ?
         WHERE id = ?
      `).run(nextAttempts, now, now + backoff, errorMessage, id);
    });
    tx();
  }

  markDead(id, errorMessage) {
    const now = this._clock.now();
    this._dbService.db.prepare(`
      UPDATE hcm_outbox
         SET status = 'DEAD', updated_at = ?, last_error = ?
       WHERE id = ?
    `).run(now, errorMessage, id);
  }

  list({ status, limit = 100 } = {}) {
    if (status) {
      return this._dbService.db.prepare(`
        SELECT id, request_id AS requestId, op, attempts, status,
               next_attempt_at AS nextAttemptAt, last_error AS lastError,
               created_at AS createdAt, updated_at AS updatedAt
          FROM hcm_outbox
         WHERE status = ?
         ORDER BY id DESC LIMIT ?
      `).all(status, limit);
    }
    return this._dbService.db.prepare(`
      SELECT id, request_id AS requestId, op, attempts, status,
             next_attempt_at AS nextAttemptAt, last_error AS lastError,
             created_at AS createdAt, updated_at AS updatedAt
        FROM hcm_outbox
       ORDER BY id DESC LIMIT ?
    `).all(limit);
  }

  resetForTest(id) {
    this._dbService.db.prepare(`
      UPDATE hcm_outbox
         SET status = 'PENDING', next_attempt_at = 0, attempts = 0,
             last_error = NULL
       WHERE id = ?
    `).run(id);
  }
}

function computeBackoffMs(attempt) {
  // 2^attempt * 500ms, capped at 60s, with up to ±30% jitter.
  const base = Math.min(60_000, 2 ** attempt * 500);
  const jitter = base * 0.3 * (Math.random() * 2 - 1);
  return Math.max(100, Math.floor(base + jitter));
}

export const __testing = { computeBackoffMs };
