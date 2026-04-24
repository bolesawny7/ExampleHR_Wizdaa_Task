import { Injectable } from '@nestjs/common';
import { HcmPermanentError, HcmTransientError } from '../common/errors.js';

/**
 * Outbound HCM client.
 *
 * A 4xx response (except 408 / 429) is treated as a *permanent* error that
 * retries cannot fix.  Everything else — timeouts, 5xx, network errors —
 * is *transient* and schedules a retry.  The `_fetch` field is swappable
 * so tests can inject an in-process mock without opening sockets.
 */
@Injectable()
export class HcmClient {
  constructor(config) {
    this._baseUrl = config.hcmBaseUrl;
    this._apiKey = config.hcmApiKey;
    this._fetch = globalThis.fetch;
  }

  async _request(method, path, body) {
    const url = `${this._baseUrl}${path}`;
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${this._apiKey}`,
    };
    let res;
    try {
      res = await this._fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new HcmTransientError(`HCM network error: ${err.message}`, 0);
    }

    let text;
    try {
      text = await res.text();
    } catch {
      text = '';
    }
    if (res.status >= 200 && res.status < 300) {
      return text ? JSON.parse(text) : null;
    }
    if (res.status === 408 || res.status === 429 || res.status >= 500) {
      throw new HcmTransientError(`HCM ${method} ${path} -> ${res.status}: ${text}`, res.status);
    }
    throw new HcmPermanentError(`HCM ${method} ${path} -> ${res.status}: ${text}`, res.status);
  }

  getBalance({ employeeId, locationId, leaveType }) {
    const qs = new URLSearchParams({ employeeId, locationId, leaveType }).toString();
    return this._request('GET', `/api/v1/balances?${qs}`);
  }

  consumeBalance({
    employeeId,
    locationId,
    leaveType,
    days,
    startDate,
    endDate,
    externalRequestId,
    correlationId,
  }) {
    return this._request('POST', '/api/v1/time-off', {
      employeeId,
      locationId,
      leaveType,
      days,
      startDate,
      endDate,
      externalRequestId,
      correlationId,
    });
  }
}
