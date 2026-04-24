import { Test } from '@nestjs/testing';
import express from 'express';
import { AppModule } from '../../src/app.module.js';
import { JwtService } from '../../src/auth/jwt.service.js';
import { Clock, TestClock } from '../../src/common/clock.js';
import { buildValidationPipe } from '../../src/common/validation.js';
import { ConfigService } from '../../src/config/config.service.js';
import { DatabaseService } from '../../src/database/database.service.js';
import { HcmClient } from '../../src/hcm/hcm.client.js';
import { MockHcmState } from '../mocks/hcm-mock-server.js';

/**
 * Builds a fresh test application with:
 *  - in-memory SQLite
 *  - deterministic TestClock
 *  - HcmClient backed by an in-process MockHcmState (no sockets)
 *  - background outbox worker disabled (tests call `worker.tick()` explicitly)
 *
 * Returns { app, hcmState, clock, tokens, ... helpers }.
 */
export async function buildTestApp(overrides = {}) {
  const clock = new TestClock();
  const hcmState = new MockHcmState();

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(ConfigService)
    .useValue(new ConfigService({
      // NODE_ENV=test already disables background jobs by default
      // (see ConfigService).
      NODE_ENV: 'test',
      JWT_SECRET: 'test-secret',
      DATABASE_PATH: ':memory:',
      HCM_BASE_URL: 'http://mock',
      HCM_WEBHOOK_SECRET: 'test-webhook-secret',
      HCM_API_KEY: 'test-api-key',
      OUTBOX_MAX_ATTEMPTS: '4',
      ...overrides,
    }))
    .overrideProvider(Clock)
    .useValue(clock)
    .compile();

  const app = moduleRef.createNestApplication({ bodyParser: false, logger: false });
  app.use(express.json({
    verify: (req, _res, buf) => { req.rawBody = buf; },
  }));
  app.useGlobalPipes(buildValidationPipe());
  await app.init();

  // Swap HcmClient's fetch for the in-process mock.
  const hcm = app.get(HcmClient);
  hcm._fetch = hcmState.fetchImpl();

  const jwt = app.get(JwtService);
  const tokens = {
    employee: (sub = 'E-1', extra = {}) =>
      jwt.sign({ sub, roles: ['employee'], orgId: 'org-1', ...extra }),
    manager: (sub = 'M-1', extra = {}) =>
      jwt.sign({ sub, roles: ['employee', 'manager'], orgId: 'org-1', ...extra }),
    admin: (sub = 'A-1') =>
      jwt.sign({ sub, roles: ['admin'], orgId: 'org-1' }),
  };

  const db = app.get(DatabaseService);

  return {
    app,
    moduleRef,
    clock,
    hcmState,
    tokens,
    db,
    /** Seed a balance row directly in the DB for tests. */
    seedBalance({ employeeId, locationId, leaveType, balance, asOf }) {
      db.db.prepare(`
        INSERT INTO balances
          (employee_id, location_id, leave_type, hcm_balance, hcm_snapshot_at,
           updated_at, version)
        VALUES (?, ?, ?, ?, ?, ?, 1)
      `).run(employeeId, locationId, leaveType, balance,
             asOf ?? clock.now(), clock.now());
      hcmState.setBalance(employeeId, locationId, leaveType, balance, asOf ?? clock.now());
    },
    async close() {
      await app.close();
    },
  };
}
