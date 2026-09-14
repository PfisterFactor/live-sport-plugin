const { describe, it, expect, afterEach, setSystemTime } = require('bun:test');
const CacheService = require('../../../src/services/CacheService');

const T0 = new Date('2026-01-01T00:00:00Z');

afterEach(() => setSystemTime());

describe('CacheService', () => {
  it('is stale before anything has ever been cached', () => {
    expect(new CacheService().isStale()).toBe(true);
  });

  it('becomes stale exactly after the TTL elapses', () => {
    setSystemTime(T0);
    const c = new CacheService();
    c.setMatches([{ id: 'a' }]);

    setSystemTime(new Date(T0.getTime() + 5 * 60 * 1000));
    expect(c.isStale()).toBe(false);

    setSystemTime(new Date(T0.getTime() + 5 * 60 * 1000 + 1));
    expect(c.isStale()).toBe(true);
  });

  it('honours a caller-supplied TTL over the default', () => {
    setSystemTime(T0);
    const c = new CacheService();
    c.setMatches([]);
    setSystemTime(new Date(T0.getTime() + 61 * 1000));
    expect(c.isStale(60 * 1000)).toBe(true);
    expect(c.isStale(10 * 60 * 1000)).toBe(false);
  });

  it('overwriting the matches resets the staleness clock', () => {
    setSystemTime(T0);
    const c = new CacheService();
    c.setMatches([{ id: 'a' }]);
    setSystemTime(new Date(T0.getTime() + 4 * 60 * 1000));
    c.setMatches([{ id: 'b' }]);
    setSystemTime(new Date(T0.getTime() + 8 * 60 * 1000));
    expect(c.isStale()).toBe(false);
    expect(c.getMatches().map((m) => m.id)).toEqual(['b']);
  });

  it('returns copies so callers cannot mutate the cached matches or their sources', () => {
    const c = new CacheService();
    const input = [{ id: 'a', sources: [{ id: 's1' }] }];
    c.setMatches(input);

    input[0].id = 'mutated';
    input[0].sources.push({ id: 's2' });

    const first = c.getMatches();
    first[0].title = 'x';
    first[0].sources.push({ id: 's3' });

    const second = c.getMatches();
    expect(second[0].id).toBe('a');
    expect(second[0].title).toBeUndefined();
    expect(second[0].sources).toHaveLength(1);
  });

  it('treats a null/undefined set as an empty catalog rather than throwing', () => {
    const c = new CacheService();
    c.setMatches([{ id: 'a' }]);
    c.setMatches(null);
    expect(c.getMatches()).toEqual([]);
  });

  it('tolerates matches without a sources array', () => {
    const c = new CacheService();
    c.setMatches([{ id: 'a' }]);
    expect(c.getMatches()[0].sources).toEqual([]);
  });
});
