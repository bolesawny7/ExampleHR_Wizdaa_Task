import request from 'supertest';
import { buildTestApp } from '../helpers/app.js';
import { HcmClient } from '../../src/hcm/hcm.client.js';
import { HcmOutboxWorker } from '../../src/hcm/hcm-outbox.worker.js';
import { startHcmMockServer } from '../mocks/hcm-mock-server.js';

/**
 * End-to-end over a *real HTTP* connection to a deployed mock HCM server,
 * as suggested by the PDF:
 *
 *   "Create mock endpoints (you may want to deploy real mock servers for
 *    them with some basic logic to simulate balance changes) for the HCM
 *    as part of your test suite."
 *
 * Every other test suite injects the mock via `HcmClient._fetch` for
 * determinism and speed.  This one boots the same mock as a standalone
 * HTTP server on a random port, repoints `HCM_BASE_URL` at it, and lets
 * `HcmClient` make actual network calls.  It proves the production wiring
 * (global `fetch`, URL construction, JSON parsing, error mapping) works
 * end-to-end.
 */
describe('Real HTTP mock HCM (e2e)', () => {
  let mock, harness, server, worker;

  beforeAll(async () => {
    mock = await startHcmMockServer({ port: 0 });
  });

  afterAll(async () => {
    await mock.close();
  });

  beforeEach(async () => {
    // Reset the mock's state between tests.
    mock.state._balances.clear();
    mock.state._idempotency.clear();
    mock.state._calls.length = 0;
    mock.state._failurePlan.length = 0;
    mock.state.setBalance('E-1', 'LOC-1', 'ANNUAL', 10);

    harness = await buildTestApp({ HCM_BASE_URL: mock.url });
    // Use the *real* global fetch — this is the whole point of this suite.
    harness.app.get(HcmClient)._fetch = globalThis.fetch;
    worker = harness.app.get(HcmOutboxWorker);
    server = harness.app.getHttpServer();

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

  test('file → approve → outbox drains over real HTTP → HCM debited', async () => {
    const eTok = harness.tokens.employee('E-1', { managerId: 'M-1' });
    const mTok = harness.tokens.manager('M-1');

    const filed = await request(server)
      .post('/me/requests')
      .set('Authorization', `Bearer ${eTok}`)
      .send({
        locationId: 'LOC-1',
        leaveType: 'ANNUAL',
        startDate: '2026-05-04',
        endDate: '2026-05-05',
      });
    expect(filed.status).toBe(201);

    await request(server)
      .post(`/manager/requests/${filed.body.id}/approve`)
      .set('Authorization', `Bearer ${mTok}`)
      .expect(201);

    const tick = await worker.tick();
    expect(tick.processed).toBe(1);

    // The mock HCM received the real HTTP request and applied the deduction.
    expect(mock.state.getBalance('E-1', 'LOC-1', 'ANNUAL').balance).toBe(8);
    expect(
      mock.state.calls().some((c) => c.method === 'POST' && c.path === '/api/v1/time-off'),
    ).toBe(true);
  });

  test('HCM 5xx over real HTTP → outbox reschedules, eventually converges', async () => {
    // Script the mock to fail the first consume attempt only.
    mock.state.scheduleFailures([{ op: 'consume', status: 500, body: { error: 'BOOM' } }]);

    const eTok = harness.tokens.employee('E-1', { managerId: 'M-1' });
    const filed = await request(server)
      .post('/me/requests')
      .set('Authorization', `Bearer ${eTok}`)
      .send({
        locationId: 'LOC-1',
        leaveType: 'ANNUAL',
        startDate: '2026-05-04',
        endDate: '2026-05-04',
      });
    await request(server)
      .post(`/manager/requests/${filed.body.id}/approve`)
      .set('Authorization', `Bearer ${harness.tokens.manager('M-1')}`)
      .expect(201);

    // Tick 1: HCM returns 500 → row goes back to PENDING with a future attempt.
    await worker.tick();
    // Advance the clock past the backoff window so the next tick picks it up.
    harness.clock.advance(2 * 60_000);
    await worker.tick();

    expect(mock.state.getBalance('E-1', 'LOC-1', 'ANNUAL').balance).toBe(9);
  });
});
