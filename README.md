# Time-Off Microservice

A backend microservice that manages the full lifecycle of employee time-off
requests while keeping balances in sync with a downstream HCM (Workday, SAP,
…) which remains the system of record.

Built with **NestJS + JavaScript (ES2022, Babel) + SQLite (better-sqlite3)**.

> **Start here:** the architecture, design decisions, challenges and test
> strategy are described in depth in [`TRD.md`](./TRD.md).  This README is the
> operator's guide.

## Features

- REST API for employees, managers, and admins/ops.
- Balance integrity invariants enforced under concurrency
  (`BEGIN IMMEDIATE` transactions on SQLite).
- Transactional **outbox** to HCM with exponential-backoff retries.
- Drift detection and healing via three channels: HCM push (batch webhook),
  our pull (cron), and just-in-time check before consume.
- Signed HCM webhook (HMAC-SHA256, replay-protected by timestamp).
- JWT bearer authentication + role-based authorization.
- Request idempotency keyed by `(Idempotency-Key, endpoint, actor)`.
- Append-only audit log of every state transition and every HCM call.
- In-process **mock HCM** for tests and a runnable mock HCM server for
  manual exploration.
- 116 tests covering unit, integration, and end-to-end layers with ≥ 85 %
  line coverage.

## Repo layout

```
.
├── TRD.md                      <- Technical Requirements Document
├── README.md                   <- this file
├── package.json
├── babel.config.json
├── .env.example
├── src/
│   ├── main.js                 <- bootstrap
│   ├── app.module.js
│   ├── auth/                   <- JWT + guard
│   ├── balances/               <- balance queries, HCM snapshot applier
│   ├── common/                 <- audit, clock, idempotency, errors, health
│   ├── config/                 <- env-driven config
│   ├── database/               <- schema + better-sqlite3 wrapper
│   ├── hcm/                    <- client, webhook, outbox, reconciliation
│   └── time-off/               <- state machine, service, controller
└── test/
    ├── helpers/app.js          <- builds a full test app with mock HCM
    ├── mocks/hcm-mock-server.js<- programmable HCM fake (in-proc + HTTP)
    ├── unit/                   <- fast, pure logic tests
    ├── integration/            <- DB + service layer, concurrency races
    └── e2e/                    <- full HTTP stack via supertest
```

## Requirements

- Node.js **18 or newer** (tested on v18 and v25).
- npm 9+ (other package managers should work but only npm is tested).
- No external services — SQLite is embedded, and the HCM is mocked.

## Setup

```bash
# clone & enter the repo, then:
npm install
cp .env.example .env        # only needed if you want to run the server
```

> If your npm is pointed at a private registry that can't resolve public
> packages, the included `.npmrc` overrides it to the public `registry.npmjs.org`.

## Running the service

### Dev mode (auto-reload, in-memory mock HCM **not** included)

```bash
# 1) Start a mock HCM in one terminal:
npm run mock:hcm     # listens on :4000 by default
# 2) Start the service in another terminal:
JWT_SECRET=$(openssl rand -hex 32) HCM_WEBHOOK_SECRET=$(openssl rand -hex 32) \
  npm run start:dev
# service listens on http://localhost:3000
```

### Production-style build

```bash
npm run build       # transpiles src/ → dist/
NODE_ENV=production npm run start:prod
```

All configuration is through environment variables; see `.env.example` for
the full list (port, JWT secret, HCM secrets, reconciliation cron, outbox
tuning, rate limit, etc.).

### Quick smoke

```bash
# 1) health check
curl http://localhost:3000/health

# 2) mint a test JWT (inside node)
node -e "
  const jwt=require('jsonwebtoken');
  console.log(jwt.sign(
    { sub:'E-1', roles:['employee','manager'], managerId:null, orgId:'org' },
    process.env.JWT_SECRET, { expiresIn:'1h' }));
"
# 3) use the token:
TOKEN=...
curl -H \"Authorization: Bearer $TOKEN\" http://localhost:3000/me/balances
```

You can also send an HCM batch:

