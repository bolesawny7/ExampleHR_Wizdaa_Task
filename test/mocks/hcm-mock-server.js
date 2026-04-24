/**
 * Programmable in-memory mock of the HCM API surface.
 *
 * Two modes:
 *
 *   1) `createHcmMock({ seed })` returns an *in-process* controller object
 *      with `balances`, `setBalance`, `scheduleFailures`, `calls`, and a
 *      `fetchImpl` that can be injected into HcmClient for integration
 *      tests without network I/O.
 *
 *   2) `startHcmMockServer({ port })` boots a real Express server implementing
 *      the same API, used by e2e tests and local dev (`npm run mock:hcm`).
 *
 * We keep a single source of truth (the `MockHcmState` class) so both modes
 * behave identically.
 */

import http from 'node:http';

export class MockHcmState {
  constructor() {
    this._balances = new Map();               // key -> { balance, asOf }
    this._idempotency = new Map();            // externalRequestId -> 'CONSUMED'|'RELEASED'
    this._calls = [];
    this._failurePlan = [];                   // FIFO per-op error plan
  }

  _key(e, l, t) { return `${e}|${l}|${t}`; }

  setBalance(employeeId, locationId, leaveType, balance, asOf = Date.now()) {
    this._balances.set(this._key(employeeId, locationId, leaveType), { balance, asOf });
  }

  getBalance(employeeId, locationId, leaveType) {
    const v = this._balances.get(this._key(employeeId, locationId, leaveType));
    return v ?? { balance: 0, asOf: Date.now() };
  }

  /**
   * Enqueue a scripted response for the next matching operation.
   *   { op: 'consume'|'release'|'getBalance', status: 500, body: {...} }
   * `status: 0` simulates a network error (only used by in-process mode).
   */
  scheduleFailures(plan) {
    this._failurePlan.push(...plan);
  }

  _popFailure(op) {
    const idx = this._failurePlan.findIndex((f) => f.op === op);
    if (idx === -1) return null;
    const [f] = this._failurePlan.splice(idx, 1);
    return f;
  }

  consume({ employeeId, locationId, leaveType, days, externalRequestId }) {
    if (externalRequestId && this._idempotency.get(externalRequestId) === 'CONSUMED') {
      const snap = this.getBalance(employeeId, locationId, leaveType);
      return { ok: true, balance: snap.balance, idempotent: true };
    }
    const k = this._key(employeeId, locationId, leaveType);
    const cur = this._balances.get(k) ?? { balance: 0, asOf: Date.now() };
    if (cur.balance < days) {
      const err = new Error('insufficient');
      err.status = 422;
      err.body = { error: 'INSUFFICIENT_BALANCE', available: cur.balance, requested: days };
      throw err;
    }
    const next = { balance: cur.balance - days, asOf: Date.now() };
    this._balances.set(k, next);
    if (externalRequestId) this._idempotency.set(externalRequestId, 'CONSUMED');
    return { ok: true, balance: next.balance };
  }

  release({ externalRequestId }) {
    this._idempotency.set(externalRequestId, 'RELEASED');
    return { ok: true };
  }

  calls() { return this._calls.slice(); }

  /**
   * Returns a function with the same shape as `fetch` that dispatches to the
   * mock's internal state.  Used by tests to inject into HcmClient without
   * actually opening sockets.
   */
  fetchImpl() {
    return async (url, init = {}) => {
      const u = new URL(url);
      const method = (init.method || 'GET').toUpperCase();
      const body = init.body ? JSON.parse(init.body) : null;
      this._calls.push({ method, path: `${u.pathname}${u.search}`, body });

      const op = inferOp(method, u.pathname);
      const failure = this._popFailure(op);
      if (failure) {
        if (failure.status === 0) {
          throw new Error('network error (simulated)');
        }
        return makeResponse(failure.status, failure.body ?? {});
      }

      try {
        if (op === 'getBalance') {
          const employeeId = u.searchParams.get('employeeId');
          const locationId = u.searchParams.get('locationId');
          const leaveType = u.searchParams.get('leaveType');
          const snap = this.getBalance(employeeId, locationId, leaveType);
          return makeResponse(200, { employeeId, locationId, leaveType, ...snap });
        }
        if (op === 'consume') {
          const r = this.consume(body);
          return makeResponse(200, r);
        }
        if (op === 'release') {
          const r = this.release(body);
          return makeResponse(200, r);
        }
        return makeResponse(404, { error: 'NOT_FOUND' });
      } catch (err) {
        return makeResponse(err.status ?? 500, err.body ?? { error: 'INTERNAL' });
      }
    };
  }
}

function inferOp(method, pathname) {
  if (method === 'GET' && pathname === '/api/v1/balances') return 'getBalance';
  if (method === 'POST' && pathname === '/api/v1/time-off') return 'consume';
  if (method === 'POST' && pathname === '/api/v1/time-off/release') return 'release';
  return 'unknown';
}

function makeResponse(status, body) {
  const text = JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    async text() { return text; },
    async json() { return JSON.parse(text); },
  };
}

/**
 * Stand up a real HTTP server around a MockHcmState.  Used by e2e tests and
 * `npm run mock:hcm` for manual exploration.
 */
export function startHcmMockServer({ port = 0, state = new MockHcmState() } = {}) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsedBody = body ? safeJson(body) : null;
      const u = new URL(req.url, 'http://localhost');
      const op = inferOp(req.method, u.pathname);
      state._calls.push({ method: req.method, path: req.url, body: parsedBody });

      const failure = state._popFailure(op);
      if (failure) {
        if (failure.status === 0) {
          req.socket.destroy();
          return;
        }
        res.writeHead(failure.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(failure.body ?? {}));
        return;
      }

      try {
        if (op === 'getBalance') {
          const employeeId = u.searchParams.get('employeeId');
          const locationId = u.searchParams.get('locationId');
          const leaveType = u.searchParams.get('leaveType');
          const snap = state.getBalance(employeeId, locationId, leaveType);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ employeeId, locationId, leaveType, ...snap }));
          return;
        }
        if (op === 'consume') {
          const r = state.consume(parsedBody);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(r));
          return;
        }
        if (op === 'release') {
          const r = state.release(parsedBody);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(r));
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'NOT_FOUND' }));
      } catch (err) {
        res.writeHead(err.status ?? 500, { 'content-type': 'application/json' });
        res.end(JSON.stringify(err.body ?? { error: 'INTERNAL' }));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(port, () => {
      const addr = server.address();
      resolve({
        server,
        state,
        port: typeof addr === 'object' ? addr.port : port,
        url: `http://127.0.0.1:${typeof addr === 'object' ? addr.port : port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

if (require.main === module) {
  const port = Number(process.env.MOCK_HCM_PORT || 4000);
  startHcmMockServer({ port }).then(({ url, state }) => {
    state.setBalance('E-1', 'LOC-MAD-01', 'ANNUAL', 15);
    state.setBalance('E-2', 'LOC-NYC-01', 'ANNUAL', 8);
    // eslint-disable-next-line no-console
    console.log(`Mock HCM listening at ${url}`);
  });
}
