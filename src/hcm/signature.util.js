import crypto from 'node:crypto';

/**
 * HMAC-SHA256 request signing for HCM <-> Time-Off, in both directions.
 *
 * Canonical string: `${timestamp}.${rawBody}`
 * Signature header: `sha256=<hex>`
 *
 * Callers MUST pass the raw body (bytes), not a JSON re-stringify, to avoid
 * whitespace/ordering sensitivities leading to signature mismatches.
 */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

export function sign(secret, timestampMs, rawBody) {
  const canonical = `${timestampMs}.${rawBody}`;
  const digest = crypto
    .createHmac('sha256', secret)
    .update(canonical)
    .digest('hex');
  return `sha256=${digest}`;
}

export function verify({ secret, timestampMs, rawBody, signature, now = Date.now() }) {
  if (!signature || !timestampMs) return false;
  const tsNum = Number(timestampMs);
  if (!Number.isFinite(tsNum)) return false;
  if (Math.abs(now - tsNum) > CLOCK_SKEW_MS) return false;
  const expected = sign(secret, tsNum, rawBody);
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'utf8'),
      Buffer.from(expected, 'utf8'),
    );
  } catch {
    return false;
  }
}
