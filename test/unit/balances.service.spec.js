import { AuditService } from '../../src/common/audit.service.js';
import { TestClock } from '../helpers/test-clock.js';
import { BalancesRepository } from '../../src/balances/balances.repository.js';
import { BalancesService } from '../../src/balances/balances.service.js';
import { ConfigService } from '../../src/config/config.service.js';
import { DatabaseService } from '../../src/database/database.service.js';

/**
 * Pure unit-style tests on BalancesService with an in-memory SQLite DB but
 * no Nest container.  Exercises the invariants of
 *   - effective balance math
 *   - snapshot monotonicity
 *   - negative drift detection
 */
describe('BalancesService', () => {
  let clock, db, repo, audit, svc;

  beforeEach(() => {
    clock = new TestClock();
    const config = new ConfigService({
      NODE_ENV: 'test',
      JWT_SECRET: 'x',
      DATABASE_PATH: ':memory:',
    });
    db = new DatabaseService(config);
    db.open();
    repo = new BalancesRepository(db);
    audit = new AuditService(clock);
    svc = new BalancesService(db, repo, audit, clock);
  });

  afterEach(() => {
    db.close();
  });

  function seed(balance) {
    svc.applyHcmBalanceSnapshot({
      employeeId: 'E-1',
      locationId: 'L-1',
      leaveType: 'ANNUAL',
      balance,
      asOf: clock.now(),
    });
  }

  function insertReservation(requestId, days) {
    db.db
      .prepare(
        `
      INSERT INTO requests
        (id, employee_id, location_id, leave_type, start_date, end_date, days,
         state, created_at, updated_at, correlation_id)
      VALUES (?, 'E-1', 'L-1', 'ANNUAL', '2026-05-01', '2026-05-02', ?,
              'PENDING', ?, ?, 'c')
    `,
      )
      .run(requestId, days, clock.now(), clock.now());
    db.db
      .prepare(
        `
      INSERT INTO reservations
        (request_id, employee_id, location_id, leave_type, days, state,
         created_at, updated_at)
      VALUES (?, 'E-1', 'L-1', 'ANNUAL', ?, 'OPEN', ?, ?)
    `,
      )
      .run(requestId, days, clock.now(), clock.now());
  }

  test('effective balance = hcm - open reservations', () => {
    seed(10);
    expect(svc.getEffectiveBalance('E-1', 'L-1', 'ANNUAL').effectiveBalance).toBe(10);

    insertReservation('r_1', 2);

    const eff = svc.getEffectiveBalance('E-1', 'L-1', 'ANNUAL');
    expect(eff.reserved).toBe(2);
    expect(eff.effectiveBalance).toBe(8);
  });

  test('throws BalanceNotFoundError for unknown key', () => {
    expect(() => svc.getEffectiveBalance('E-x', 'L-x', 'ANNUAL')).toThrow(/No balance for key/);
  });

  test('applyHcmBalanceSnapshot is idempotent on identical asOf', () => {
    const asOf = clock.now();
    const r1 = svc.applyHcmBalanceSnapshot({
      employeeId: 'E-1',
      locationId: 'L-1',
      leaveType: 'ANNUAL',
      balance: 10,
      asOf,
    });
    const r2 = svc.applyHcmBalanceSnapshot({
      employeeId: 'E-1',
      locationId: 'L-1',
      leaveType: 'ANNUAL',
      balance: 10,
      asOf,
    });
    expect(r1.balance.version).toBe(1);
    expect(r2.balance.version).toBe(2); // no-op but version bumps
    expect(r2.balance.hcmBalance).toBe(10);
  });

  test('applyHcmBalanceSnapshot ignores stale asOf', () => {
    svc.applyHcmBalanceSnapshot({
      employeeId: 'E-1',
      locationId: 'L-1',
      leaveType: 'ANNUAL',
      balance: 10,
      asOf: 2000,
    });
    const r = svc.applyHcmBalanceSnapshot({
      employeeId: 'E-1',
      locationId: 'L-1',
      leaveType: 'ANNUAL',
      balance: 20,
      asOf: 1000,
    });
    expect(r.ignored).toBe(true);
    expect(r.balance.hcmBalance).toBe(10);
  });

  test('negativeDrift flag when new balance < open reservations', () => {
    seed(10);
    insertReservation('r_2', 6);

    clock.advance(1000);
    const r = svc.applyHcmBalanceSnapshot({
      employeeId: 'E-1',
      locationId: 'L-1',
      leaveType: 'ANNUAL',
      balance: 4,
      asOf: clock.now(),
    });
    expect(r.negativeDrift).toBe(true);

    const audits = db.db
      .prepare('SELECT action FROM audit_events ORDER BY id')
      .all()
      .map((r) => r.action);
    expect(audits).toContain('BALANCE_SNAPSHOT_NEGATIVE_DRIFT');
  });

  test('listing returns all (location, leaveType) rows for employee', () => {
    seed(10);
    svc.applyHcmBalanceSnapshot({
      employeeId: 'E-1',
      locationId: 'L-2',
      leaveType: 'ANNUAL',
      balance: 5,
      asOf: clock.now(),
    });
    svc.applyHcmBalanceSnapshot({
      employeeId: 'E-1',
      locationId: 'L-1',
      leaveType: 'SICK',
      balance: 7,
      asOf: clock.now(),
    });

    const list = svc.getEffectiveBalancesForEmployee('E-1');
    expect(list).toHaveLength(3);
    expect(list.every((b) => b.employeeId === 'E-1')).toBe(true);
  });
});
