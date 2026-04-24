import request from 'supertest';
import { buildTestApp } from '../helpers/app.js';
import { HcmOutboxWorker } from '../../src/hcm/hcm-outbox.worker.js';

describe('Admin API (e2e)', () => {
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

  test('non-admin cannot call /admin/reconcile', async () => {
    const res = await request(server)
      .post('/admin/reconcile')
      .set('Authorization', `Bearer ${harness.tokens.employee('E-1')}`)
      .send({});
    expect(res.status).toBe(403);
  });

  test('admin reconcile with a single key calls HCM and applies snapshot', async () => {
    harness.hcmState.setBalance('E-1', 'L-1', 'ANNUAL', 12);
    const res = await request(server)
      .post('/admin/reconcile')
      .set('Authorization', `Bearer ${harness.tokens.admin('A-1')}`)
      .send({ key: { employeeId: 'E-1', locationId: 'L-1', leaveType: 'ANNUAL' } });
    expect(res.status).toBe(201);
    expect(res.body.balance.hcmBalance).toBe(12);
  });

  test('admin reconcile without key scans active keys', async () => {
    const res = await request(server)
      .post('/admin/reconcile')
      .set('Authorization', `Bearer ${harness.tokens.admin('A-1')}`)
      .send({});
    expect(res.status).toBe(201);
    expect(typeof res.body.scanned).toBe('number');
  });

  test('admin reconcile with malformed key returns 400', async () => {
    const res = await request(server)
      .post('/admin/reconcile')
      .set('Authorization', `Bearer ${harness.tokens.admin('A-1')}`)
      .send({ key: { employeeId: 'E-1' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  test('admin can list outbox', async () => {
    const res = await request(server)
      .get('/admin/outbox')
      .set('Authorization', `Bearer ${harness.tokens.admin('A-1')}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('admin can filter outbox by status', async () => {
    const res = await request(server)
      .get('/admin/outbox?status=PENDING&limit=10')
      .set('Authorization', `Bearer ${harness.tokens.admin('A-1')}`);
    expect(res.status).toBe(200);
  });

  test('admin can trigger outbox drain', async () => {
    const res = await request(server)
      .post('/admin/outbox/drain')
      .set('Authorization', `Bearer ${harness.tokens.admin('A-1')}`);
    expect(res.status).toBe(201);
  });

  test('admin retry with bad id returns 400', async () => {
    const res = await request(server)
      .post('/admin/outbox/notanid/retry')
      .set('Authorization', `Bearer ${harness.tokens.admin('A-1')}`);
    expect(res.status).toBe(400);
  });

  test('employee can list own requests and single request', async () => {
    const token = harness.tokens.employee('E-1', { managerId: 'M-1' });
    const r = await request(server)
      .post('/me/requests')
      .set('Authorization', `Bearer ${token}`)
      .send({
        locationId: 'L-1', leaveType: 'ANNUAL',
        startDate: '2026-05-04', endDate: '2026-05-05',
      });
    const list = await request(server)
      .get('/me/requests')
      .set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(list.body.length).toBe(1);

    const single = await request(server)
      .get(`/me/requests/${r.body.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(single.status).toBe(200);
    expect(single.body.id).toBe(r.body.id);
  });

  test('manager can list pending requests for them', async () => {
    const eTok = harness.tokens.employee('E-1', { managerId: 'M-1' });
    await request(server)
      .post('/me/requests')
      .set('Authorization', `Bearer ${eTok}`)
      .send({
        locationId: 'L-1', leaveType: 'ANNUAL',
        startDate: '2026-05-04', endDate: '2026-05-05',
      });
    const list = await request(server)
      .get('/manager/requests')
      .set('Authorization', `Bearer ${harness.tokens.manager('M-1')}`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
  });

  test('manager rejects with a reason', async () => {
    const eTok = harness.tokens.employee('E-1', { managerId: 'M-1' });
    const r = await request(server)
      .post('/me/requests')
      .set('Authorization', `Bearer ${eTok}`)
      .send({
        locationId: 'L-1', leaveType: 'ANNUAL',
        startDate: '2026-05-04', endDate: '2026-05-05',
      });
    const rej = await request(server)
      .post(`/manager/requests/${r.body.id}/reject`)
      .set('Authorization', `Bearer ${harness.tokens.manager('M-1')}`)
      .send({ reason: 'no coverage' });
    expect(rej.status).toBe(201);
    expect(rej.body.state).toBe('REJECTED');
  });
});
