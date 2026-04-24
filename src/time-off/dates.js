/**
 * Date helpers for time-off calculations.  We use calendar-date strings
 * (YYYY-MM-DD) rather than Date objects on the boundary to avoid timezone
 * bugs — a "vacation day" is a local-calendar concept.
 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseIsoDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) {
    throw new Error(`Invalid ISO date: ${s}`);
  }
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new Error(`Invalid ISO date: ${s}`);
  }
  return dt;
}

/**
 * Whole-day inclusive count between `start` and `end`.  For the exercise we
 * count every calendar day including weekends — real systems would take a
 * location's working-calendar into account; that logic belongs outside the
 * service.
 */
export function countDaysInclusive(start, end) {
  const s = parseIsoDate(start);
  const e = parseIsoDate(end);
  if (e < s) throw new Error('end date is before start date');
  const diff = (e.getTime() - s.getTime()) / 86_400_000;
  return diff + 1;
}
