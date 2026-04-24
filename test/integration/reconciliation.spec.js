import { buildTestApp } from '../helpers/app.js';
import { BalancesService } from '../../src/balances/balances.service.js';
import { ReconciliationService } from '../../src/hcm/reconciliation.service.js';
import { TimeOffService } from '../../src/time-off/time-off.service.js';

describe('ReconciliationService', () => {
  let harness, recon, balances, timeOff;

  beforeEach(async () => {
    harness = await buildTestApp();
    recon = harness.app.get(ReconciliationService);
    balances = harness.app.get(BalancesService);
    timeOff = harness.app.get(TimeOffService);
  });

  afterEach(async () => {
    await harness.close();
  });

  test('HCM anniversary bonus arrives via batch and increases cached balance', () => {
    harness.seedBalance({
      employeeId: 'E-1',
      locationId: 'L-1',
      leaveType: 'ANNUAL',
      balance: 10,
    });
    harness.clock.advance(86_400_000);
    const result = recon.handleBatch({
      batchId: 'B-1',
      asOf: harness.clock.now(),
      balances: [{ employeeId: 'E-1', locationId: 'L-1', leaveType: 'ANNUAL', balance: 15 }],
    });
    expect(result.appliedCount).toBe(1);
    expect(balances.getEffectiveBalance('E-1', 'L-1', 'ANNUAL').effectiveBalance).toBe(15);
  });

  test('HCM batch below open reservations triggers REVIEW_REQUIRED for affected APPROVED requests', () => {
    harness.seedBalance({
      employeeId: 'E-1',
      locationId: 'L-1',
      leaveType: 'ANNUAL',
      balance: 10,
    });
    const r = timeOff.createRequest({
      actor: { sub: 'E-1', roles: ['employee'], managerId: 'M-1' },
      input: {
        locationId: 'L-1',
        leaveType: 'ANNUAL',
        startDate: '2026-05-01',
        endDate: '2026-05-07',
      },
    });
    timeOff.approve({
      actor: { sub: 'M-1', roles: ['manager'] },
      requestId: r.id,
    });

    harness.clock.advance(1000);
    const result = recon.handleBatch({
      batchId: 'B-2',
      asOf: harness.clock.now(),
      balances: [
        {
          employeeId: 'E-1',
          locationId: 'L-1',
          leaveType: 'ANNUAL',
          balance: 3,
        },
      ],
    });
    expect(result.applied[0].negativeDrift).toBe(true);
    expect(timeOff.getById(r.id).state).toBe('REVIEW_REQUIRED');
  });

  test('batch does not touch keys not mentioned', () => {
    harness.seedBalance({
      employeeId: 'E-1',
      locationId: 'L-1',
      leaveType: 'ANNUAL',
      balance: 10,
    });
    harness.seedBalance({
      employeeId: 'E-2',
      locationId: 'L-1',
      leaveType: 'ANNUAL',
      balance: 5,
    });
    harness.clock.advance(1000);
    recon.handleBatch({
      batchId: 'B-3',
      asOf: harness.clock.now(),
      balances: [
        {
          employeeId: 'E-1',
          locationId: 'L-1',
          leaveType: 'ANNUAL',
          balance: 20,
        },
      ],
    });
    expect(balances.getEffectiveBalance('E-2', 'L-1', 'ANNUAL').effectiveBalance).toBe(5);
    expect(balances.getEffectiveBalance('E-1', 'L-1', 'ANNUAL').effectiveBalance).toBe(20);
  });

  test('reconcileKey pulls from HCM and applies snapshot', async () => {
    harness.seedBalance({
      employeeId: 'E-1',
      locationId: 'L-1',
      leaveType: 'ANNUAL',
      balance: 10,
    });
    harness.hcmState.setBalance('E-1', 'L-1', 'ANNUAL', 14);
    harness.clock.advance(1000);
    const r = await recon.reconcileKey({
      employeeId: 'E-1',
      locationId: 'L-1',
      leaveType: 'ANNUAL',
    });
    expect(r.balance.hcmBalance).toBe(14);
    expect(balances.getEffectiveBalance('E-1', 'L-1', 'ANNUAL').effectiveBalance).toBe(14);
  });

  test('reconcileActive scans recently-updated keys only', async () => {
    harness.seedBalance({
      employeeId: 'E-1',
      locationId: 'L-1',
      leaveType: 'ANNUAL',
      balance: 10,
    });
    harness.hcmState.setBalance('E-1', 'L-1', 'ANNUAL', 11);
    const result = await recon.reconcileActive({ sinceMs: 60_000 });
    expect(result.scanned).toBeGreaterThan(0);
    expect(balances.getEffectiveBalance('E-1', 'L-1', 'ANNUAL').effectiveBalance).toBe(11);
  });

  test('reconcileKey gracefully skips when HCM fails', async () => {
    harness.seedBalance({
      employeeId: 'E-1',
      locationId: 'L-1',
      leaveType: 'ANNUAL',
      balance: 10,
    });
    harness.hcmState.scheduleFailures([{ op: 'getBalance', status: 503, body: { error: 'DOWN' } }]);
    const r = await recon.reconcileKey({
      employeeId: 'E-1',
      locationId: 'L-1',
      leaveType: 'ANNUAL',
    });
    expect(r.skipped).toBe(true);
    // cached balance unchanged
    expect(balances.getEffectiveBalance('E-1', 'L-1', 'ANNUAL').effectiveBalance).toBe(10);
  });
});
