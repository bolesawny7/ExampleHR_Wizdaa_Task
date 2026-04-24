import { buildTestApp } from '../helpers/app.js';
import { BalancesService } from '../../src/balances/balances.service.js';
import { HcmOutboxWorker } from '../../src/hcm/hcm-outbox.worker.js';
import { TimeOffService } from '../../src/time-off/time-off.service.js';

/**
 * End-to-end of the service (minus HTTP) through the Nest DI container.
 */
describe('Request lifecycle', () => {
  let harness, timeOff, balances, worker;

  beforeEach(async () => {
    harness = await buildTestApp();
    timeOff = harness.app.get(TimeOffService);
    balances = harness.app.get(BalancesService);
    worker = harness.app.get(HcmOutboxWorker);
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

  test('full happy path: create -> approve -> drain outbox -> CONSUMED', async () => {
    const r = timeOff.createRequest({
      actor: { sub: 'E-1', roles: ['employee'], managerId: 'M-1' },
      input: {
        locationId: 'L-1',
        leaveType: 'ANNUAL',
        startDate: '2026-05-04',
        endDate: '2026-05-06',
      },
    });
    timeOff.approve({
      actor: { sub: 'M-1', roles: ['manager'] },
      requestId: r.id,
    });

    const { processed } = await worker.tick();
    expect(processed).toBe(1);

    expect(timeOff.getById(r.id).state).toBe('CONSUMED');
    expect(harness.hcmState.getBalance('E-1', 'L-1', 'ANNUAL').balance).toBe(7);
  });

  test('HCM transient error retries and eventually succeeds', async () => {
    // Fail the next two consume attempts, then succeed.
    harness.hcmState.scheduleFailures([
      { op: 'consume', status: 500, body: { error: 'BOOM' } },
      { op: 'consume', status: 500, body: { error: 'BOOM' } },
    ]);

    const r = timeOff.createRequest({
      actor: { sub: 'E-1', roles: ['employee'], managerId: 'M-1' },
      input: {
        locationId: 'L-1',
        leaveType: 'ANNUAL',
        startDate: '2026-05-04',
        endDate: '2026-05-05',
      },
    });
    timeOff.approve({
      actor: { sub: 'M-1', roles: ['manager'] },
      requestId: r.id,
    });

    // First tick: HCM returns 500 for consume → scheduled retry
    await worker.tick();
    expect(timeOff.getById(r.id).state).toBe('APPROVED');

    // Advance clock well past the backoff window so retry is due.
    harness.clock.advance(120_000);
    await worker.tick();
    expect(timeOff.getById(r.id).state).toBe('APPROVED');

    harness.clock.advance(120_000);
    await worker.tick();
    expect(timeOff.getById(r.id).state).toBe('CONSUMED');
  });

  test('HCM permanent error transitions request to HCM_FAILED and releases reservation', async () => {
    harness.hcmState.scheduleFailures([
      { op: 'consume', status: 422, body: { error: 'INSUFFICIENT_BALANCE' } },
    ]);
    const r = timeOff.createRequest({
      actor: { sub: 'E-1', roles: ['employee'], managerId: 'M-1' },
      input: {
        locationId: 'L-1',
        leaveType: 'ANNUAL',
        startDate: '2026-05-04',
        endDate: '2026-05-05',
      },
    });
    timeOff.approve({
      actor: { sub: 'M-1', roles: ['manager'] },
      requestId: r.id,
    });
    await worker.tick();
    expect(timeOff.getById(r.id).state).toBe('HCM_FAILED');
    expect(balances.getEffectiveBalance('E-1', 'L-1', 'ANNUAL').effectiveBalance).toBe(10);
  });

  test('defensive pre-consume check flags REVIEW_REQUIRED if HCM balance dropped', async () => {
    const r = timeOff.createRequest({
      actor: { sub: 'E-1', roles: ['employee'], managerId: 'M-1' },
      input: {
        locationId: 'L-1',
        leaveType: 'ANNUAL',
        startDate: '2026-05-04',
        endDate: '2026-05-10',
      }, // 7 days
    });
    timeOff.approve({
      actor: { sub: 'M-1', roles: ['manager'] },
      requestId: r.id,
    });

    // HCM changed under us (someone manually reduced balance).
    harness.hcmState.setBalance('E-1', 'L-1', 'ANNUAL', 3);

    await worker.tick();
    expect(timeOff.getById(r.id).state).toBe('REVIEW_REQUIRED');
    // HCM was not called with consume because we bailed.
    expect(
      harness.hcmState.calls().filter((c) => c.path === '/api/v1/time-off' && c.method === 'POST'),
    ).toHaveLength(0);
  });

  test('outbox exhausts attempts and marks DEAD', async () => {
    harness.hcmState.scheduleFailures([
      { op: 'consume', status: 500 },
      { op: 'consume', status: 500 },
      { op: 'consume', status: 500 },
      { op: 'consume', status: 500 },
    ]);
    const r = timeOff.createRequest({
      actor: { sub: 'E-1', roles: ['employee'], managerId: 'M-1' },
      input: {
        locationId: 'L-1',
        leaveType: 'ANNUAL',
        startDate: '2026-05-04',
        endDate: '2026-05-05',
      },
    });
    timeOff.approve({
      actor: { sub: 'M-1', roles: ['manager'] },
      requestId: r.id,
    });

    for (let i = 0; i < 5; i++) {
      await worker.tick();
      harness.clock.advance(5 * 60_000);
    }
    const deadRow = harness.db.db
      .prepare('SELECT status FROM hcm_outbox WHERE request_id = ?')
      .get(r.id);
    expect(deadRow.status).toBe('DEAD');
  });
});
