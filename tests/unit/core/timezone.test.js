const { describe, it, expect, afterEach, setSystemTime } = require('bun:test');
const { parseTimezone } = require('../../../src/timezone');

const iso = (ms) => new Date(ms).toISOString();

describe('parseTimezone', () => {
  afterEach(() => setSystemTime());

  describe('numeric inputs', () => {
    it('treats values below 1e11 as seconds and scales them to milliseconds', () => {
      expect(parseTimezone(1755360300)).toBe(1755360300000);
    });

    it('passes millisecond values through unchanged', () => {
      expect(parseTimezone(1755360300000)).toBe(1755360300000);
    });

    it('applies the same second/millisecond heuristic to numeric strings', () => {
      expect(parseTimezone('1755360300')).toBe(1755360300000);
      expect(parseTimezone('1755360300000')).toBe(1755360300000);
    });

    it('rejects null, undefined, zero, negative and non-finite values', () => {
      expect(parseTimezone(null)).toBeNull();
      expect(parseTimezone(undefined)).toBeNull();
      expect(parseTimezone(0)).toBeNull();
      expect(parseTimezone(-5)).toBeNull();
      expect(parseTimezone(NaN)).toBeNull();
      expect(parseTimezone('0')).toBeNull();
      expect(parseTimezone('')).toBeNull();
      expect(parseTimezone('   ')).toBeNull();
    });
  });

  describe('strings carrying their own offset', () => {
    it('honours a trailing Z and ignores the timeZone argument', () => {
      const utc = parseTimezone('2026-08-16T16:05:00Z', 'Asia/Kolkata');
      expect(iso(utc)).toBe('2026-08-16T16:05:00.000Z');
    });

    it('honours an explicit +05:30 offset', () => {
      const utc = parseTimezone('2026-08-16T21:35:00+05:30', 'America/Chicago');
      expect(iso(utc)).toBe('2026-08-16T16:05:00.000Z');
    });

    it('returns null for an unparseable offset-bearing string', () => {
      expect(parseTimezone('not-a-date+05:30')).toBeNull();
    });
  });

  describe('naive wall-clock strings interpreted in a timezone', () => {
    it('uses CDT (-5) for a summer America/Chicago kickoff', () => {
      expect(iso(parseTimezone('2026-08-16T16:05', 'America/Chicago'))).toBe('2026-08-16T21:05:00.000Z');
    });

    it('uses CST (-6) for a winter America/Chicago kickoff', () => {
      expect(iso(parseTimezone('2026-01-10T12:00', 'America/Chicago'))).toBe('2026-01-10T18:00:00.000Z');
    });

    it('switches offset across the US DST boundary within the same call style', () => {
      const before = parseTimezone('2026-03-08T01:00', 'America/Chicago');
      const after = parseTimezone('2026-03-08T03:00', 'America/Chicago');
      expect(iso(before)).toBe('2026-03-08T07:00:00.000Z');
      expect(iso(after)).toBe('2026-03-08T08:00:00.000Z');
    });

    it('uses BST (+1) in summer and GMT in winter for Europe/London', () => {
      expect(iso(parseTimezone('2026-06-01T00:00', 'Europe/London'))).toBe('2026-05-31T23:00:00.000Z');
      expect(iso(parseTimezone('2026-12-01T00:00', 'Europe/London'))).toBe('2026-12-01T00:00:00.000Z');
    });

    it('handles the half-hour Asia/Kolkata offset and midnight rollover', () => {
      expect(iso(parseTimezone('2026-03-15T05:30', 'Asia/Kolkata'))).toBe('2026-03-15T00:00:00.000Z');
      expect(iso(parseTimezone('2026-03-15T00:00', 'Asia/Kolkata'))).toBe('2026-03-14T18:30:00.000Z');
    });

    it('accepts a space between date and time', () => {
      expect(iso(parseTimezone('2026-08-16 16:05:00', 'America/Chicago'))).toBe('2026-08-16T21:05:00.000Z');
    });

    it('returns null for garbage strings', () => {
      expect(parseTimezone('tomorrow evening', 'UTC')).toBeNull();
    });
  });

  describe('time-only strings', () => {
    it('anchors to today in the target timezone', () => {
      setSystemTime(new Date('2026-08-16T02:00:00Z'));
      // 02:00Z is still 2026-08-15 in Chicago, so 21:30 local is the 15th.
      expect(iso(parseTimezone('21:30', 'America/Chicago'))).toBe('2026-08-16T02:30:00.000Z');
    });

    it('pads a single-digit hour', () => {
      setSystemTime(new Date('2026-08-16T12:00:00Z'));
      expect(iso(parseTimezone('9:30', 'UTC'))).toBe('2026-08-16T09:30:00.000Z');
    });

    it('pads a single-digit hour when seconds are present', () => {
      setSystemTime(new Date('2026-08-16T12:00:00Z'));
      expect(iso(parseTimezone('9:30:15', 'UTC'))).toBe('2026-08-16T09:30:15.000Z');
    });
  });

  describe('invalid timezone', () => {
    it('falls back to UTC instead of throwing', () => {
      expect(iso(parseTimezone('2026-08-16T16:05', 'Not/AZone'))).toBe('2026-08-16T16:05:00.000Z');
    });

    it('falls back to UTC for time-only strings too', () => {
      setSystemTime(new Date('2026-08-16T12:00:00Z'));
      expect(iso(parseTimezone('16:05', 'Not/AZone'))).toBe('2026-08-16T16:05:00.000Z');
    });
  });
});
