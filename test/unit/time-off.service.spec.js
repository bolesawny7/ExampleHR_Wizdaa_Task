import { AuditService } from '../../src/common/audit.service.js';
import { TestClock } from '../../src/common/clock.js';
import { BalancesRepository } from '../../src/balances/balances.repository.js';
import { BalancesService } from '../../src/balances/balances.service.js';
import { ConfigService } from '../../src/config/config.service.js';
import { DatabaseService } from '../../src/database/database.service.js';
import { HcmOutboxService } from '../../src/hcm/hcm-outbox.service.js';
import { TimeOffRepository } from '../../src/time-off/time-off.repository.js';
import { TimeOffService } from '../../src/time-off/time-off.service.js';
import { STATES } from '../../src/time-off/state-machine.js';

function build() {
  const clock = new TestClock();
  const config = new ConfigService({
    NODE_ENV: 'test', JWT_SECRET: 'x', DATABASE_PATH: ':memory:',
  });
  const db = new DatabaseService(config);
  db.open();
  const audit = new AuditService(db.db, clock);
  const balancesRepo = new BalancesRepository(db);
  const balancesService = new BalancesService(db, balancesRepo, audit, clock);
  const outbox = new HcmOutboxService(db, clock, config);
  const repo = new TimeOffRepository(db);
  const svc = new TimeOffService(db, repo, balancesRepo, audit, clock, outbox);

  // seed a 10-day ANNUAL balance
  balancesService.applyHcmBalanceSnapshot({
    employeeId: 'E-1', locationId: 'L-1', leaveType: 'ANNUAL',
    balance: 10, asOf: clock.now(),
  });
  return { clock, db, svc, balancesService, outbox, repo, balancesRepo };
}

const employee = {
  sub: 'E-1', roles: ['employee'], managerId: 'M-1', orgId: 'org',
};
const manager = {
  sub: 'M-1', roles: ['manager'], managerId: null, orgId: 'org',
};
const other = {
  sub: 'E-2', roles: ['employee'], managerId: 'M-2', orgId: 'org',
};

