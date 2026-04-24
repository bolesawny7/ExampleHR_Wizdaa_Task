# Time-Off Microservice

Backend microservice that manages the full lifecycle of employee time-off
requests while keeping balances in sync with a downstream HCM (Workday,
SAP, …) which remains the system of record.

Built with **NestJS + JavaScript (ES2022, Babel) + SQLite (better-sqlite3)**.

> Architecture, design decisions, challenges, and test strategy live in
> [`TRD.md`](./TRD.md). This README is the operator's guide: how to run
> and test the thing.

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
│   ├── auth/                   <- JWT guard + role / public decorators
│   ├── balances/               <- balance queries, HCM snapshot applier
│   ├── common/                 <- audit, clock, idempotency, errors, health,
│   │                              validation-pipe factory, exceptions filter
│   ├── config/                 <- env-driven config
│   ├── database/               <- schema + better-sqlite3 wrapper
│   ├── hcm/                    <- client, webhook + signature guard, outbox,
│   │                              reconciliation, admin controller
│   └── time-off/               <- state machine, service, controller, DTOs
└── test/
    ├── helpers/app.js          <- builds a full test app with mock HCM
    ├── mocks/hcm-mock-server.js<- programmable HCM fake (in-proc + HTTP)
    ├── unit/                   <- pure logic + narrow DB tests
    ├── integration/            <- DB + service layer, mock HCM
    └── e2e/                    <- full HTTP stack via supertest
```

## Requirements

- **Node.js 18+** (uses global `fetch`). Tested on v18 and v25.
- **npm**. The repo's `.npmrc` pins the public registry in case your
  global npm is pointed elsewhere.

No external services: SQLite is embedded, the HCM is mocked in tests and
by an optional standalone server for manual exploration.

## Setup

```bash
npm install
cp .env.example .env   # only needed if you intend to run the server
```

## Run

### Dev

Two terminals. In one, start the mock HCM on `:4000`:

```bash
npm run mock:hcm
```

In the other, start the service on `:3000` with fresh secrets:

```bash
export JWT_SECRET=$(openssl rand -hex 32)
export HCM_WEBHOOK_SECRET=$(openssl rand -hex 32)
npm run start:dev
```

### Build + prod

```bash
npm run build
NODE_ENV=production npm run start:prod
```

All configuration is via environment variables; see `.env.example` for
the canonical list.

### Smoke the running service

Health:

```bash
curl http://localhost:3000/health
```

Mint a test JWT and hit a protected route:

```bash
export TOKEN=$(node -e "console.log(require('jsonwebtoken').sign(
  { sub:'E-1', roles:['employee','manager'], orgId:'org' },
  process.env.JWT_SECRET, { expiresIn:'1h' }))")
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/me/balances
```

Send a signed HCM batch webhook:

```bash
node -e "
  const {sign} = require('./src/hcm/signature.util.js');
  const body = JSON.stringify({
    batchId:'B-1',
    asOf: new Date().toISOString(),
    balances: [{
      employeeId:'E-1', locationId:'LOC-MAD-01', leaveType:'ANNUAL', balance:15,
    }],
  });
  const ts = Date.now();
  console.log('TS=' + ts);
  console.log('SIG=' + sign(process.env.HCM_WEBHOOK_SECRET, ts, body));
  console.log('BODY=' + body);
" > /tmp/hcm.env
source /tmp/hcm.env
curl -X POST -H 'content-type: application/json' \
     -H "X-Hcm-Timestamp: $TS" -H "X-Hcm-Signature: $SIG" \
     --data "$BODY" http://localhost:3000/hcm/webhooks/batch
