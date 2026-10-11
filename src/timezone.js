const FORMATTER_CACHE_MAX = 32;
const PARSE_CACHE_MAX = 20000;
const DAY_MS = 86400000;

const zoneValidity = new Map();
const offsetFormatters = new Map();
const dateFormatters = new Map();
const parseCache = new Map();

/**
 * Returns a usable IANA timezone name, falling back to UTC when the supplied
 * value is missing or not recognised by Intl.
 *
 * @param {string} timeZone - Candidate IANA timezone name.
 * @returns {string} A timezone name Intl.DateTimeFormat accepts.
 */
function safeTimeZone(timeZone) {
  if (!timeZone || typeof timeZone !== 'string') return 'UTC';
  let valid = zoneValidity.get(timeZone);
  if (valid === undefined) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone });
      valid = true;
    } catch (_) {
      valid = false;
    }
    if (zoneValidity.size >= FORMATTER_CACHE_MAX) zoneValidity.delete(zoneValidity.keys().next().value);
    zoneValidity.set(timeZone, valid);
  }
  return valid ? timeZone : 'UTC';
}

/**
 * Returns the memoized Intl formatter for a zone, building it once per zone.
 * Formatter construction dominates parse cost and is idempotent per zone.
 */
function memoFormatter(cache, timeZone, options) {
  let formatter = cache.get(timeZone);
  if (formatter) return formatter;
  formatter = new Intl.DateTimeFormat('en-US', { timeZone, ...options });
  if (cache.size >= FORMATTER_CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(timeZone, formatter);
  return formatter;
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
  const parts = memoFormatter(offsetFormatters, timeZone, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).formatToParts(new Date(instantMs));

  const p = {};
  parts.forEach(part => { p[part.type] = part.value; });

  const hour = parseInt(p.hour, 10) % 24; // Intl can return 24 for midnight
  const asUtc = Date.UTC(
    parseInt(p.year, 10),
    parseInt(p.month, 10) - 1,
    parseInt(p.day, 10),
    hour,
    parseInt(p.minute, 10),
    parseInt(p.second, 10)
  );
  return asUtc - instantMs;
}

/**
 * Resolves a wall-clock time (read as UTC fields in `wallMs`) to the instant at
 * which `timeZone` shows that wall clock.
 *
 * Offsets in force a day either side of the target are tested so both sides of
 * a DST transition are considered; only offsets that round-trip count. The
 * repeated hour of a fall-back resolves to the earlier instant, and a wall time
 * skipped by a spring-forward keeps the pre-transition offset.
 */
function wallTimeToUtc(wallMs, timeZone) {
  const seenOffsets = new Set();
  let earliest = null;

  for (const probe of [wallMs - DAY_MS, wallMs, wallMs + DAY_MS]) {
    const offset = offsetAt(probe, timeZone);
    if (seenOffsets.has(offset)) continue;
    seenOffsets.add(offset);

    const instant = wallMs - offset;
    if (offsetAt(instant, timeZone) === offset && (earliest === null || instant < earliest)) {
      earliest = instant;
    }
  }

  return earliest !== null ? earliest : wallMs - offsetAt(wallMs, timeZone);
}

/** Parses an uncached date string; see {@link parseTimezone}. */
function parseUncached(str, tz) {
  const numeric = Number(str);
  if (Number.isFinite(numeric)) {
    if (numeric <= 0) return null;
    return numeric < 1e11 ? numeric * 1000 : numeric;
  }

  // An explicit Z or +05:30 overrides any timezone assumption.
  if (str.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(str)) {
    const t = new Date(str).getTime();
    return Number.isFinite(t) && t > 0 ? t : null;
  }

  let cleanStr = str.replace(' ', 'T');

  const timeOnly = cleanStr.match(/^(\d{1,2}):(\d{2})(:\d{2})?$/);
  if (timeOnly) {
    const tzDateStr = memoFormatter(dateFormatters, tz, {
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
    const [mm, dd, yyyy] = tzDateStr.split('/');
    const timePart = `${timeOnly[1].padStart(2, '0')}:${timeOnly[2]}${timeOnly[3] || ''}`;
    cleanStr = `${yyyy}-${mm}-${dd}T${timePart}`;
  }

  const wallClockAsUtc = new Date(cleanStr + 'Z').getTime();
  if (!Number.isFinite(wallClockAsUtc)) return null;

  const trueUtcTime = wallTimeToUtc(wallClockAsUtc, tz);
  return trueUtcTime > 0 ? trueUtcTime : null;
}

/**
 * Parses a date string and a timezone into a stable UTC UNIX timestamp (milliseconds).
 *
 * Naive strings are wall-clock times in `timeZone`, never the host zone.
 * Results are memoized per (zone, string) because a match set repeats the same
 * kickoff strings many times; bare "HH:MM" inputs depend on today's date and are
 * never cached.
 *
 * @param {string|number} dateValue - The date string or UNIX timestamp.
 * @param {string} [timeZone='UTC'] - IANA Timezone string (e.g., 'America/New_York', 'UTC').
 * @returns {number|null} - UTC UNIX timestamp in milliseconds, or null if invalid.
 */
function parseTimezone(dateValue, timeZone = 'UTC') {
  if (dateValue === null || dateValue === undefined) return null;

  if (typeof dateValue === 'number') {
    if (!Number.isFinite(dateValue) || dateValue <= 0) return null;
    return dateValue < 1e11 ? dateValue * 1000 : dateValue;
  }

  const str = String(dateValue).trim();
  if (!str || str === '0') return null;

  const tz = safeTimeZone(timeZone);
  const cacheable = !/^\d{1,2}:\d{2}(:\d{2})?$/.test(str.replace(' ', 'T'));
  const key = cacheable ? `${tz}\u0000${str}` : null;

  if (key !== null && parseCache.has(key)) return parseCache.get(key);

  const result = parseUncached(str, tz);
  if (key !== null) {
    if (parseCache.size >= PARSE_CACHE_MAX) parseCache.delete(parseCache.keys().next().value);
    parseCache.set(key, result);
  }
  return result;
}

module.exports = { parseTimezone };