describe('TimeOffService', () => {
  test('create -> approve -> mark consumed transitions and reservation lifecycle', () => {
    const { svc, balancesService, outbox, balancesRepo } = build();

    const r = svc.createRequest({
      actor: employee,
      input: {
        locationId: 'L-1', leaveType: 'ANNUAL',
        startDate: '2026-05-04', endDate: '2026-05-06',
      },
    });
    expect(r.state).toBe(STATES.PENDING);
    expect(r.days).toBe(3);
    expect(r.effectiveBalanceAfter).toBe(7);
    expect(balancesService.getEffectiveBalance('E-1', 'L-1', 'ANNUAL').effectiveBalance).toBe(7);

    const a = svc.approve({ actor: manager, requestId: r.id });
    expect(a.state).toBe(STATES.APPROVED);
    expect(a.externalRequestId).toMatch(/^ext_/);

    const due = outbox.claimDue();
    expect(due).toHaveLength(1);
    expect(due[0].op).toBe('CONSUME');

    const consumed = svc.markConsumed(r.id);
    expect(consumed.state).toBe(STATES.CONSUMED);
    const reservation = balancesRepo.findReservationForRequest(r.id);
    expect(reservation.state).toBe('CONSUMED');
    // Cached HCM balance is still 10; reservation no longer counts so
    // effective = 10 until HCM pushes the new balance.
    expect(balancesService.getEffectiveBalance('E-1', 'L-1', 'ANNUAL').effectiveBalance).toBe(10);
  });

  test('insufficient balance rejects request creation', () => {
    const { svc, balancesService } = build();
    expect(() => svc.createRequest({
      actor: employee,
      input: {
        locationId: 'L-1', leaveType: 'ANNUAL',
        startDate: '2026-05-01', endDate: '2026-05-20',
      },
    })).toThrow(/Insufficient balance/);
    expect(balancesService.getEffectiveBalance('E-1', 'L-1', 'ANNUAL').effectiveBalance).toBe(10);
  });

  test('reject releases reservation', () => {
    const { svc, balancesService, balancesRepo } = build();
    const r = svc.createRequest({
      actor: employee,
      input: {
        locationId: 'L-1', leaveType: 'ANNUAL',
        startDate: '2026-05-04', endDate: '2026-05-06',
      },
    });
    expect(balancesService.getEffectiveBalance('E-1', 'L-1', 'ANNUAL').effectiveBalance).toBe(7);
    svc.reject({ actor: manager, requestId: r.id, reason: 'coverage' });
    expect(balancesService.getEffectiveBalance('E-1', 'L-1', 'ANNUAL').effectiveBalance).toBe(10);
    expect(balancesRepo.findReservationForRequest(r.id).state).toBe('RELEASED');
  });

  test('cancel by owner releases reservation from PENDING', () => {
    const { svc, balancesService } = build();
    const r = svc.createRequest({
      actor: employee,
      input: {
        locationId: 'L-1', leaveType: 'ANNUAL',
        startDate: '2026-05-04', endDate: '2026-05-06',
      },
    });
    svc.cancel({ actor: employee, requestId: r.id });
    expect(balancesService.getEffectiveBalance('E-1', 'L-1', 'ANNUAL').effectiveBalance).toBe(10);
  });

  test('cancel by non-owner is forbidden', () => {
    const { svc } = build();
    const r = svc.createRequest({
      actor: employee,
      input: {
        locationId: 'L-1', leaveType: 'ANNUAL',
        startDate: '2026-05-04', endDate: '2026-05-06',
      },
    });
    expect(() => svc.cancel({ actor: other, requestId: r.id }))
      .toThrow(/Cannot cancel another employee/);
  });

  test('manager cannot approve requests of employee outside their team', () => {
    const { svc } = build();
    const r = svc.createRequest({
      actor: employee,
      input: {
        locationId: 'L-1', leaveType: 'ANNUAL',
        startDate: '2026-05-04', endDate: '2026-05-06',
      },
    });
    const otherManager = { sub: 'M-2', roles: ['manager'], orgId: 'org' };
    expect(() => svc.approve({ actor: otherManager, requestId: r.id }))
      .toThrow(/Not this employee/);
  });

  test('markHcmFailed releases reservation', () => {
    const { svc, balancesService, balancesRepo } = build();
    const r = svc.createRequest({
      actor: employee,
      input: {
        locationId: 'L-1', leaveType: 'ANNUAL',
        startDate: '2026-05-04', endDate: '2026-05-06',
      },
    });
    svc.approve({ actor: manager, requestId: r.id });
    expect(balancesService.getEffectiveBalance('E-1', 'L-1', 'ANNUAL').effectiveBalance).toBe(7);
    svc.markHcmFailed(r.id, 'HCM rejected');
    expect(balancesService.getEffectiveBalance('E-1', 'L-1', 'ANNUAL').effectiveBalance).toBe(10);
    expect(balancesRepo.findReservationForRequest(r.id).state).toBe('RELEASED');
  });

  test('markReviewRequired keeps reservation open (pending human decision)', () => {
    const { svc, balancesService, balancesRepo } = build();
    const r = svc.createRequest({
      actor: employee,
      input: {
        locationId: 'L-1', leaveType: 'ANNUAL',
        startDate: '2026-05-04', endDate: '2026-05-06',
      },
    });
    svc.approve({ actor: manager, requestId: r.id });
    svc.markReviewRequired(r.id, 'drift');
    expect(balancesService.getEffectiveBalance('E-1', 'L-1', 'ANNUAL').effectiveBalance).toBe(7);
    expect(balancesRepo.findReservationForRequest(r.id).state).toBe('OPEN');
  });

  test('double-approve is idempotent at second call (invalid transition)', () => {
    const { svc } = build();
    const r = svc.createRequest({
      actor: employee,
      input: {
        locationId: 'L-1', leaveType: 'ANNUAL',
        startDate: '2026-05-04', endDate: '2026-05-06',
      },
    });
    svc.approve({ actor: manager, requestId: r.id });
    expect(() => svc.approve({ actor: manager, requestId: r.id }))
      .toThrow(/Cannot transition from APPROVED/);
  });

  test('two requests totalling > balance cannot both succeed (sequential)', () => {
    const { svc } = build();
    svc.createRequest({
      actor: employee,
      input: {
        locationId: 'L-1', leaveType: 'ANNUAL',
        startDate: '2026-05-04', endDate: '2026-05-10',
      },
    }); // 7 days
    expect(() => svc.createRequest({
      actor: employee,
      input: {
        locationId: 'L-1', leaveType: 'ANNUAL',
        startDate: '2026-05-11', endDate: '2026-05-15',
      },
    })).toThrow(/Insufficient balance/); // would be 5 more but only 3 left
  });
});
