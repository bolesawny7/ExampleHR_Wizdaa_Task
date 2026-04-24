import request from 'supertest';
import { buildTestApp } from '../helpers/app.js';
import { HcmOutboxWorker } from '../../src/hcm/hcm-outbox.worker.js';
import { sign } from '../../src/hcm/signature.util.js';

/**
 * End-to-end "happy path" through the full HTTP stack.  This test exists
 * as a *smoke* harness: if any wiring breaks in a way that unit / narrow
 * integration tests miss, this one will fail.
 */
describe('Happy-path HTTP smoke', () => {
  let harness, server, worker;

  beforeEach(async () => {
    harness = await buildTestApp();
    server = harness.app.getHttpServer();
    worker = harness.app.get(HcmOutboxWorker);
    harness.seedBalance({
      employeeId: 'E-1',
      locationId: 'LOC-1',
      leaveType: 'ANNUAL',
      balance: 10,
    });
  });

  afterEach(async () => {
    await harness.close();
  });

  test('file → approve → drain outbox → CONSUMED + HCM debited; webhook updates balance', async () => {
    // 1) health
    const health = await request(server).get('/health');
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ status: 'ok', db: 'ok' });

    // 2) unauthenticated read is 401 with our shape
    const unauthed = await request(server).get('/me/balances');
    expect(unauthed.status).toBe(401);
    expect(unauthed.body.error).toBe('UNAUTHORIZED');

    // 3) authenticated read
    const eTok = harness.tokens.employee('E-1', { managerId: 'M-1' });
    const mTok = harness.tokens.manager('M-1');
    const bal = await request(server).get('/me/balances').set('Authorization', `Bearer ${eTok}`);
    expect(bal.status).toBe(200);
    expect(bal.body[0].effectiveBalance).toBe(10);

    // 4) file request
    const filed = await request(server)
      .post('/me/requests')
      .set('Authorization', `Bearer ${eTok}`)
      .send({
        locationId: 'LOC-1',
        leaveType: 'ANNUAL',
        startDate: '2026-05-04',
        endDate: '2026-05-06',
      });
    expect(filed.status).toBe(201);
    expect(filed.body.state).toBe('PENDING');
    expect(filed.body.effectiveBalanceAfter).toBe(7);

    // 5) manager approves
    const approved = await request(server)
      .post(`/manager/requests/${filed.body.id}/approve`)
      .set('Authorization', `Bearer ${mTok}`);
    expect(approved.status).toBe(201);
    expect(approved.body.state).toBe('APPROVED');

    // 6) drain outbox → mock HCM is debited
    await worker.tick();
    expect(harness.hcmState.getBalance('E-1', 'LOC-1', 'ANNUAL').balance).toBe(7);
    const consumed = await request(server)
      .get(`/me/requests/${filed.body.id}`)
      .set('Authorization', `Bearer ${eTok}`);
    expect(consumed.body.state).toBe('CONSUMED');

    // 7) HCM pushes an anniversary bonus via signed webhook
    const body = JSON.stringify({
      batchId: 'B-anniv',
      asOf: new Date().toISOString(),
      balances: [{ employeeId: 'E-1', locationId: 'LOC-1', leaveType: 'ANNUAL', balance: 20 }],
    });
    const ts = Date.now();
    const webhook = await request(server)
      .post('/hcm/webhooks/batch')
      .set('Content-Type', 'application/json')
      .set('X-Hcm-Timestamp', String(ts))
      .set('X-Hcm-Signature', sign('test-webhook-secret', ts, body))
      .send(body);
    expect(webhook.status).toBe(200);
    expect(webhook.body.appliedCount).toBe(1);

    const newBal = await request(server).get('/me/balances').set('Authorization', `Bearer ${eTok}`);
    expect(newBal.body[0].effectiveBalance).toBe(20);
  });
});
