# Time-Off Microservice — Technical Requirements Document (TRD)

> Version: 1.0 — Author: ExampleHR Time-Off Team — Status: Proposed

## 1. Executive Summary

ExampleHR is building a Time-Off microservice that is the primary system of
engagement for employees to request time off, while the customer's Human
Capital Management (HCM) system (Workday, SAP, etc.) remains the **system of
record** for employment data and, crucially, for time-off balances.

The core engineering problem is **balance integrity under distributed state**:

- HCM can mutate balances independently of us (anniversary grants, yearly
  accrual rollovers, manual adjustments by HR).
- We mutate the *effective* available balance every time an employee files a
  request (holding the balance until it is approved and consumed).
- HCM's contract is defensive in name only — the spec says HCM *should* reject
  invalid dimensions or negative balances, but *this may not be guaranteed*.
  We must behave correctly even when HCM lies or is silent.

This document defines the requirements, architecture, API, data model,
failure modes, security considerations, and testing strategy for the service.

## 2. Glossary

| Term | Meaning |
|------|---------|
| **HCM** | Human Capital Management system (Workday/SAP). Source of truth for balances. |
| **Balance** | Remaining time-off (in days) for a given `(employeeId, locationId, leaveType)` tuple. |
| **Reservation** | Amount of a balance that is locally committed to pending/approved requests but not yet consumed by HCM. |
| **Effective balance** | `hcm_balance - sum(open_reservations)`. What the employee sees and what we validate against. |
| **Request** | A time-off request, going through a state machine. |
| **Drift** | A discrepancy between our cached HCM balance and the authoritative HCM balance. |
| **Reconciliation** | Process of detecting and healing drift. |
| **Idempotency key** | A client-supplied unique key that makes retried writes safe. |

## 3. Requirements

### 3.1 Functional Requirements

| # | Requirement |
|---|-------------|
| F1 | An employee can **view** their current balances per `(location, leaveType)`. |
| F2 | An employee can **file** a time-off request with a date range and leave type. |
| F3 | An employee can **cancel** their own pending/approved request (pre-consumption). |
| F4 | A manager can **approve** or **reject** a request that is under their employee. |
| F5 | The service **validates balance availability** before allowing a request to be filed and again before approval. |
| F6 | The service **submits approved requests to HCM** to consume the balance. |
| F7 | The service **receives a realtime balance update** (push from HCM or poll from HCM for any `(employeeId, locationId)`). |
| F8 | The service **ingests a full-corpus batch** from HCM (for anniversaries, yearly refresh, corrections) without losing in-flight reservations. |
| F9 | The service exposes **reconciliation** endpoints that detect and report drift. |
| F10 | Every mutation is **audited** (who/what/when/why) for compliance. |

### 3.2 Non-Functional Requirements

| # | Requirement | Rationale |
|---|-------------|-----------|
| N1 | **Balance integrity is never violated from our side.** The *effective balance* we expose is never negative. This is our single most important invariant. | If we tell an employee "you have 2 days" and we fail to stop a 3-day request, we lose their trust and create HR disputes. |
| N2 | **Idempotent writes** for all mutation endpoints (client + HCM direction). | Retries are unavoidable in distributed systems. |
| N3 | **At-least-once delivery** to HCM, with deduplication by `externalRequestId`. | The HCM realtime API can fail or time out. |
| N4 | **Eventual consistency with HCM, within 5 minutes** under normal operation; **bounded divergence** under HCM outage. | Employees tolerate short delays but not stale data for days. |
| N5 | **p95 latency** < 200ms for reads, < 500ms for writes that only touch local DB. HCM-round-trip writes are bounded by HCM. | Responsive UX. |
| N6 | **All PII** (employeeId as opaque, no names in logs) is minimized. Auth is mandatory. | Compliance (GDPR, regional labour laws). |
| N7 | **Recoverable from any partial failure** — process crash mid-HCM-call must not leak reservations. | Crash safety. |
| N8 | **Observability**: every request gets a correlation ID; every HCM call is logged with outcome. | Ops, debuggability. |

## 4. Challenges & Design Decisions

This section is the heart of the TRD. Each challenge is paired with the chosen
solution and rejected alternatives.

### C1 — Who owns the balance?

