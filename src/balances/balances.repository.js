import { Injectable } from '@nestjs/common';

/**
 * All balance + reservation SQL lives here.  Every method that mutates
 * must either be called from inside a DatabaseService.transaction() or take
 * an explicit `db` handle so it runs on the transactional connection.
 */
@Injectable()
export class BalancesRepository {
  constructor(dbService) {
    this._dbService = dbService;
  }

  get db() {
    return this._dbService.db;
  }

  findBalance(employeeId, locationId, leaveType, db = this.db) {
    return db.prepare(`
      SELECT id, employee_id AS employeeId, location_id AS locationId,
             leave_type AS leaveType, hcm_balance AS hcmBalance,
             hcm_snapshot_at AS hcmSnapshotAt, updated_at AS updatedAt, version
        FROM balances
       WHERE employee_id = ? AND location_id = ? AND leave_type = ?
    `).get(employeeId, locationId, leaveType) ?? null;
  }

  listBalancesForEmployee(employeeId, db = this.db) {
    return db.prepare(`
      SELECT id, employee_id AS employeeId, location_id AS locationId,
             leave_type AS leaveType, hcm_balance AS hcmBalance,
             hcm_snapshot_at AS hcmSnapshotAt, updated_at AS updatedAt, version
        FROM balances
       WHERE employee_id = ?
       ORDER BY location_id, leave_type
    `).all(employeeId);
  }

  sumOpenReservations(employeeId, locationId, leaveType, db = this.db) {
    const row = db.prepare(`
      SELECT COALESCE(SUM(days), 0) AS total
        FROM reservations
       WHERE employee_id = ? AND location_id = ? AND leave_type = ?
             AND state = 'OPEN'
    `).get(employeeId, locationId, leaveType);
    return row?.total ?? 0;
  }

  upsertBalance(db, row, now) {
    const existing = this.findBalance(row.employeeId, row.locationId, row.leaveType, db);
    if (!existing) {
      db.prepare(`
        INSERT INTO balances
          (employee_id, location_id, leave_type, hcm_balance,
           hcm_snapshot_at, updated_at, version)
        VALUES (?, ?, ?, ?, ?, ?, 1)
      `).run(row.employeeId, row.locationId, row.leaveType, row.hcmBalance,
             row.hcmSnapshotAt, now);
      return { ...row, version: 1, updatedAt: now };
    }
    // Reject out-of-order snapshots: a batch from earlier than what we have
    // should not overwrite a newer one.
    if (row.hcmSnapshotAt < existing.hcmSnapshotAt) {
      return existing;
    }
    db.prepare(`
      UPDATE balances
         SET hcm_balance = ?, hcm_snapshot_at = ?, updated_at = ?, version = version + 1
       WHERE id = ?
    `).run(row.hcmBalance, row.hcmSnapshotAt, now, existing.id);
    return {
      ...existing,
      hcmBalance: row.hcmBalance,
      hcmSnapshotAt: row.hcmSnapshotAt,
      updatedAt: now,
      version: existing.version + 1,
    };
  }

  insertReservation(db, reservation, now) {
    const info = db.prepare(`
      INSERT INTO reservations
        (request_id, employee_id, location_id, leave_type, days, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'OPEN', ?, ?)
    `).run(reservation.requestId, reservation.employeeId, reservation.locationId,
           reservation.leaveType, reservation.days, now, now);
    return info.lastInsertRowid;
  }

  findReservationForRequest(requestId, db = this.db) {
    return db.prepare(`
      SELECT id, request_id AS requestId, employee_id AS employeeId,
             location_id AS locationId, leave_type AS leaveType,
             days, state, created_at AS createdAt, updated_at AS updatedAt
        FROM reservations
       WHERE request_id = ?
    `).get(requestId) ?? null;
  }

  releaseReservation(db, requestId, now) {
    db.prepare(`
      UPDATE reservations
         SET state = 'RELEASED', updated_at = ?
       WHERE request_id = ? AND state = 'OPEN'
    `).run(now, requestId);
  }

  consumeReservation(db, requestId, now) {
    db.prepare(`
      UPDATE reservations
         SET state = 'CONSUMED', updated_at = ?
       WHERE request_id = ? AND state = 'OPEN'
    `).run(now, requestId);
  }

  /**
   * Returns all `(employee, location, leaveType)` keys where either the
   * balance or a reservation was touched in the last `sinceMs` ms.  Used by
   * the reconciliation service to size the pull-window.
   */
  activeKeysSince(sinceMs, db = this.db) {
    return db.prepare(`
      SELECT DISTINCT employee_id AS employeeId, location_id AS locationId,
             leave_type AS leaveType
        FROM (
          SELECT employee_id, location_id, leave_type, updated_at FROM balances
          UNION ALL
          SELECT employee_id, location_id, leave_type, updated_at FROM reservations
        )
       WHERE updated_at >= ?
    `).all(sinceMs);
  }
}
