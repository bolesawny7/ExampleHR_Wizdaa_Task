import { Injectable } from '@nestjs/common';

/**
 * Append-only audit log.  Never update/delete rows; retention & archival are
 * handled out of band.  Callers should pass a correlationId when available so
 * a full request's "story" can be reconstructed.
 */
@Injectable()
export class AuditService {
  constructor(db, clock) {
    this._db = db;
    this._clock = clock;
    this._insert = null;
  }

  _stmt() {
    if (!this._insert) {
      this._insert = this._db.prepare(`
        INSERT INTO audit_events
          (actor_id, actor_type, action, target_type, target_id,
           before_json, after_json, correlation_id, created_at)
        VALUES (@actor_id, @actor_type, @action, @target_type, @target_id,
                @before_json, @after_json, @correlation_id, @created_at)
      `);
    }
    return this._insert;
  }

  log({
    actorId = null,
    actorType = 'SYSTEM',
    action,
    targetType,
    targetId,
    before = null,
    after = null,
    correlationId = null,
  }) {
    this._stmt().run({
      actor_id: actorId,
      actor_type: actorType,
      action,
      target_type: targetType,
      target_id: String(targetId),
      before_json: before ? JSON.stringify(before) : null,
      after_json: after ? JSON.stringify(after) : null,
      correlation_id: correlationId,
      created_at: this._clock.now(),
    });
  }

  /**
   * Convenience for use inside a `db.transaction()` callback where we already
   * hold the write lock; uses the passed-in `db` rather than the live handle.
   */
  logInTx(db, entry) {
    db.prepare(`
      INSERT INTO audit_events
        (actor_id, actor_type, action, target_type, target_id,
         before_json, after_json, correlation_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
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
