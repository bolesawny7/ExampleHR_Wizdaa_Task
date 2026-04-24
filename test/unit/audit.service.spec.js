import { AuditService } from '../../src/common/audit.service.js';
import { TestClock } from '../../src/common/clock.js';
import { ConfigService } from '../../src/config/config.service.js';
import { DatabaseService } from '../../src/database/database.service.js';

describe('AuditService', () => {
  let db, svc, clock;

  beforeEach(() => {
    clock = new TestClock();
    db = new DatabaseService(new ConfigService({
      NODE_ENV: 'test', JWT_SECRET: 'x', DATABASE_PATH: ':memory:',
    }));
    db.open();
    svc = new AuditService(clock);
  });

  afterEach(() => db.close());

  test('logInTx writes a full row', () => {
    svc.logInTx(db.db, {
      actorId: 'A', actorType: 'USER', action: 'TEST',
      targetType: 'REQUEST', targetId: 'r_1',
      before: { state: 'X' }, after: { state: 'Y' },
      correlationId: 'c',
    });
    const rows = db.db.prepare('SELECT * FROM audit_events').all();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('TEST');
    expect(rows[0].actor_type).toBe('USER');
    expect(JSON.parse(rows[0].before_json)).toEqual({ state: 'X' });
    expect(JSON.parse(rows[0].after_json)).toEqual({ state: 'Y' });
    expect(rows[0].created_at).toBe(clock.now());
  });

  test('logInTx defaults and null-safe for missing optional fields', () => {
    svc.logInTx(db.db, {
      action: 'X',
      targetType: 'T',
      targetId: 1,
    });
    const row = db.db.prepare('SELECT * FROM audit_events').get();
    expect(row.before_json).toBeNull();
    expect(row.after_json).toBeNull();
    expect(row.actor_id).toBeNull();
    expect(row.actor_type).toBe('SYSTEM');
    expect(row.correlation_id).toBeNull();
    // target_id is coerced to string even if passed as number
    expect(row.target_id).toBe('1');
  });
});
