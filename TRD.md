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
      - SUM(reservation.days WHERE reservation.state = 'OPEN')
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
using `BEGIN IMMEDIATE` which acquires SQLite's `RESERVED` write lock.**
Any competing `BEGIN IMMEDIATE` waits on `busy_timeout`.  The wrapper is
`DatabaseService.transaction(fn)`; inside `TimeOffService.createRequest`
it does:

1. `BEGIN IMMEDIATE`
2. Read `cached_hcm_balance` and `SUM(open reservations)` for the key.
3. Assert `effective ≥ requested`.
4. Insert the reservation row + the request row + the audit event.
5. `COMMIT`.

Violating the invariant throws `InsufficientBalanceError` which maps to
HTTP 409.

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

**Chosen solution: layered drift detection.**

1. **Push-path (HCM → us):** HCM calls our `POST /hcm/webhooks/batch`
   webhook with a signed payload. We replace the cached balance in an
   atomic transaction **that preserves all open reservations**. If the new
   HCM balance is below current reservations, we emit a
   `BALANCE_SNAPSHOT_NEGATIVE_DRIFT` audit event and mark affected
   `APPROVED` requests as `REVIEW_REQUIRED` instead of silently failing.
2. **Just-in-time (us → HCM):** right before submitting an approved
   request to HCM, the outbox worker re-reads HCM's realtime balance; if
   HCM now has less than the reservation, we bail out of the consume and
   mark the request `REVIEW_REQUIRED`.
3. **On-demand pull (ops → HCM):** `POST /admin/reconcile` lets an
   operator trigger the same snapshot apply for a single key or for all
   recently-active keys.  A scheduled-cron variant is a 30-line addition
   when it becomes operationally necessary (§10); we intentionally did
   not wire one in this exercise to avoid adding a background scheduler
   with no production-sized workload to justify it.

All three paths go through the same idempotent `applyHcmBalanceSnapshot()`
service method, which:
- Upserts the balance row with `updatedAt = now`.
- Never touches `reservations`.
- Recomputes `effective_balance` on demand (it is derived, not stored).
- Emits a `BALANCE_SNAPSHOT_APPLIED` / `…_IGNORED_STALE` /
  `…_NEGATIVE_DRIFT` audit event.

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
- **Retry policy:** exponential backoff `min(60 s, 2^attempt × 500 ms)`
  with ±30 % jitter, capped at `OUTBOX_MAX_ATTEMPTS` (default 8).  With
  the default cap the worst-case total wait before `DEAD` is roughly
  2 minutes — appropriate for the interactive approval flow in this
  exercise.  For production use, ops tune the cap + floor to match the
  HCM's realistic outage profile (the §10 work item mentions moving the
  outbox to a real message queue for longer-horizon retries).  Permanent
  (4xx) HCM failures transition the request to `HCM_FAILED` and release
  the reservation immediately without further retries.
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

**Chosen solution: `Idempotency-Key` header on mutating endpoints, scoped
by `(key, endpoint, actor_id)`** — scoping by actor+endpoint prevents two
different principals from colliding on the same opaque key and prevents a
key intended for `POST /requests` from being replayed against
`POST /requests/:id/cancel`.  The primary key
`(key, endpoint, actor_id)` on `idempotency_keys` enforces this.  First
call stores the response and HTTP status; subsequent calls return it.
TTL 24 h.  The outbound side is kept idempotent by sending the same
`externalRequestId` on every retry.

### C6 — Security & authorization

- **AuthN.** JWT bearer token via `Authorization: Bearer <jwt>`.  HS256 with
  a shared secret is used in this exercise for simplicity; production should
  switch to RS256 + JWKS fetched from the ExampleHR SSO.  Tokens carry
  `sub` (employeeId), `roles[]` (`employee`, `manager`, `admin`), `orgId`,
  and optional `managerId`.
- **AuthZ.** `@Roles()` metadata is enforced by `JwtAuthGuard`, plus
  service-layer *data-ownership* checks (an employee can only read/write
  their own resources; a manager can only approve/reject requests whose
  `managerId` matches their `sub`).  Role ≠ authorization on its own.
- **Webhook signature.** HCM webhooks are signed with HMAC-SHA256 over
  `${timestamp}.${rawBody}`, verified in constant time with a ±5 minute
  replay window.  Enforced by `HcmSignatureGuard`, which runs *before* the
  `ValidationPipe` so a bad signature never leaks DTO shape.
