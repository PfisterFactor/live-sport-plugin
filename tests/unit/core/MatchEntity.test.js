const { describe, it, expect } = require('bun:test');
const MatchEntity = require('../../../src/domain/MatchEntity');

describe('MatchEntity', () => {
  describe('date normalization', () => {
    it('converts a second-precision timestamp into a millisecond string', () => {
      expect(new MatchEntity({ timestamp: 1786896300 }).date).toBe('1786896300000');
    });

    it('keeps a millisecond timestamp as-is', () => {
      expect(new MatchEntity({ timestamp: 1786896300000 }).date).toBe('1786896300000');
    });

    it('parses an ISO date string into millis', () => {
      expect(new MatchEntity({ date: '2026-08-16T16:05:00Z' }).date).toBe('1786896300000');
    });

    it('interprets a naive date string as UTC', () => {
      expect(new MatchEntity({ date: '2026-08-16T16:05:00' }).date).toBe('1786896300000');
    });

    it('prefers timestamp over date when both are present', () => {
      const m = new MatchEntity({ timestamp: 1786896300, date: '2020-01-01T00:00:00Z' });
      expect(m.date).toBe('1786896300000');
    });

    it('falls back to an empty string for unparseable or missing dates', () => {
      expect(new MatchEntity({}).date).toBe('');
      expect(new MatchEntity({ date: 'sometime soon' }).date).toBe('');
      expect(new MatchEntity({ date: '0' }).date).toBe('');
    });

    it('exposes the date as a string so parseInt-based consumers keep working', () => {
      const m = new MatchEntity({ timestamp: 1786896300000 });
      expect(typeof m.date).toBe('string');
      expect(parseInt(m.date, 10)).toBe(1786896300000);
    });
  });

  describe('league normalization', () => {
    it('unwraps a league object by name', () => {
      expect(new MatchEntity({ league: { name: 'Premier League' } }).league).toBe('Premier League');
    });

    it('falls back to the league object title', () => {
      expect(new MatchEntity({ league: { title: 'NBA' } }).league).toBe('NBA');
    });

    it('stringifies a scalar league and empties an unusable one', () => {
      expect(new MatchEntity({ league: 42 }).league).toBe('42');
      expect(new MatchEntity({ league: {} }).league).toBe('');
      expect(new MatchEntity({}).league).toBe('');
    });
  });

  describe('flags and collections', () => {
    it("normalizes popular to '1' only for the truthy forms", () => {
      expect(new MatchEntity({ popular: '1' }).popular).toBe('1');
      expect(new MatchEntity({ popular: true }).popular).toBe('1');
      expect(new MatchEntity({ popular: '0' }).popular).toBe('0');
      expect(new MatchEntity({ popular: 1 }).popular).toBe('0');
      expect(new MatchEntity({}).popular).toBe('0');
    });

    it('replaces a non-array sources value with an empty array', () => {
      expect(new MatchEntity({ sources: { id: 'x' } }).sources).toEqual([]);
      expect(new MatchEntity({ sources: [{ id: 'x' }] }).sources).toEqual([{ id: 'x' }]);
    });
  });

  describe('defaults required by the catalog mapper', () => {
    it('always yields a title and a category', () => {
      const m = new MatchEntity({});
      expect(m.title).toBe('Unknown Match');
      expect(m.category).toBe('other');
    });
  });
});
