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

  function base(id, overrides = {}) {
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

  test('insert & findById round-trip', () => {
    repo.insert(db.db, base('r_1'));
    const r = repo.findById('r_1');
    expect(r.id).toBe('r_1');
  });

  test('findByIdOrThrow throws for missing', () => {
    expect(() => repo.findByIdOrThrow('missing')).toThrow(NotFoundError);
  });

  test('listForEmployee orders by createdAt desc', () => {
    repo.insert(db.db, base('r_1', { createdAt: 1 }));
    repo.insert(db.db, base('r_2', { createdAt: 2 }));
    const list = repo.listForEmployee('E-1');
    expect(list.map((r) => r.id)).toEqual(['r_2', 'r_1']);
  });

  test('listPendingForManager returns only PENDING for that manager', () => {
    repo.insert(db.db, base('r_1'));
    repo.insert(db.db, base('r_2', { state: 'APPROVED' }));
    repo.insert(db.db, base('r_3', { managerId: 'M-9' }));
    const list = repo.listPendingForManager('M-1');
    expect(list.map((r) => r.id)).toEqual(['r_1']);
  });

  test('listByState filters and orders', () => {
    repo.insert(db.db, base('r_1', { state: 'APPROVED', updatedAt: 1 }));
    repo.insert(db.db, base('r_2', { state: 'APPROVED', updatedAt: 2 }));
    const list = repo.listByState('APPROVED');
    expect(list.map((r) => r.id)).toEqual(['r_1', 'r_2']);
  });

  test('updateState is a no-op when the fromState does not match', () => {
    repo.insert(db.db, base('r_1'));
    const ok = repo.updateState(db.db, 'r_1', 'APPROVED', 'CONSUMED', clock.now());
    expect(ok).toBe(false);
    expect(repo.findById('r_1').state).toBe('PENDING');
  });

  test('updateState applies when fromState matches', () => {
    repo.insert(db.db, base('r_1'));
    const ok = repo.updateState(
      db.db, 'r_1', 'PENDING', 'APPROVED', clock.now(),
      { approverId: 'M-1', approvedAt: clock.now() },
    );
    expect(ok).toBe(true);
    const r = repo.findById('r_1');
    expect(r.state).toBe('APPROVED');
    expect(r.approverId).toBe('M-1');
  });
});
