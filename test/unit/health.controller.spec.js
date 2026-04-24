import { HealthController } from '../../src/common/health.controller.js';

describe('HealthController', () => {
  test('returns ok when SELECT 1 succeeds', () => {
    const fake = { db: { prepare: () => ({ get: () => ({ ok: 1 }) }) } };
    const res = new HealthController(fake).check();
    expect(res).toEqual({ status: 'ok', db: 'ok' });
  });

  test('returns degraded when SELECT 1 does not return 1', () => {
    const fake = { db: { prepare: () => ({ get: () => ({ ok: 0 }) }) } };
    expect(new HealthController(fake).check().status).toBe('degraded');
  });

  test('returns degraded when the DB throws', () => {
    const fake = {
      get db() { throw new Error('closed'); },
    };
    const res = new HealthController(fake).check();
    expect(res.status).toBe('degraded');
    expect(res.db).toBe('down');
    expect(res.error).toBe('closed');
  });
});
