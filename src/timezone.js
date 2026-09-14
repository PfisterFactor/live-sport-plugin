/**
 * Returns a usable IANA timezone name, falling back to UTC when the supplied
 * value is missing or not recognised by Intl.
 *
 * @param {string} timeZone - Candidate IANA timezone name.
 * @returns {string} A timezone name Intl.DateTimeFormat accepts.
 */
function safeTimeZone(timeZone) {
  if (!timeZone || typeof timeZone !== 'string') return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch (_) {
    return 'UTC';
  }
}

/**
 * Returns the UTC offset, in milliseconds, that the given timezone was using
 * at the given instant.
 *
 * @param {number} instantMs - UTC epoch milliseconds.
 * @param {string} timeZone - Valid IANA timezone name.
 * @returns {number} Offset in milliseconds (positive east of Greenwich).
 */
function offsetAt(instantMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).formatToParts(new Date(instantMs));

  const p = {};
  parts.forEach(part => { p[part.type] = part.value; });

  let hour = parseInt(p.hour, 10);
  if (hour === 24) hour = 0; // Intl.DateTimeFormat can return 24 for midnight
  const hourStr = hour.toString().padStart(2, '0');

  const asUtc = Date.parse(`${p.year}-${p.month}-${p.day}T${hourStr}:${p.minute}:${p.second}Z`);
  return asUtc - instantMs;
}

/**
 * Parses a date string and a timezone into a stable UTC UNIX timestamp (milliseconds).
 * 
 * @param {string|number} dateValue - The date string or UNIX timestamp.
 * @param {string} [timeZone='UTC'] - IANA Timezone string (e.g., 'America/New_York', 'UTC').
 * @returns {number|null} - UTC UNIX timestamp in milliseconds, or null if invalid.
 */
function parseTimezone(dateValue, timeZone = 'UTC') {
  if (dateValue === null || dateValue === undefined) return null;

  // If it's already a valid number (UNIX timestamp), return it (assuming milliseconds if > 1e11)
  if (typeof dateValue === 'number') {
    if (!Number.isFinite(dateValue) || dateValue <= 0) return null;
    return dateValue < 1e11 ? dateValue * 1000 : dateValue;
  }

  const str = String(dateValue).trim();
  if (!str || str === '0') return null;

  // If it's a numeric string representing a timestamp
  const numeric = Number(str);
  if (Number.isFinite(numeric)) {
    if (numeric <= 0) return null;
    return numeric < 1e11 ? numeric * 1000 : numeric;
  }

  // If the string contains an explicit explicit timezone offset like Z or +05:30
  // we can just let native Date parse it, as it overrides local timezone assumptions
  const hasTimezoneOffset = str.endsWith('Z') || str.match(/[+-]\d{2}:?\d{2}$/);
  if (hasTimezoneOffset) {
    const t = new Date(str).getTime();
    return Number.isFinite(t) && t > 0 ? t : null;
  }

  const tz = safeTimeZone(timeZone);

  // Replace spaces with T for proper ISO format compatibility
  let cleanStr = str.replace(' ', 'T');

  // If the string is just a time (e.g. "21:30" or "21:30:00"), prepend today's date in target timezone.
  const timeOnly = cleanStr.match(/^(\d{1,2}):(\d{2})(:\d{2})?$/);
  if (timeOnly) {
    const tzDateStr = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
    const [mm, dd, yyyy] = tzDateStr.split('/');
    const timePart = `${timeOnly[1].padStart(2, '0')}:${timeOnly[2]}${timeOnly[3] || ''}`;
    cleanStr = `${yyyy}-${mm}-${dd}T${timePart}`;
  }

  // We treat the incoming local time string as if it were UTC.
  // Example: "2026-08-16T16:05" -> "2026-08-16T16:05Z"
  const wallClockAsUtc = new Date(cleanStr + 'Z').getTime();
  if (!Number.isFinite(wallClockAsUtc)) return null;

  // First pass uses the offset in effect at the wall clock read as UTC; the
  // second pass re-reads the offset at the candidate instant so kickoffs near
  // a DST transition land on the offset that is actually in force then.
  let trueUtcTime = wallClockAsUtc - offsetAt(wallClockAsUtc, tz);
  const refined = wallClockAsUtc - offsetAt(trueUtcTime, tz);
  if (offsetAt(refined, tz) === offsetAt(trueUtcTime, tz)) trueUtcTime = refined;

  return trueUtcTime > 0 ? trueUtcTime : null;
}

module.exports = { parseTimezone };
