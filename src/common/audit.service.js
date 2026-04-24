import { Injectable } from '@nestjs/common';

/**
 * Append-only audit log.
 *
 * Every mutation in this service happens inside a DB transaction, so the
 * only public method is `logInTx(db, …)` which uses the transactional
 * connection passed in by the caller.  This keeps every audit event
 * ordered-consistent with the row being audited and prevents accidental
 * out-of-txn writes.
 */
@Injectable()
export class AuditService {
  constructor(clock) {
    this._clock = clock;
  }

  logInTx(db, entry) {
    db.prepare(
      `
      INSERT INTO audit_events
        (actor_id, actor_type, action, target_type, target_id,
         before_json, after_json, correlation_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      entry.actorId ?? null,
      entry.actorType ?? 'SYSTEM',
      entry.action,
      entry.targetType,
      String(entry.targetId),
      entry.before ? JSON.stringify(entry.before) : null,
      entry.after ? JSON.stringify(entry.after) : null,
      entry.correlationId ?? null,
      this._clock.now(),
    );
  }
}