**Problem.** Both systems want to "own" the balance. If we authoritatively
deduct locally without HCM consent, our ledger diverges. If we always ask HCM,
we are unavailable whenever HCM is.

**Chosen solution: HCM is the system of record; we keep a cached *materialized*
view of HCM balance + a local ledger of *reservations*.**

```
effective_balance(employee, location, leaveType) =
        cached_hcm_balance
      - SUM(reservation.days WHERE state IN (PENDING, APPROVED, PENDING_CONSUME))
```

We always display *effective balance* to the user. When a request is filed, we
*atomically* insert a reservation row while verifying the invariant
`effective_balance >= requested_days`. HCM is the final authority when we
submit the approved request; if HCM rejects, we roll the reservation back.

**Alternatives considered.**

- **Authoritative local ledger with HCM as observer.** Rejected — violates the
  PDF's explicit statement that HCM is source of truth, and creates forever
  drift when HCM grants anniversary bonuses.
- **Synchronous pass-through (no local cache).** Rejected — makes us entirely
  unavailable when HCM is, and HCM latencies (often seconds) are unacceptable
  in the hot path of "show me my balance."
- **Event-sourced projection of HCM events.** Rejected as primary model —
  HCM's realtime API is request/response, not event-stream. We *do* keep an
  audit-style append-only log of our own decisions (see §5.4).

### C2 — Balance race conditions

**Problem.** Two concurrent requests for the same `(employee, location)` both
pass the "enough balance" check and commit, producing negative effective
balance.

**Chosen solution: pessimistic locking inside a single SQLite transaction,
using `BEGIN IMMEDIATE` which acquires a `RESERVED` write lock.** SQLite only
supports one writer at a time, so any competing `BEGIN IMMEDIATE` waits on its
`busy_timeout`. Our `balanceTransaction()` helper:

1. `BEGIN IMMEDIATE`
2. Read `cached_hcm_balance` and sum of open reservations for the key.
3. Assert invariant.
4. Insert reservation.
5. `COMMIT`

Violations throw `InsufficientBalanceError` which the controller maps to HTTP
409 Conflict.

**Alternatives considered.**

- **Optimistic concurrency with a `version` column.** Works, but on conflict
  we must retry, which complicates controllers and makes latency worse under
  contention. Pessimistic is simpler in single-writer SQLite.
- **Distributed lock (Redis).** Overkill; we have one writer per DB anyway.
- **Relying on HCM to reject.** Explicitly called out in the problem statement
  as untrustworthy: *"this may not be always guaranteed; we want to be
  defensive about it."*

### C3 — HCM drift (unilateral balance changes)

**Problem.** On Monday the employee has 10 days in HCM. On Tuesday HR grants a
5-day anniversary bonus in HCM. Our cache still says 10. The employee sees 10
when they actually have 15. Worse case: HR *reduces* a balance to 5 while we
still have a 7-day reservation outstanding; on submit, HCM rejects.

**Chosen solution: three-tier drift detection.**

1. **Push-path (preferred):** HCM calls our `POST /hcm/balances/batch`
   webhook with a signed payload. We replace the cached balance in an
   atomic transaction **that preserves all open reservations**. If the new
   HCM balance is below current reservations, we raise a `NEGATIVE_DRIFT`
   alert and mark affected requests `REVIEW_REQUIRED` instead of silently
   failing.
2. **Pull-path (scheduled):** `ReconciliationService` runs on a cron
   (configurable, default every 15 min) calling HCM's realtime API for a
   sliding window of recently-active employees, comparing and patching.
3. **Just-in-time:** right before submitting an approved request to HCM, we
   re-query HCM's realtime balance; if it disagrees with our cache by more
   than tolerance, we reconcile first.

All three paths go through the same idempotent `applyHcmBalanceSnapshot()`
service method, which:
- Upserts the balance row with `updatedAt = now`.
- Never touches `reservations`.
- Recomputes `effective_balance` on demand (it is derived, not stored).
- Emits `BalanceSnapshotApplied` audit event.

**Alternatives considered.**

- **Trust the batch fully; treat in-flight reservations as implicitly
  cancelled.** Rejected — destroys UX; an employee whose approved PTO
  vanishes because HR edited a cell is a disaster.
- **Only pull-path.** Rejected — the PDF explicitly calls out that HCM has a
  push batch endpoint; using it is cheaper and fresher.

