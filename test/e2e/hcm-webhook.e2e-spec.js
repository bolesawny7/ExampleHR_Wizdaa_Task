import request from 'supertest';
import { buildTestApp } from '../helpers/app.js';
import { sign } from '../../src/hcm/signature.util.js';
import { BalancesService } from '../../src/balances/balances.service.js';

describe('HCM webhook (e2e)', () => {
  let harness, server, secret;

  beforeEach(async () => {
    harness = await buildTestApp();
    server = harness.app.getHttpServer();
    secret = 'test-webhook-secret';
    harness.seedBalance({
      employeeId: 'E-1',
      locationId: 'L-1',
      leaveType: 'ANNUAL',
      balance: 10,
    });
  });

  afterEach(async () => {
    await harness.close();
  });

  function send(pathSuffix, body) {
    // Signature verification uses real wall-clock time (it has to, since
    // the HCM sender is a real external system).  The TestClock drives
    // in-process logic but not signature staleness.
    const ts = Date.now();
    const raw = JSON.stringify(body);
    const signature = sign(secret, ts, raw);
    return request(server)
      .post(`/hcm/webhooks/${pathSuffix}`)
      .set('Content-Type', 'application/json')
      .set('X-Hcm-Timestamp', String(ts))
      .set('X-Hcm-Signature', signature)
      .send(raw);
  }

  test('batch with valid signature updates balances', async () => {
    harness.clock.advance(1000);
    const res = await send('batch', {
      batchId: 'B-1',
      asOf: new Date(harness.clock.now()).toISOString(),
      balances: [{ employeeId: 'E-1', locationId: 'L-1', leaveType: 'ANNUAL', balance: 15 }],
    });
    expect(res.status).toBe(200);
    expect(res.body.appliedCount).toBe(1);
    const balances = harness.app.get(BalancesService);
    expect(balances.getEffectiveBalance('E-1', 'L-1', 'ANNUAL').effectiveBalance).toBe(15);
  });

  test('webhook with bad signature → 401', async () => {
    const ts = harness.clock.now();
    const body = { batchId: 'B-1', balances: [] };
    const res = await request(server)
      .post('/hcm/webhooks/batch')
      .set('Content-Type', 'application/json')
      .set('X-Hcm-Timestamp', String(ts))
      .set('X-Hcm-Signature', 'sha256=deadbeef')
      .send(body);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('INVALID_SIGNATURE');
  });

  test('webhook with stale timestamp → 401', async () => {
    const staleTs = Date.now() - 10 * 60_000;
    const body = { batchId: 'B-1', balances: [] };
    const raw = JSON.stringify(body);
    const sig = sign(secret, staleTs, raw);
    const res = await request(server)
      .post('/hcm/webhooks/batch')
      .set('Content-Type', 'application/json')
      .set('X-Hcm-Timestamp', String(staleTs))
      .set('X-Hcm-Signature', sig)
      .send(raw);
    expect(res.status).toBe(401);
  });

  test('single balance update endpoint', async () => {
    harness.clock.advance(1000);
    const res = await send('balance', {
      employeeId: 'E-1',
      locationId: 'L-1',
      leaveType: 'ANNUAL',
      balance: 8,
      asOf: new Date(harness.clock.now()).toISOString(),
    });
    expect(res.status).toBe(200);
    const balances = harness.app.get(BalancesService);
    expect(balances.getEffectiveBalance('E-1', 'L-1', 'ANNUAL').effectiveBalance).toBe(8);
  });

  test('rejects invalid entries with 400 VALIDATION_ERROR (after signature check)', async () => {
    const res = await send('batch', {
      batchId: 'B-bad',
      balances: [{ employeeId: 'E-1' }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  test('signature is checked BEFORE DTO validation (security: no info leak on bad sig)', async () => {
    // Structurally invalid body but also bad signature: we must see 401,
    // never 400, otherwise an attacker can probe the DTO shape without
    // knowing the secret.
    const res = await request(server)
      .post('/hcm/webhooks/batch')
      .set('Content-Type', 'application/json')
      .set('X-Hcm-Timestamp', String(Date.now()))
      .set('X-Hcm-Signature', 'sha256=deadbeef')
      .send({ totally: 'invalid', balances: [] });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('INVALID_SIGNATURE');
  });
});
