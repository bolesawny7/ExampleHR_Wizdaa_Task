import { Injectable } from '@nestjs/common';

const TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Idempotency store keyed on (key, endpoint, actorId).
 *
 * Usage:
 *   const cached = idem.lookup(k, ep, actor);
 *   if (cached) return cached;
 *   const result = doWork();
 *   idem.store(k, ep, actor, 200, result);
 *
 * Rationale: scoping the key to the endpoint and actor prevents two different
 * principals from colliding on the same opaque key, and prevents the same key
 * from being reused for e.g. POST /requests and POST /requests/cancel.
 */
@Injectable()
export class IdempotencyService {
  constructor(db, clock) {
    this._db = db;
    this._clock = clock;
  }

  lookup(key, endpoint, actorId) {
    if (!key) return null;
    const row = this._db
      .prepare(
        `
      SELECT status_code, response, expires_at
        FROM idempotency_keys
       WHERE key = ? AND endpoint = ? AND actor_id = ?
    `,
      )
      .get(key, endpoint, actorId);
    if (!row) return null;
    if (row.expires_at < this._clock.now()) {
      this._db
        .prepare(
          `
        DELETE FROM idempotency_keys WHERE key = ? AND endpoint = ? AND actor_id = ?
      `,
        )
        .run(key, endpoint, actorId);
      return null;
    }
    return {
      statusCode: row.status_code,
      response: JSON.parse(row.response),
    };
  }

  store(key, endpoint, actorId, statusCode, response) {
    if (!key) return;
    const now = this._clock.now();
    this._db
      .prepare(
        `
      INSERT OR REPLACE INTO idempotency_keys
        (key, endpoint, actor_id, status_code, response, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(key, endpoint, actorId, statusCode, JSON.stringify(response), now, now + TTL_MS);
  }
}