```bash
node -e "
  const {sign}=require('./src/hcm/signature.util.js');
  const body=JSON.stringify({batchId:'B-1',asOf:new Date().toISOString(),balances:[
    {employeeId:'E-1',locationId:'LOC-MAD-01',leaveType:'ANNUAL',balance:15}
  ]});
  const ts=Date.now();
  const sig=sign(process.env.HCM_WEBHOOK_SECRET, ts, body);
  console.log('ts=',ts,'sig=',sig,'body=',body);
"
# then
curl -X POST -H 'content-type: application/json' \
     -H \"X-Hcm-Timestamp: $TS\" -H \"X-Hcm-Signature: $SIG\" \
     --data \"$BODY\" http://localhost:3000/hcm/webhooks/batch
```

## Running the tests

```bash
npm test              # all tests, serial, 116 cases
npm run test:unit     # fast pure-logic tests
npm run test:integration
npm run test:e2e
npm run test:cov      # with coverage (html+lcov in coverage/)
```

The test strategy is described in `TRD.md §9`.  Highlights:

- **Unit** — state machine transitions, date math, signature util, balance
  math, idempotency store, JWT, outbox backoff, HcmClient error mapping,
  repositories.
- **Integration** — full request lifecycle (create → approve → outbox →
  HCM consume); HCM transient retries; HCM permanent failure;
  reconciliation of anniversary bonuses; negative-drift escalation to
  `REVIEW_REQUIRED`; sequential race invariant (balance never negative);
  outbox max-attempts → DEAD.
- **E2E** — HTTP layer end-to-end via `supertest`, including JWT auth,
  role guards, idempotency key replay, webhook signature verification
  (good/bad/stale), and admin endpoints.

Expected output:

```
Test Suites: 17 passed, 17 total
Tests:       116 passed, 116 total
Coverage:    Stmts 91 % | Branches 77 % | Funcs 93 % | Lines 93 %
```

Coverage thresholds enforced by Jest (see `package.json`).

## API surface (summary)

See `TRD.md §6` for the full contract; briefly:

| Actor | Method | Path | Purpose |
|-------|--------|------|---------|
| employee | `GET`  | `/me/balances` | Effective balances |
| employee | `POST` | `/me/requests` | File request (Idempotency-Key) |
| employee | `GET`  | `/me/requests`, `/me/requests/:id` | Read own |
| employee | `POST` | `/me/requests/:id/cancel` | Cancel own |
| manager | `GET`  | `/manager/requests` | Pending approvals |
| manager | `POST` | `/manager/requests/:id/approve` | Approve |
| manager | `POST` | `/manager/requests/:id/reject` | Reject (reason) |
| admin | `POST` | `/admin/reconcile` | Reconcile key or active keys |
| admin | `GET`  | `/admin/outbox` | Outbox inspection |
| admin | `POST` | `/admin/outbox/:id/retry` | Force retry |
| admin | `POST` | `/admin/outbox/drain` | Drain now |
| HCM | `POST` | `/hcm/webhooks/batch` | Signed batch ingress |
| HCM | `POST` | `/hcm/webhooks/balance` | Signed single update |
| — | `GET` | `/health` | Liveness + readiness |

## Security checklist

See `TRD.md §C6` for rationale.

- [x] JWT required on every user-facing endpoint (guard runs globally).
- [x] Role-based access checked *and* data-ownership checked (an employee
      cannot read / cancel another's request; a manager cannot approve
      outside their reports).
- [x] HCM webhook signature: HMAC-SHA256 over `timestamp.rawBody`, ±5-min
      replay window, constant-time compare.
- [x] DTO validation with `class-validator` + `whitelist` +
      `forbidNonWhitelisted` — no unknown fields reach domain services.
- [x] All SQL via `better-sqlite3` prepared statements; no interpolation.
- [x] `helmet()` for common HTTP hardening headers.
- [x] Secrets loaded from env and never logged; failure if JWT_SECRET unset
      outside tests.
- [x] Audit log of every mutation (append-only, `created_at`-indexed).
- [x] Idempotency keys scoped to `(key, endpoint, actor)` to prevent
      cross-actor or cross-endpoint replay.
- [x] PII minimization: only opaque IDs are stored/logged by this service.

## Trade-offs & future work

See `TRD.md §10`.  The biggest deliberate trade-off is using SQLite rather
than Postgres: this simplifies setup, makes the race-condition invariant
testing trivial (single writer), and is appropriate at the expected QPS for
one tenant.  Horizontal scale requires a migration — documented — to
Postgres + Redis (for idempotency + outbox coordination) and a real message
bus.

## License

UNLICENSED — interview exercise.