### C4 — HCM is unreliable / may lie

**Problem.** HCM can (a) be unavailable, (b) be slow, (c) 200-OK but with
wrong data, (d) 500 but actually persist, (e) silently accept a negative
balance. We must be defensive about *every* one of these.

**Chosen solution: explicit *outbox* pattern for outbound writes, bounded
local invariant for reads.**

- **Outbox:** when we approve a request, the act of approval *does not* call
  HCM. Instead, it writes a row to `hcm_outbox` inside the same transaction
  that changes the request state. A background worker pops from the outbox,
  calls HCM, and marks success or retries. This makes approval durable even
  if HCM is down.
- **Retry policy:** exponential backoff, jittered, max 8 attempts over ~24h.
  Permanent failure transitions the request to `HCM_FAILED` and alerts.
- **Double-check before side-effect:** before the outbox worker calls
  `hcm.consumeBalance()`, it re-reads the *current* HCM balance via the
  realtime API. If HCM's balance is lower than our expected value, we
  reconcile and re-evaluate.
- **Defensive reads:** every write-that-deducts against HCM is guarded by our
  own invariant `effective_balance >= days`. We never rely solely on HCM
  returning an error.

**Alternatives considered.**

- **Direct inline HCM call under the controller request.** Rejected — pins
  approval latency to HCM latency; rollbacks on crash are hard.
- **Full two-phase commit with HCM.** HCM doesn't support 2PC — impossible.
- **Saga with compensating transactions.** That is effectively what our
  outbox + state machine implements; we chose the term *outbox* for
  clarity.

### C5 — Idempotency

**Problem.** A flaky mobile client retries `POST /requests`. Without care, we
create two reservations.

**Chosen solution: `Idempotency-Key` header on all mutating endpoints + unique
index on `idempotency_keys(key, endpoint)`**. First call records the key and
response; subsequent calls with the same key return the stored response. TTL
24h. Same mechanism guards our outbound HCM calls (`externalRequestId`).

### C6 — Security & authorization

- **AuthN.** JWT signed with asymmetric keys (issuer = ExampleHR SSO). Tokens
  carry `sub` (employeeId), `roles[]` (`employee`, `manager`, `admin`,
  `hcm_webhook`), and `orgId`.
- **AuthZ.** Guard each route with `@Roles()`. An employee can only read/write
  their own resources; a manager can read/approve/reject requests of employees
  whose `managerId` is the requester's `sub`.
- **Webhook signature.** HCM batch webhook is signed with HMAC-SHA256 over
  `timestamp + body`, verified in constant time; replay window = 5 minutes.
- **Input validation.** Every DTO validated with `class-validator`. Whitelist
  unknown fields. All date/duration math on the server.
- **SQL injection.** All DB access through prepared statements
  (`better-sqlite3`). No string interpolation in SQL.
- **Rate limiting.** Per-principal sliding window (100 req/min default,
  tunable). Webhook path has its own bucket.
- **Secrets.** Loaded from env with Zod-like validation at boot. Never logged.
- **PII minimization.** Only opaque IDs are logged; employee names and
  contact details are never persisted by this service.
- **Audit log.** Every state transition, every HCM call, every admin action
  goes to an append-only `audit_events` table with an actor, action, target,
  before/after, and correlation ID.

### C7 — Observability

- Structured JSON logs with `requestId`, `correlationId`, `actor`,
  `action`, `outcome`, `durationMs`.
- Log HCM calls with `externalRequestId` and HTTP status.
- Health check endpoint `/health` (liveness + readiness; readiness probes
  DB + last-successful HCM ping within SLA).
- Metrics-ready hooks (counters for `requests_created`, `reservations_open`,
  `hcm_calls_total`, `drift_detected_total`).

## 5. Architecture

### 5.1 Component Diagram (text)

