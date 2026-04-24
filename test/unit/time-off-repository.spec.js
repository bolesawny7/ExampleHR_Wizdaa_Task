import { TestClock } from '../../src/common/clock.js';
import { ConfigService } from '../../src/config/config.service.js';
import { DatabaseService } from '../../src/database/database.service.js';
import { NotFoundError } from '../../src/common/errors.js';
import { TimeOffRepository } from '../../src/time-off/time-off.repository.js';

describe('TimeOffRepository', () => {
  let clock, db, repo;

  beforeEach(() => {
    clock = new TestClock();
    db = new DatabaseService(new ConfigService({
      NODE_ENV: 'test', JWT_SECRET: 'x', DATABASE_PATH: ':memory:',
    }));
    db.open();
    repo = new TimeOffRepository(db);
  });

  afterEach(() => db.close());

  function row(id, overrides = {}) {
    return {
      id,
      employeeId: 'E-1',
      managerId: 'M-1',
      locationId: 'L-1',
      leaveType: 'ANNUAL',
      startDate: '2026-05-04',
      endDate: '2026-05-06',
      days: 3,
      reason: 'x',
      state: 'PENDING',
      createdAt: clock.now(),
      updatedAt: clock.now(),
      correlationId: 'c',
      externalRequestId: null,
      ...overrides,
    };
  }

  test('insert & findByIdOrThrow round-trip', () => {
    repo.insert(db.db, row('r_1'));
    const r = repo.findByIdOrThrow('r_1');
    expect(r.id).toBe('r_1');
    expect(r.state).toBe('PENDING');
  });

  test('findByIdOrThrow throws NotFoundError for missing id', () => {
    expect(() => repo.findByIdOrThrow('missing')).toThrow(NotFoundError);
  });

  test('listForEmployee orders by createdAt desc', () => {
    repo.insert(db.db, row('r_1', { createdAt: 1 }));
    repo.insert(db.db, row('r_2', { createdAt: 2 }));
    expect(repo.listForEmployee('E-1').map((r) => r.id)).toEqual(['r_2', 'r_1']);
  });

  test('listPendingForManager returns only PENDING for that manager', () => {
    repo.insert(db.db, row('r_1'));
    repo.insert(db.db, row('r_2', { state: 'APPROVED' }));
    repo.insert(db.db, row('r_3', { managerId: 'M-9' }));
    expect(repo.listPendingForManager('M-1').map((r) => r.id)).toEqual(['r_1']);
  });

  test('updateState is a no-op when fromState does not match', () => {
    repo.insert(db.db, row('r_1'));
    const ok = repo.updateState(db.db, 'r_1', 'APPROVED', 'CONSUMED', clock.now());
    expect(ok).toBe(false);
    expect(repo.findByIdOrThrow('r_1').state).toBe('PENDING');
  });

  test('updateState applies when fromState matches and persists patch fields', () => {
    repo.insert(db.db, row('r_1'));
    const ok = repo.updateState(
      db.db, 'r_1', 'PENDING', 'APPROVED', clock.now(),
      { approverId: 'M-1', approvedAt: clock.now(), externalRequestId: 'ext_x' },
    );
    expect(ok).toBe(true);
    const r = repo.findByIdOrThrow('r_1');
    expect(r.state).toBe('APPROVED');
    expect(r.approverId).toBe('M-1');
    expect(r.externalRequestId).toBe('ext_x');
  });
});
