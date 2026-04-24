import request from 'supertest';
import { buildTestApp } from '../helpers/app.js';
import { HcmOutboxWorker } from '../../src/hcm/hcm-outbox.worker.js';

describe('Time-Off HTTP API (e2e)', () => {
  let harness, server, worker;

  beforeEach(async () => {
    harness = await buildTestApp();
    server = harness.app.getHttpServer();
    worker = harness.app.get(HcmOutboxWorker);
    harness.seedBalance({
      employeeId: 'E-1', locationId: 'L-1', leaveType: 'ANNUAL', balance: 10,
    });
  });

  afterEach(async () => { await harness.close(); });

  test('GET /health is public and returns ok', async () => {
    const res = await request(server).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('GET /me/balances without a token is 401', async () => {
    const res = await request(server).get('/me/balances');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
  });

  test('GET /me/balances returns effective balances', async () => {
    const res = await request(server)
      .get('/me/balances')
      .set('Authorization', `Bearer ${harness.tokens.employee('E-1')}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].effectiveBalance).toBe(10);
  });

  test('POST /me/requests creates and deducts effective balance', async () => {
    const res = await request(server)
      .post('/me/requests')
      .set('Authorization', `Bearer ${harness.tokens.employee('E-1', { managerId: 'M-1' })}`)
      .send({
        locationId: 'L-1', leaveType: 'ANNUAL',
        startDate: '2026-05-04', endDate: '2026-05-06',
      });
    expect(res.status).toBe(201);
    expect(res.body.state).toBe('PENDING');
    expect(res.body.effectiveBalanceAfter).toBe(7);
  });

  test('POST /me/requests returns 409 when balance insufficient', async () => {
    const res = await request(server)
      .post('/me/requests')
      .set('Authorization', `Bearer ${harness.tokens.employee('E-1')}`)
      .send({
        locationId: 'L-1', leaveType: 'ANNUAL',
        startDate: '2026-05-01', endDate: '2026-05-20',
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('INSUFFICIENT_BALANCE');
  });

  test('Idempotency-Key returns same response on retry', async () => {
    const token = harness.tokens.employee('E-1', { managerId: 'M-1' });
    const payload = {
      locationId: 'L-1', leaveType: 'ANNUAL',
      startDate: '2026-05-04', endDate: '2026-05-06',
    };
    const r1 = await request(server)
      .post('/me/requests')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'abc-123')
      .send(payload);
    const r2 = await request(server)
      .post('/me/requests')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'abc-123')
      .send(payload);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r2.body.id).toBe(r1.body.id);
    // and only ONE reservation exists for E-1
    const rows = harness.db.db.prepare(
      "SELECT COUNT(*) AS c FROM reservations WHERE employee_id = 'E-1'",
    ).get();
    expect(rows.c).toBe(1);
  });

  test('employees cannot read other employees requests', async () => {
    const r = await request(server)
      .post('/me/requests')
      .set('Authorization', `Bearer ${harness.tokens.employee('E-1', { managerId: 'M-1' })}`)
      .send({
        locationId: 'L-1', leaveType: 'ANNUAL',
        startDate: '2026-05-04', endDate: '2026-05-06',
      });
    const reqId = r.body.id;

    harness.seedBalance({
      employeeId: 'E-2', locationId: 'L-1', leaveType: 'ANNUAL', balance: 1,
    });
    const res = await request(server)
      .get(`/me/requests/${reqId}`)
      .set('Authorization', `Bearer ${harness.tokens.employee('E-2')}`);
    expect(res.status).toBe(404);
  });

  test('manager approves and outbox pushes to HCM', async () => {
    const r = await request(server)
      .post('/me/requests')
      .set('Authorization', `Bearer ${harness.tokens.employee('E-1', { managerId: 'M-1' })}`)
      .send({
        locationId: 'L-1', leaveType: 'ANNUAL',
        startDate: '2026-05-04', endDate: '2026-05-06',
      });
    const reqId = r.body.id;

    const approve = await request(server)
      .post(`/manager/requests/${reqId}/approve`)
      .set('Authorization', `Bearer ${harness.tokens.manager('M-1')}`);
    expect(approve.status).toBe(201);
    expect(approve.body.state).toBe('APPROVED');

    await worker.tick();
    const consumeCalls = harness.hcmState.calls().filter(
      (c) => c.method === 'POST' && c.path === '/api/v1/time-off',
    );
    expect(consumeCalls).toHaveLength(1);
    expect(harness.hcmState.getBalance('E-1', 'L-1', 'ANNUAL').balance).toBe(7);
  });

  test('manager cannot approve requests outside their reports', async () => {
    const r = await request(server)
      .post('/me/requests')
      .set('Authorization', `Bearer ${harness.tokens.employee('E-1', { managerId: 'M-1' })}`)
      .send({
        locationId: 'L-1', leaveType: 'ANNUAL',
        startDate: '2026-05-04', endDate: '2026-05-06',
      });
    const reqId = r.body.id;
    const res = await request(server)
      .post(`/manager/requests/${reqId}/approve`)
      .set('Authorization', `Bearer ${harness.tokens.manager('M-9')}`);
    expect(res.status).toBe(403);
  });

  test('employee cancels own PENDING request', async () => {
    const r = await request(server)
      .post('/me/requests')
      .set('Authorization', `Bearer ${harness.tokens.employee('E-1', { managerId: 'M-1' })}`)
      .send({
        locationId: 'L-1', leaveType: 'ANNUAL',
        startDate: '2026-05-04', endDate: '2026-05-06',
      });
    const cancelled = await request(server)
      .post(`/me/requests/${r.body.id}/cancel`)
      .set('Authorization', `Bearer ${harness.tokens.employee('E-1')}`);
    expect(cancelled.status).toBe(201);
    expect(cancelled.body.state).toBe('CANCELLED');
  });

  test('validation: missing fields → 400 with our unified VALIDATION_ERROR shape', async () => {
    const res = await request(server)
      .post('/me/requests')
      .set('Authorization', `Bearer ${harness.tokens.employee('E-1')}`)
      .send({ locationId: 'L-1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
    expect(Array.isArray(res.body.details)).toBe(true);
    // Every failing DTO field is reported with its property name.
    const fields = res.body.details.map((d) => d.field).sort();
    expect(fields).toEqual(expect.arrayContaining(['endDate', 'leaveType', 'startDate']));
  });

  test('validation: unknown body fields are rejected (whitelist + forbidNonWhitelisted)', async () => {
    const res = await request(server)
      .post('/me/requests')
      .set('Authorization', `Bearer ${harness.tokens.employee('E-1', { managerId: 'M-1' })}`)
      .send({
        locationId: 'L-1', leaveType: 'ANNUAL',
        startDate: '2026-05-04', endDate: '2026-05-06',
        hackyExtra: 'please drop me',
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });
});
