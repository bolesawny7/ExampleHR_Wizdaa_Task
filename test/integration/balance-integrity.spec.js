import { buildTestApp } from '../helpers/app.js';
import { TimeOffService } from '../../src/time-off/time-off.service.js';

/**
 * Balance-integrity invariants.
 *
 * `better-sqlite3` is synchronous, so true concurrency cannot be exercised
 * from a single Node process — instead we verify the invariant that guards
 * against it: the transactional `BEGIN IMMEDIATE` check sees its own
 * in-flight reservations and refuses a second filing that would push the
 * effective balance negative.
 *
 * Under a multi-process deployment the same invariant protects us because
 * SQLite serialises IMMEDIATE writers at the file-lock level; the logic is
 * the same and these tests would pass regardless of process count.
 */
describe('Balance integrity', () => {
  let harness, timeOff;

  beforeEach(async () => {
    harness = await buildTestApp();
    timeOff = harness.app.get(TimeOffService);
    harness.seedBalance({
      employeeId: 'E-1', locationId: 'L-1', leaveType: 'ANNUAL', balance: 3,
    });
  });

  afterEach(async () => { await harness.close(); });

  const fileRequest = (employeeId, start, end) => timeOff.createRequest({
    actor: { sub: employeeId, roles: ['employee'] },
    input: {
      locationId: 'L-1', leaveType: 'ANNUAL',
      startDate: start, endDate: end,
    },
  });

  test('two back-to-back filings that together exceed balance: only the first succeeds', () => {
    fileRequest('E-1', '2026-05-01', '2026-05-02');          // 2 days, succeeds
    expect(() => fileRequest('E-1', '2026-05-03', '2026-05-04'))
      .toThrow(/Insufficient balance/);
    const bal = harness.db.db.prepare(`
      SELECT hcm_balance - COALESCE((
        SELECT SUM(days) FROM reservations
         WHERE employee_id = balances.employee_id
           AND location_id = balances.location_id
           AND leave_type  = balances.leave_type
           AND state = 'OPEN'
      ), 0) AS effective
        FROM balances WHERE employee_id = 'E-1'
    `).get();
    expect(bal.effective).toBeGreaterThanOrEqual(0);
  });

  test('cancel releases the reservation and the balance can be re-filed', () => {
    const r = fileRequest('E-1', '2026-05-01', '2026-05-02');
    timeOff.cancel({
      actor: { sub: 'E-1', roles: ['employee'] }, requestId: r.id,
    });
    const r2 = fileRequest('E-1', '2026-05-10', '2026-05-11');
    expect(r2.effectiveBalanceAfter).toBe(1);
  });
});