```
          ┌──────────────┐        ┌───────────────────────────────┐
          │  Employees   │        │            HCM                │
          │  (web/mobile)│        │  (Workday / SAP / mock)       │
          └──────┬───────┘        └─────▲──────────────┬──────────┘
                 │ HTTPS                │ realtime     │ batch webhook
                 │ + JWT                │ API          │ (signed)
                 ▼                      │              ▼
  ┌─────────────────────────────────────┴──────────────────────────┐
  │                Time-Off Microservice (NestJS)                  │
  │                                                                │
  │   ┌──────────┐  ┌──────────────┐  ┌─────────────────────────┐  │
  │   │ Auth/    │  │  Time-Off    │  │    HCM Module           │  │
  │   │ Guards   │──│   Module     │──│  ┌───────────────────┐  │  │
  │   └──────────┘  │  ┌────────┐  │  │  │ HcmClient (out)   │  │  │
  │                 │  │ State  │  │  │  │ HcmController(in) │  │  │
  │                 │  │ Machine│  │  │  │ Reconciliation    │  │  │
  │                 │  └────────┘  │  │  │   Service (cron)  │  │  │
  │                 └───────┬──────┘  │  └───────────────────┘  │  │
  │                         │         └──────────┬──────────────┘  │
  │                  ┌──────▼─────────────────────▼──────────────┐ │
  │                  │           SQLite (better-sqlite3)          │ │
  │                  │  balances | reservations | requests |      │ │
  │                  │  hcm_outbox | audit_events |               │ │
  │                  │  idempotency_keys                           │ │
  │                  └─────────────────────────────────────────────┘ │
  └────────────────────────────────────────────────────────────────┘
```

### 5.2 Data Model (SQLite)

```sql
CREATE TABLE balances (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id     TEXT NOT NULL,
  location_id     TEXT NOT NULL,
  leave_type      TEXT NOT NULL,                 -- 'ANNUAL' | 'SICK' | ...
  hcm_balance     REAL NOT NULL CHECK (hcm_balance >= 0),
  hcm_snapshot_at INTEGER NOT NULL,              -- ms epoch
  updated_at      INTEGER NOT NULL,
  version         INTEGER NOT NULL DEFAULT 1,
  UNIQUE (employee_id, location_id, leave_type)
);
CREATE INDEX idx_balances_employee ON balances(employee_id);

CREATE TABLE requests (
  id                   TEXT PRIMARY KEY,         -- UUID
  employee_id          TEXT NOT NULL,
  location_id          TEXT NOT NULL,
  leave_type           TEXT NOT NULL,
  start_date           TEXT NOT NULL,            -- ISO date
  end_date             TEXT NOT NULL,
  days                 REAL NOT NULL CHECK (days > 0),
  reason               TEXT,
  state                TEXT NOT NULL,            -- see state machine
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  approver_id          TEXT,
  approved_at          INTEGER,
  external_request_id  TEXT UNIQUE,              -- idempotency for HCM
  hcm_error            TEXT,                     -- last HCM error, if any
  correlation_id       TEXT NOT NULL
);
CREATE INDEX idx_requests_employee ON requests(employee_id);
CREATE INDEX idx_requests_state ON requests(state);

CREATE TABLE reservations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id    TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  employee_id   TEXT NOT NULL,
  location_id   TEXT NOT NULL,
  leave_type    TEXT NOT NULL,
  days          REAL NOT NULL CHECK (days > 0),
  state         TEXT NOT NULL,                   -- OPEN | CONSUMED | RELEASED
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_reservations_open_key
  ON reservations(employee_id, location_id, leave_type)
  WHERE state = 'OPEN';

CREATE TABLE hcm_outbox (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id          TEXT NOT NULL REFERENCES requests(id),
  op                  TEXT NOT NULL,            -- CONSUME | RELEASE | FETCH
  payload             TEXT NOT NULL,            -- JSON
  attempts            INTEGER NOT NULL DEFAULT 0,
  next_attempt_at     INTEGER NOT NULL,
  status              TEXT NOT NULL,            -- PENDING|INFLIGHT|DONE|DEAD
  last_error          TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX idx_outbox_due
  ON hcm_outbox(status, next_attempt_at);

CREATE TABLE idempotency_keys (
  key          TEXT NOT NULL,
  endpoint     TEXT NOT NULL,
  actor_id     TEXT NOT NULL,
  status_code  INTEGER NOT NULL,
  response     TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  PRIMARY KEY (key, endpoint, actor_id)
);

CREATE TABLE audit_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id       TEXT,
  actor_type     TEXT NOT NULL,                 -- USER|SYSTEM|HCM
  action         TEXT NOT NULL,
  target_type    TEXT NOT NULL,
  target_id      TEXT NOT NULL,
  before_json    TEXT,
  after_json     TEXT,
  correlation_id TEXT,
  created_at     INTEGER NOT NULL
);
```

