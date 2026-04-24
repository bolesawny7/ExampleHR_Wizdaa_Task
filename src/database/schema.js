/**
 * SQL schema for the Time-Off service.
 *
 * Design notes (see TRD §5.2):
 *  - `balances.hcm_balance` is the cached HCM snapshot; never mutated by
 *    our business logic — only by `applyHcmBalanceSnapshot`.
 *  - `reservations` is the ledger of locally-committed deductions. Effective
 *    balance = hcm_balance - sum(reservations WHERE state='OPEN').
 *  - All timestamps are ms since epoch as INTEGER for easy comparison/sort.
 *  - The schema is intentionally denormalized (employee_id + location_id +
 *    leave_type on reservations) so the hot-path "sum reservations for key"
 *    query hits a single partial index.
 */
export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS balances (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id     TEXT NOT NULL,
  location_id     TEXT NOT NULL,
  leave_type      TEXT NOT NULL,
  hcm_balance     REAL NOT NULL CHECK (hcm_balance >= 0),
  hcm_snapshot_at INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  version         INTEGER NOT NULL DEFAULT 1,
  UNIQUE (employee_id, location_id, leave_type)
);
CREATE INDEX IF NOT EXISTS idx_balances_employee ON balances(employee_id);

CREATE TABLE IF NOT EXISTS requests (
  id                   TEXT PRIMARY KEY,
  employee_id          TEXT NOT NULL,
  manager_id           TEXT,
  location_id          TEXT NOT NULL,
  leave_type           TEXT NOT NULL,
  start_date           TEXT NOT NULL,
  end_date             TEXT NOT NULL,
  days                 REAL NOT NULL CHECK (days > 0),
  reason               TEXT,
  state                TEXT NOT NULL,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  approver_id          TEXT,
  approved_at          INTEGER,
  external_request_id  TEXT UNIQUE,
  hcm_error            TEXT,
  correlation_id       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_requests_employee ON requests(employee_id);
CREATE INDEX IF NOT EXISTS idx_requests_manager ON requests(manager_id);
CREATE INDEX IF NOT EXISTS idx_requests_state ON requests(state);

CREATE TABLE IF NOT EXISTS reservations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id    TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  employee_id   TEXT NOT NULL,
  location_id   TEXT NOT NULL,
  leave_type    TEXT NOT NULL,
  days          REAL NOT NULL CHECK (days > 0),
  state         TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reservations_open_key
  ON reservations(employee_id, location_id, leave_type)
  WHERE state = 'OPEN';
CREATE INDEX IF NOT EXISTS idx_reservations_request ON reservations(request_id);

CREATE TABLE IF NOT EXISTS hcm_outbox (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id          TEXT NOT NULL REFERENCES requests(id),
  op                  TEXT NOT NULL,
  payload             TEXT NOT NULL,
  attempts            INTEGER NOT NULL DEFAULT 0,
  next_attempt_at     INTEGER NOT NULL,
  status              TEXT NOT NULL,
  last_error          TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_due
  ON hcm_outbox(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key          TEXT NOT NULL,
  endpoint     TEXT NOT NULL,
  actor_id     TEXT NOT NULL,
  status_code  INTEGER NOT NULL,
  response     TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  PRIMARY KEY (key, endpoint, actor_id)
);
CREATE INDEX IF NOT EXISTS idx_idem_expires ON idempotency_keys(expires_at);

CREATE TABLE IF NOT EXISTS audit_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id       TEXT,
  actor_type     TEXT NOT NULL,
  action         TEXT NOT NULL,
  target_type    TEXT NOT NULL,
  target_id      TEXT NOT NULL,
  before_json    TEXT,
  after_json     TEXT,
  correlation_id TEXT,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_events(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at);
`;
