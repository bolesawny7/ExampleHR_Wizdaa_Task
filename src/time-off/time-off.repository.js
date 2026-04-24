import { Injectable } from '@nestjs/common';
import { NotFoundError } from '../common/errors.js';

const COLUMNS = `
  id, employee_id AS employeeId, manager_id AS managerId,
  location_id AS locationId, leave_type AS leaveType,
  start_date AS startDate, end_date AS endDate, days,
  reason, state, created_at AS createdAt, updated_at AS updatedAt,
  approver_id AS approverId, approved_at AS approvedAt,
  external_request_id AS externalRequestId, hcm_error AS hcmError,
  correlation_id AS correlationId
`;

@Injectable()
export class TimeOffRepository {
  constructor(dbService) {
    this._dbService = dbService;
  }

  get db() {
    return this._dbService.db;
  }

  insert(db, row) {
    db.prepare(`
      INSERT INTO requests
        (id, employee_id, manager_id, location_id, leave_type,
         start_date, end_date, days, reason, state,
         created_at, updated_at, correlation_id, external_request_id)
      VALUES
        (@id, @employeeId, @managerId, @locationId, @leaveType,
         @startDate, @endDate, @days, @reason, @state,
         @createdAt, @updatedAt, @correlationId, @externalRequestId)
    `).run(row);
    return row;
  }

  findByIdOrThrow(id, db = this.db) {
    const row = db.prepare(`SELECT ${COLUMNS} FROM requests WHERE id = ?`).get(id);
    if (!row) throw new NotFoundError('Request', id);
    return row;
  }

  findById(id, db = this.db) {
    return db.prepare(`SELECT ${COLUMNS} FROM requests WHERE id = ?`).get(id) ?? null;
  }

  listForEmployee(employeeId, db = this.db) {
    return db.prepare(`
      SELECT ${COLUMNS} FROM requests
       WHERE employee_id = ? ORDER BY created_at DESC
    `).all(employeeId);
  }

  listPendingForManager(managerId, db = this.db) {
    return db.prepare(`
      SELECT ${COLUMNS} FROM requests
       WHERE manager_id = ? AND state = 'PENDING'
       ORDER BY created_at ASC
    `).all(managerId);
  }

  listByState(state, db = this.db) {
    return db.prepare(`
      SELECT ${COLUMNS} FROM requests WHERE state = ? ORDER BY updated_at ASC
    `).all(state);
  }

  updateState(db, id, fromState, toState, now, patch = {}) {
    const res = db.prepare(`
      UPDATE requests
         SET state = ?,
             updated_at = ?,
             approver_id = COALESCE(?, approver_id),
             approved_at = COALESCE(?, approved_at),
             external_request_id = COALESCE(?, external_request_id),
             hcm_error = COALESCE(?, hcm_error)
       WHERE id = ? AND state = ?
    `).run(
      toState, now,
      patch.approverId ?? null,
      patch.approvedAt ?? null,
      patch.externalRequestId ?? null,
      patch.hcmError ?? null,
      id, fromState,
    );
    return res.changes === 1;
  }
}