- **Input validation.** Every POST body has a `class-validator` DTO with
  `whitelist` + `forbidNonWhitelisted`.  Validation errors are wrapped into
  our own `{ error: "VALIDATION_ERROR", message, details }` shape via a
  single `buildValidationPipe()` factory.
- **SQL injection.** All DB access goes through `better-sqlite3` prepared
  statements; there is no string interpolation in SQL anywhere.
- **Secrets.** Loaded from env at boot.  `JWT_SECRET` is required and the
  service refuses to start without it outside tests.  Secrets are never
  logged.
- **PII minimization.** Only opaque IDs are persisted or logged; names and
  contact details are never stored by this service.
- **Audit log.** Every state transition and every balance snapshot writes
  an append-only row to `audit_events` (actor, action, target,
  before/after JSON, correlation id), inside the same transaction as the
  business write so an event cannot be lost on crash.

**Not implemented in this exercise, acknowledged in §10:** rate-limiting
middleware and env-schema validation (e.g. Zod) are obvious future hardening
but add no value at the current workload.

### C7 — Observability

What is implemented today:

- **NestJS Logger** writes service-level events (outbox errors, HCM pull
  failures, escalation failures) with a class-tagged prefix.
- **`correlationId`** is generated on request creation (`newCorrelationId()`),
  threaded through the HCM outbox payload, and persisted on every
  `audit_events` row so a full request's story can be reconstructed by
  `SELECT * FROM audit_events WHERE correlation_id = ? ORDER BY id`.
- **`externalRequestId`** is persisted on the request row on approval and
  sent with every HCM consume call, making the outbound side idempotent
  on retries.
- **`GET /health`** runs a `SELECT 1` against SQLite; returns
  `{ status: 'ok' | 'degraded', db }` for liveness/readiness probes.

What is deferred (§10): structured JSON logs, an HCM-ping readiness check,
request-id middleware, and Prometheus-style counters
(`requests_created_total`, `hcm_calls_total`, etc.).  None of these add
value until the service is deployed somewhere that scrapes them; they are
trivial to add when that time comes.

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
  │                 │  │ Machine│  │  │  │ Outbox worker     │  │  │
  │                 │  └────────┘  │  │  │ Reconciliation    │  │  │
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
  id                   TEXT PRIMARY KEY,         -- `r_<nanoid>`
  employee_id          TEXT NOT NULL,
  manager_id           TEXT,
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
  op                  TEXT NOT NULL,            -- 'CONSUME' today (column kept open for future ops)
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

Three inputs feed `BalancesService.applyHcmBalanceSnapshot()` (see §C3 for
the full rationale, this section lists the mechanics only):

- **Inbound batch (`POST /hcm/webhooks/batch`).** Full or partial corpus.
  Each row: `{ employeeId, locationId, leaveType, balance, asOf }`.  Each
  row is applied in its own transaction so a bad row can't poison the
  batch.  When the new HCM balance is below open reservations we tag the
  audit event `BALANCE_SNAPSHOT_NEGATIVE_DRIFT` and move affected
  `APPROVED` requests to `REVIEW_REQUIRED`.
- **Inbound single-key (`POST /hcm/webhooks/balance`).** Same handler
  with a one-row batch.
- **On-demand pull (`POST /admin/reconcile`).** Either
  `{ key: {...} }` to reconcile one tuple, or an empty body to iterate
  `reconcileActive()` over keys touched in the last 7 days.

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
| POST | `/admin/outbox/:id/retry` | Force-retry a dead / stalled outbox entry. |
| POST | `/admin/outbox/drain` | Drain one outbox tick on demand. |

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
| Drift detection | Push (batch webhook) + JIT (pre-consume check) + on-demand pull | Pull only / Push only | Layered defense for a lying HCM.  Scheduled pull deferred until real traffic demands it. |
| Idempotency | Key+endpoint+actor in SQL | Redis | No extra infra; SQLite is fine at expected QPS. |
| ORM | `better-sqlite3` direct + repository pattern | TypeORM / Prisma | Synchronous API matches SQLite; transactional control is explicit; smaller surface. |
| Auth | JWT HS256 today (exercise); RS256 + JWKS in prod | Session | Stateless, already used across ExampleHR. |

## 8. Deployment & Config

- Twelve-factor.  All config via env; see `.env.example`.
- Single process is sufficient at the exercise's scale: SQLite serialises
  all writes, in-process scheduling drains the outbox, and in-process
  state powers idempotency.  Horizontal scale is an explicit §10 item
  (Postgres + Redis + a real message queue).

