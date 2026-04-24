import { sign, verify } from '../../src/hcm/signature.util.js';

describe('signature.util', () => {
  const secret = 'super-secret';
  const body = JSON.stringify({ batchId: 'B-1', balances: [] });
  const ts = 1_745_000_000_000;

  test('verify accepts a matching signature within skew window', () => {
    const sig = sign(secret, ts, body);
    expect(verify({ secret, timestampMs: ts, rawBody: body, signature: sig, now: ts + 100 }))
      .toBe(true);
  });

  test('verify rejects when timestamp is outside skew window', () => {
    const sig = sign(secret, ts, body);
    expect(verify({ secret, timestampMs: ts, rawBody: body, signature: sig,
                    now: ts + 10 * 60 * 1000 })).toBe(false);
  });

  test('verify rejects on wrong body', () => {
    const sig = sign(secret, ts, body);
    expect(verify({ secret, timestampMs: ts, rawBody: '{}', signature: sig, now: ts }))
      .toBe(false);
  });

  test('verify rejects on wrong secret', () => {
    const sig = sign(secret, ts, body);
    expect(verify({ secret: 'other', timestampMs: ts, rawBody: body, signature: sig, now: ts }))
      .toBe(false);
  });

  test('verify rejects missing signature/timestamp', () => {
    expect(verify({ secret, timestampMs: ts, rawBody: body, signature: '' })).toBe(false);
    expect(verify({ secret, timestampMs: '', rawBody: body, signature: 'x' })).toBe(false);
    expect(verify({ secret, timestampMs: 'abc', rawBody: body, signature: 'x' })).toBe(false);
  });
});