```

## Test

```bash
npm test               # all tests, serial
npm run test:unit
npm run test:integration
npm run test:e2e
npm run test:cov       # with coverage (text + html + lcov in coverage/)
```

Jest enforces **≥ 90 %** on statements / lines / functions and **≥ 80 %**
on branches. The test catalogue is documented in
[`TRD.md §9`](./TRD.md#9-testing-strategy) — do not duplicate that list
here, it drifts.

## Lint & format

```bash
npm run format          # apply Prettier
npm run format:check    # CI-safe prettier check
npm run lint            # ESLint
npm run lint:fix        # ESLint --fix
```

ESLint uses `@babel/eslint-parser` so decorators and class fields parse via
the project's existing `babel.config.json` — no duplicate parser config.
A `jsconfig.json` sets `experimentalDecorators` + `emitDecoratorMetadata`
so the editor (Cursor / VS Code) does not flag `@Decorator(...)` with
_"Decorators are not valid here"_.

## API surface

Full contract and payload shapes in [`TRD.md §6`](./TRD.md#6-api-rest).
At a glance:

| Actor    | Method | Path                               | Purpose                                  |
| -------- | ------ | ---------------------------------- | ---------------------------------------- |
| employee | `GET`  | `/me/balances`                     | Effective balances                       |
| employee | `POST` | `/me/requests`                     | File request (accepts `Idempotency-Key`) |
| employee | `GET`  | `/me/requests`, `/me/requests/:id` | Read own                                 |
| employee | `POST` | `/me/requests/:id/cancel`          | Cancel own                               |
| manager  | `GET`  | `/manager/requests`                | Pending approvals                        |
| manager  | `POST` | `/manager/requests/:id/approve`    | Approve                                  |
| manager  | `POST` | `/manager/requests/:id/reject`     | Reject with reason                       |
| admin    | `POST` | `/admin/reconcile`                 | Reconcile one key, or active keys        |
| admin    | `GET`  | `/admin/outbox`                    | Outbox inspection                        |
| admin    | `POST` | `/admin/outbox/:id/retry`          | Force retry a dead / stalled row         |
| admin    | `POST` | `/admin/outbox/drain`              | Drain one tick on demand                 |
| HCM      | `POST` | `/hcm/webhooks/batch`              | Signed batch ingress                     |
| HCM      | `POST` | `/hcm/webhooks/balance`            | Signed single-row update                 |
| —        | `GET`  | `/health`                          | Liveness + readiness                     |

## What this service guarantees

For the "why" and the rejected alternatives, see the TRD. The one-screen
summary:

- **Balance integrity:** `effective = cached_hcm_balance − Σ open
reservations`. The reservation is committed inside a `BEGIN IMMEDIATE`
  transaction that re-checks the invariant, so the effective balance is
  never negative from our side.
- **Crash-safe HCM delivery:** approval writes the state change and the
  outbox row in the same transaction. A background worker drains the
  outbox with exponential-backoff retries; permanent HCM failures release
  the reservation and move the request to `HCM_FAILED`.
- **Drift handling:** inbound signed webhooks from HCM replace the cached
  balance without touching reservations; if the new HCM balance is below
  open reservations we flag affected `APPROVED` requests
  `REVIEW_REQUIRED` and emit a `NEGATIVE_DRIFT` audit event. Operators
  can also pull on demand via `POST /admin/reconcile`.
- **AuthN / AuthZ:** JWT bearer + role check + service-layer
  data-ownership check (a manager cannot approve requests outside their
  reports, an employee cannot read other employees' requests).
- **Webhook auth:** HMAC-SHA256 over `${timestamp}.${rawBody}`, ±5-minute
  replay window, checked in a Nest guard that runs _before_ DTO
  validation so a bad signature never leaks field shapes.
- **Idempotency:** `Idempotency-Key` scoped by `(key, endpoint, actor)`;
  outbound HCM calls carry a stable `externalRequestId`.
- **Consistent 4xx shape:** every error (ours or `ValidationPipe`'s) is
  routed through `buildValidationPipe()` + `AllExceptionsFilter` so
  clients branch on stable `error` codes, not on English messages.

## Trade-offs & future work

See [`TRD.md §10`](./TRD.md#10-future-work-out-of-scope-for-this-exercise).

The two biggest deliberate choices worth calling out up front:

1. **SQLite instead of Postgres.** At one process it gives us
   serialisable writes for free and zero setup cost. The migration path
   to Postgres + Redis is documented and the repository pattern keeps
   that cost bounded.
2. **No background scheduler for reconciliation.** The `reconcileActive`
   method is in place; wiring a `@Cron` around it is a one-file change
   when production traffic justifies it. Adding an always-on background
   job _today_ would be pure ceremony.

## Packaging for submission

The Wizdaa email requires a single `.zip` under 50 MB, excluding
`node_modules` and other generated folders. From the repo root:

```bash
zip -r wizdaa-time-off.zip . \
  -x "node_modules/*" ".git/*" "coverage/*" "dist/*" "*.sqlite"
```

The resulting archive is approximately 0.7 MB and contains:

- `src/`, `test/`, `TRD.md`, `README.md`
- `package.json`, `package-lock.json` (for deterministic installs)
- `babel.config.json`, `jsconfig.json`, `.eslintrc.cjs`, `.prettierrc.json`,
  `.prettierignore`, `.gitignore`, `.npmrc`, `.env.example`

The reviewer runs:

```bash
unzip wizdaa-time-off.zip -d time-off && cd time-off
npm install
npm test
npm run test:cov        # coverage/index.html is the proof
```

## License

UNLICENSED — interview exercise.