## 9. Testing Strategy

The PDF emphasizes that **the value lies in the rigor of tests**. We use
three tiers:

### 9.1 Unit tests (pure logic + narrow DB tests with in-memory SQLite)

- `state-machine.spec` — every allowed/denied transition, terminal-state
  rules.
- `dates.spec` — ISO parsing + inclusive day counting with boundary cases
  (leap day, single day, end-before-start).
- `signature.spec` — HMAC round-trip, replay window, bad secret/body.
- `errors.spec` / `exceptions.filter.spec` — DomainError shapes and the
  filter's 500 fallback for non-`HttpException` throwables.
- `balances.service.spec` — effective-balance math, snapshot idempotency
  on identical `asOf`, stale-asOf ignored, negative-drift flagging.
- `time-off.service.spec` — full lifecycle, auth, invalid transitions,
  `CONCURRENT_UPDATE` surfaces when `updateState` loses the race.
- `time-off-repository.spec` — insert/update/list invariants.
- `idempotency.service.spec` — scoping by (key, endpoint, actor), TTL,
  no-op on missing key.
- `audit.service.spec` — row shape, null defaults, `String(targetId)`.
- `jwt.service.spec` — round-trip, expired, tampered.
- `hcm-client.spec` — 5xx→transient, 4xx→permanent, network failure,
  429.
- `outbox-backoff.spec` — `computeBackoffMs` is monotonic on average,
  capped and never negative.
- `health.controller.spec` — healthy / degraded / DB-throws branches.

### 9.2 Integration tests (real in-memory SQLite, Nest DI container, mock HCM)

- `lifecycle.spec` — create → approve → drain outbox → `CONSUMED`; HCM
  transient retries eventually converge; HCM permanent failure →
  `HCM_FAILED` with reservation released; defensive pre-consume flag
  catches mid-flight HCM drift → `REVIEW_REQUIRED`; outbox `DEAD` after
  `OUTBOX_MAX_ATTEMPTS`.
- `reconciliation.spec` — anniversary batch raises cached balance; batch
  below reservations escalates affected `APPROVED` to `REVIEW_REQUIRED`;
  batch does not touch unmentioned keys; pull reconcile applies HCM
  snapshot; active-keys reconcile iterates.
- `balance-integrity.spec` — back-to-back filings that together exceed
  balance, only the first succeeds; cancel releases the reservation and
  the balance can be re-filed.

### 9.3 End-to-end tests (HTTP stack via `supertest`, mock HCM)

- `time-off-api.e2e-spec` — `/health` public; `/me/balances` requires
  JWT (401 shape); creation, 409 on insufficient balance, idempotency
  key replay, ownership check on `GET /me/requests/:id`, manager-reports
  check on approve, cancel, validation shape incl. whitelist.
- `hcm-webhook.e2e-spec` — good signature applies the batch;
  bad/stale signature → 401 with `INVALID_SIGNATURE`; DTO failures after
  good signature → 400 with `VALIDATION_ERROR`; **signature is checked
  before DTO validation** so a bad signature never leaks field names.
- `admin-api.e2e-spec` — non-admin 403; reconcile with/without key;
  outbox list/filter/drain/retry; manager lists + rejects with reason.

### 9.4 Coverage target

- Jest thresholds enforce **≥ 90 %** on statements, lines, and functions
  and **≥ 80 %** on branches across `src/`.  Current run: 93 % stmts /
  80 %+ branches / 96 % funcs / 95 % lines.
- Coverage HTML + lcov reports are emitted to `coverage/`.

## 10. Future Work (out of scope for this exercise)

- Move to Postgres + Redis for horizontal scale; move the outbox worker
  behind a real message queue (SQS / Kafka) for longer retry horizons
  than the 2-minute worst-case we have today.
- Scheduled pull reconciliation (the `reconcileActive` method is already
  in place; only a `@Cron()` wrapper is missing).
- Rate-limiting middleware (per-principal sliding window).
- Env-schema validation at boot (Zod or equivalent).
- Structured JSON logs, request-id middleware, Prometheus counters.
- `HcmClient.releaseBalance` endpoint if / when the HCM contract adds
  server-driven cancellation.
- Partial-day requests (hours), carry-over / accrual policies (currently
  handled entirely in HCM), multi-tenant isolation, OpenAPI/Swagger spec.