### 5.3 Request State Machine

```
              filed
               │
               ▼
      ┌──────────────┐         employee cancel
      │   PENDING    │ ───────────────────────────► CANCELLED
      └──────┬───────┘                                   ▲
             │ manager approve        manager reject     │
             ▼                  ─────────────────►       │
      ┌──────────────┐                             REJECTED
      │   APPROVED   │
      └──────┬───────┘
             │ outbox worker → HCM consume ok
             ▼
      ┌──────────────┐
      │  CONSUMED    │ (terminal, reservation → CONSUMED)
      └──────────────┘

      HCM permanently rejects after retries
      APPROVED ──────────────────────────► HCM_FAILED ── reservation RELEASED

      HCM drift caught by reconciliation while APPROVED
      APPROVED ──────────────────────────► REVIEW_REQUIRED
```

Invariants enforced by the state machine module:
- Only listed transitions allowed; everything else throws.
- On entry into `CANCELLED | REJECTED | HCM_FAILED`, the reservation is
  released (`state = RELEASED`).
- On entry into `CONSUMED`, reservation is marked `CONSUMED` (stops counting
  against effective balance but is retained for audit).

### 5.4 Sync & Reconciliation

- **Inbound batch (`POST /hcm/webhooks/batch`).** Full or partial corpus.
  Each row: `{ employeeId, locationId, leaveType, balance, asOf }`. We
  `applyHcmBalanceSnapshot()` per row, inside a transaction. If new balance
  < open reservations for the key, we raise `NEGATIVE_DRIFT` (request → review).
- **Inbound realtime upsert (`POST /hcm/balances`).** Per-key snapshot; same
  handler.
- **Outbound reconciliation cron.** Every 15 min:
  1. Select top-N keys active in last 7 days.
  2. For each, call HCM `getBalance(employeeId, locationId, leaveType)`.
  3. If `|hcm - cached| > tolerance`, `applyHcmBalanceSnapshot()`.
- **On-demand reconciliation (`POST /admin/reconcile`).** Ops tool for a
  single employee or location.

### 5.5 Outbox worker

Separate `@Injectable()` runs on an interval (default 2s). Picks up to N
`PENDING` rows whose `next_attempt_at <= now`, marks `INFLIGHT`, calls HCM,
then marks `DONE` or reschedules with exponential backoff + jitter. Idempotent
thanks to `externalRequestId`.

## 6. API (REST)

All write endpoints accept `Idempotency-Key` header (recommended). All
endpoints require `Authorization: Bearer <jwt>`, except `/health` and the HCM
webhooks (which are signed).

### 6.1 Employee-facing

| Method | Path | Description |
|--------|------|-------------|
| GET | `/me/balances` | Effective balances for the authenticated employee. |
| POST | `/me/requests` | File a new request. |
| GET | `/me/requests` | List own requests. |
| GET | `/me/requests/:id` | Detail. |
| POST | `/me/requests/:id/cancel` | Cancel own pending/approved request. |

### 6.2 Manager-facing

| Method | Path | Description |
|--------|------|-------------|
| GET | `/manager/requests` | Requests pending my approval. |
| POST | `/manager/requests/:id/approve` | Approve. |
| POST | `/manager/requests/:id/reject` | Reject with reason. |

### 6.3 Admin / Ops

| Method | Path | Description |
|--------|------|-------------|
| POST | `/admin/reconcile` | Trigger reconciliation for a key or set. |
| GET | `/admin/outbox` | Outbox inspection. |
| POST | `/admin/outbox/:id/retry` | Force-retry a dead outbox entry. |
| GET | `/admin/balances` | Global balances read (paginated). |

### 6.4 HCM inbound (signed, not JWT)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/hcm/webhooks/batch` | Full/partial balance corpus. |
| POST | `/hcm/webhooks/balance` | Single-key update. |

### 6.5 Health

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Liveness + readiness. |

### 6.6 Sample contracts

