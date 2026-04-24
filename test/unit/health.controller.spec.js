import { HealthController } from '../../src/common/health.controller.js';

describe('HealthController', () => {
  test('returns ok when the DB responds', () => {
    const fake = { db: { prepare: () => ({ get: () => ({}) }) } };
    expect(new HealthController(fake).check()).toEqual({ status: 'ok', db: 'ok' });
  });

  test('returns degraded when the DB throws', () => {
    const fake = {
      get db() {
        throw new Error('closed');
      },
    };
    const res = new HealthController(fake).check();
    expect(res).toEqual({ status: 'degraded', db: 'down', error: 'closed' });
  });
});
