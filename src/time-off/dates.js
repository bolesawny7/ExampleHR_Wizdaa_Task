import { ValidationError } from '../common/errors.js';

/**
 * Date helpers for time-off calculations.  Calendar-date strings (YYYY-MM-DD)
 * are used rather than full Date objects on the boundary because a
 * "vacation day" is a local-calendar concept, not a UTC timestamp.
 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseIsoDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) {
    throw new ValidationError(`Invalid ISO date: ${s}`);
  }
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new ValidationError(`Invalid ISO date: ${s}`);
  }
  return dt;
}

/**
 * Whole-day inclusive count between `start` and `end`.  Every calendar day
 * counts, including weekends — location-specific working-calendar rules
 * belong outside this service.
 */
export function countDaysInclusive(start, end) {
  const s = parseIsoDate(start);
  const e = parseIsoDate(end);
  if (e < s) throw new ValidationError('end date is before start date');
  return (e.getTime() - s.getTime()) / 86_400_000 + 1;
}
