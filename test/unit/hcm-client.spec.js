import { HcmClient } from '../../src/hcm/hcm.client.js';
import { HcmPermanentError, HcmTransientError } from '../../src/common/errors.js';
import { ConfigService } from '../../src/config/config.service.js';

describe('HcmClient', () => {
  const config = new ConfigService({
    JWT_SECRET: 'x', HCM_BASE_URL: 'http://mock', HCM_API_KEY: 'k',
  });

  function clientWith(fetchImpl) {
    const c = new HcmClient(config);
    c._fetch = fetchImpl;
    return c;
  }

  const ok = (body = {}) => async () => ({
    status: 200, ok: true,
    async text() { return JSON.stringify(body); },
  });

  test('getBalance returns parsed JSON on 200', async () => {
    const c = clientWith(ok({ balance: 10 }));
    const r = await c.getBalance({ employeeId: 'E', locationId: 'L', leaveType: 'ANNUAL' });
    expect(r.balance).toBe(10);
  });

  test('5xx throws HcmTransientError', async () => {
    const c = clientWith(async () => ({
      status: 503, ok: false,
      async text() { return 'down'; },
    }));
    await expect(c.getBalance({ employeeId: 'E', locationId: 'L', leaveType: 'ANNUAL' }))
      .rejects.toBeInstanceOf(HcmTransientError);
  });

  test('422 throws HcmPermanentError', async () => {
    const c = clientWith(async () => ({
      status: 422, ok: false,
      async text() { return '{"error":"BAD"}'; },
    }));
    await expect(c.consumeBalance({
      employeeId: 'E', locationId: 'L', leaveType: 'ANNUAL',
      days: 1, startDate: '2026-01-01', endDate: '2026-01-01',
      externalRequestId: 'ext_1', correlationId: 'c',
    })).rejects.toBeInstanceOf(HcmPermanentError);
  });

  test('network failure throws HcmTransientError', async () => {
    const c = clientWith(async () => { throw new Error('ECONNREFUSED'); });
    await expect(c.getBalance({ employeeId: 'E', locationId: 'L', leaveType: 'ANNUAL' }))
      .rejects.toBeInstanceOf(HcmTransientError);
  });

  test('releaseBalance POSTs release payload', async () => {
    let captured;
    const c = clientWith(async (url, init) => {
      captured = { url, body: JSON.parse(init.body) };
      return { status: 200, ok: true, async text() { return '{}'; } };
    });
    await c.releaseBalance({ externalRequestId: 'ext_x', correlationId: 'c' });
    expect(captured.url).toMatch(/\/time-off\/release$/);
    expect(captured.body.externalRequestId).toBe('ext_x');
  });

  test('429 maps to transient', async () => {
    const c = clientWith(async () => ({
      status: 429, ok: false, async text() { return ''; },
    }));
    await expect(c.getBalance({ employeeId: 'E', locationId: 'L', leaveType: 'ANNUAL' }))
      .rejects.toBeInstanceOf(HcmTransientError);
  });
});
