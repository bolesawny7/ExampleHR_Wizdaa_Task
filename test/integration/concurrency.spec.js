import { buildTestApp } from '../helpers/app.js';
import { TimeOffService } from '../../src/time-off/time-off.service.js';

/**
 * Concurrency test.  better-sqlite3 is synchronous, so "concurrent" writes
 * are serialised at the JS level.  To exercise the invariant that two
 * overlapping filings cannot both succeed, we run many pairs sequentially
 * against a freshly-seeded key.  If the invariant check were racy, even one
 * iteration would produce a negative effective balance.
 */
describe('Concurrency / balance integrity', () => {
  let harness, timeOff;

  beforeEach(async () => {
    harness = await buildTestApp();
    timeOff = harness.app.get(TimeOffService);
  });

  afterEach(async () => { await harness.close(); });

  test('two filings for the same key never exceed balance (100 iterations)', () => {
    for (let i = 0; i < 100; i++) {
      // Reset DB state by seeding a new key each iteration.
      const eid = `E-${i}`;
      harness.seedBalance({
        employeeId: eid, locationId: 'L-1', leaveType: 'ANNUAL', balance: 3,
      });

      const first = () => timeOff.createRequest({
        actor: { sub: eid, roles: ['employee'] },
        input: {
          locationId: 'L-1', leaveType: 'ANNUAL',
          startDate: '2026-05-01', endDate: '2026-05-02',
        },
      });
      const second = () => timeOff.createRequest({
        actor: { sub: eid, roles: ['employee'] },
        input: {
          locationId: 'L-1', leaveType: 'ANNUAL',
          startDate: '2026-05-03', endDate: '2026-05-04',
        },
      });

      let firstOk = false, secondOk = false;
      try { first(); firstOk = true; } catch { /* ignore */ }
      try { second(); secondOk = true; } catch { /* ignore */ }

      // Only one of them can succeed (balance 3, each request 2 days).
      expect(firstOk && !secondOk).toBe(true);

      const bal = harness.db.db.prepare(`
        SELECT hcm_balance AS h,
               COALESCE((SELECT SUM(days) FROM reservations
                          WHERE employee_id = balances.employee_id
                            AND location_id = balances.location_id
                            AND leave_type  = balances.leave_type
                            AND state = 'OPEN'), 0) AS r
          FROM balances
         WHERE employee_id = ?
      `).get(eid);
      expect(bal.h - bal.r).toBeGreaterThanOrEqual(0);
    }
  });

  test('cancel + re-file within balance works correctly', () => {
    harness.seedBalance({
      employeeId: 'E-1', locationId: 'L-1', leaveType: 'ANNUAL', balance: 2,
    });
    const r = timeOff.createRequest({
      actor: { sub: 'E-1', roles: ['employee'] },
      input: {
        locationId: 'L-1', leaveType: 'ANNUAL',
        startDate: '2026-05-01', endDate: '2026-05-02',
      },
    });
    timeOff.cancel({
      actor: { sub: 'E-1', roles: ['employee'] }, requestId: r.id,
    });
    // Now balance is 2 again, we can re-file.
    const r2 = timeOff.createRequest({
      actor: { sub: 'E-1', roles: ['employee'] },
      input: {
        locationId: 'L-1', leaveType: 'ANNUAL',
        startDate: '2026-05-10', endDate: '2026-05-11',
      },
    });
    expect(r2.effectiveBalanceAfter).toBe(0);
  });
});