```http
POST /me/requests
Authorization: Bearer <jwt>
Idempotency-Key: 2026-04-24-ed7f...
Content-Type: application/json

{
  "locationId": "LOC-MAD-01",
  "leaveType": "ANNUAL",
  "startDate": "2026-05-04",
  "endDate":   "2026-05-06",
  "reason":    "Short break"
}

→ 201 Created
{
  "id":"r_01HXC...",
  "state":"PENDING",
  "days":3,
  "effectiveBalanceAfter": 7
}

→ 409 Conflict (insufficient balance)
{ "error":"INSUFFICIENT_BALANCE", "available": 2, "requested": 3 }
```

```http
POST /hcm/webhooks/batch
X-Hcm-Timestamp: 1745000000
X-Hcm-Signature: sha256=...

{
  "batchId":"B-2026-04-24",
  "asOf":"2026-04-24T00:00:00Z",
  "balances":[
    {"employeeId":"E-1","locationId":"LOC-MAD-01","leaveType":"ANNUAL","balance":15},
    ...
  ]
}
```

## 7. Alternatives Considered (summary)

| Decision | Chosen | Alternatives | Why |
|----------|--------|--------------|-----|
| Source of truth | HCM, locally cached | Local authoritative | PDF mandates HCM; otherwise drift on anniversaries. |
| Concurrency | Pessimistic `BEGIN IMMEDIATE` | OCC with `version` | SQLite is single-writer; simpler; no retry loop. |
| HCM side effect | Outbox + worker | Inline call | Inline pins latency to HCM and is not crash-safe. |
| Drift detection | Push + pull + JIT | Pull only / Push only | Layered defense for a lying HCM. |
| Idempotency | Key+endpoint+actor in SQL | Redis | No extra infra; SQLite is fine at expected QPS. |
| ORM | `better-sqlite3` direct + repository pattern | TypeORM / Prisma | Synchronous API matches SQLite; transactional control is explicit; smaller surface. |
| Auth | JWT RS256 | Session | Stateless, already used across ExampleHR. |

## 8. Deployment & Config

- 12-factor. All config via env (`.env.example` provided).
- Single process is enough at current scale; horizontal scaling requires
  moving from SQLite to Postgres and moving idempotency/outbox to Redis or
  Postgres (this is an explicit future item §10).
- SQLite file backed up via LiteStream or periodic snapshot (outside scope).

## 9. Testing Strategy

The PDF emphasizes that **the value lies in the rigor of tests**. We use
three tiers:

### 9.1 Unit tests (fast, no I/O, mock DB or in-memory SQLite)

- `state-machine.spec` — every allowed/denied transition.
- `balances.service.spec` — effective balance math, drift classification,
  reservation release.
- `reconciliation.service.spec` — snapshot application, negative-drift
  branch, idempotency.
- `hcm.outbox.spec` — backoff, DLQ, retry ceiling.
- `signature.util.spec` — valid sig, expired timestamp, wrong body.

### 9.2 Integration tests (real in-memory SQLite, Nest DI container)

- Full request lifecycle PENDING → APPROVED → CONSUMED.
- Two concurrent requests for same key — exactly one succeeds (race).
- Approve while HCM down — outbox retries and eventually succeeds.
- HCM permanently rejects — request → `HCM_FAILED`, reservation released.
- Inbound batch reduces balance below open reservations → `REVIEW_REQUIRED`.
- Idempotency: same `Idempotency-Key` twice returns same response.

### 9.3 End-to-end tests (HTTP, mock HCM server)

- Employee files → manager approves → mock HCM receives consume call → state
  becomes `CONSUMED`.
- Mock HCM returns 500 for N attempts then 200 — we eventually converge.
- Mock HCM sends anniversary batch — balance rises without disturbing open
  requests.
- Signed webhook rejected when signature bad or timestamp stale.
- AuthZ: employee cannot read another employee's balances; manager cannot
  approve outside their reports.

### 9.4 Coverage target

- **≥ 90% line, ≥ 85% branch** across `src/` (enforced in CI by Jest
  thresholds).
- Coverage HTML + lcov reports emitted to `coverage/`.

## 10. Future Work (out of scope for this exercise)

- Move to Postgres + Redis for horizontal scale.
- Replace outbox cron with a proper message queue (SQS/Kafka).
- Support partial-day requests (hours).
- Carry-over / accrual policy engine (currently handled entirely in HCM).
- Multi-tenant isolation at row level.
- Full OpenAPI spec (Swagger module is plumbed but spec is partial).
