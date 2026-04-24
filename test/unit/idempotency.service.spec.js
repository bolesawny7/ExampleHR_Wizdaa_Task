import { TestClock } from '../helpers/test-clock.js';
import { IdempotencyService } from '../../src/common/idempotency.service.js';
import { ConfigService } from '../../src/config/config.service.js';
import { DatabaseService } from '../../src/database/database.service.js';

describe('IdempotencyService', () => {
  let clock, db, svc;

  beforeEach(() => {
    clock = new TestClock();
    db = new DatabaseService(
      new ConfigService({
        NODE_ENV: 'test',
        JWT_SECRET: 'x',
        DATABASE_PATH: ':memory:',
      }),
    );
    db.open();
    svc = new IdempotencyService(db.db, clock);
  });

  afterEach(() => db.close());

  test('store then lookup returns the same response', () => {
    svc.store('k1', 'POST /x', 'E-1', 201, { id: 'r1' });
    expect(svc.lookup('k1', 'POST /x', 'E-1')).toEqual({
      statusCode: 201,
      response: { id: 'r1' },
    });
  });

  test('scoped by endpoint', () => {
    svc.store('k1', 'POST /a', 'E-1', 200, { a: 1 });
    expect(svc.lookup('k1', 'POST /b', 'E-1')).toBeNull();
  });

  test('scoped by actor', () => {
    svc.store('k1', 'POST /a', 'E-1', 200, { a: 1 });
    expect(svc.lookup('k1', 'POST /a', 'E-2')).toBeNull();
  });

  test('expired entries are pruned on lookup', () => {
    svc.store('k1', 'POST /a', 'E-1', 200, { a: 1 });
    clock.advance(25 * 60 * 60 * 1000);
    expect(svc.lookup('k1', 'POST /a', 'E-1')).toBeNull();
  });

  test('missing key returns null without touching DB', () => {
    expect(svc.lookup(undefined, 'POST /a', 'E-1')).toBeNull();
    expect(svc.lookup('', 'POST /a', 'E-1')).toBeNull();
  });

  test('store is a no-op when key is missing', () => {
    svc.store(undefined, 'POST /a', 'E-1', 200, { a: 1 });
    expect(svc.lookup(undefined, 'POST /a', 'E-1')).toBeNull();
  });
});
