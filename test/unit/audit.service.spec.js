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
    svc = new AuditService(db.db, clock);
  });

  afterEach(() => db.close());

  test('log() writes a row', () => {
    svc.log({
      actorId: 'A', actorType: 'USER', action: 'TEST',
      targetType: 'REQUEST', targetId: 'r_1',
      before: { state: 'X' }, after: { state: 'Y' },
      correlationId: 'c',
    });
    const rows = db.db.prepare('SELECT * FROM audit_events').all();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('TEST');
    expect(JSON.parse(rows[0].before_json)).toEqual({ state: 'X' });
    expect(JSON.parse(rows[0].after_json)).toEqual({ state: 'Y' });
  });

  test('log() handles missing before/after', () => {
    svc.log({
      actorId: null, action: 'X',
      targetType: 'T', targetId: '1',
    });
    const row = db.db.prepare('SELECT * FROM audit_events').get();
    expect(row.before_json).toBeNull();
    expect(row.after_json).toBeNull();
    expect(row.actor_type).toBe('SYSTEM');
  });
});
