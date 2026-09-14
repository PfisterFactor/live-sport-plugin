const { describe, it, expect, afterEach, setSystemTime } = require('bun:test');
const StreamResolveCache = require('../../../src/services/StreamResolveCache');

const T0 = new Date('2026-01-01T00:00:00Z');
const at = (ms) => setSystemTime(new Date(T0.getTime() + ms));

afterEach(() => setSystemTime());

const streams = (n = 1) => Array.from({ length: n }, (_, i) => ({ url: `http://s/${i}.m3u8` }));

describe('StreamResolveCache', () => {
  it('serves a positive entry until its TTL expires, then re-mints', async () => {
    at(0);
    const c = new StreamResolveCache({ defaultTtlMs: 1000 });
    let calls = 0;
    const mint = async () => { calls++; return streams(); };

    expect(await c.getOrCreate('alpha:m1', mint)).toHaveLength(1);
    at(999);
    await c.getOrCreate('alpha:m1', mint);
    expect(calls).toBe(1);

    at(1001);
    await c.getOrCreate('alpha:m1', mint);
    expect(calls).toBe(2);
  });

  it('negative-caches a failed mint for the negative TTL, not the positive TTL', async () => {
    at(0);
    const c = new StreamResolveCache({ defaultTtlMs: 600000, negativeTtlMs: 1000 });
    let calls = 0;
    const mint = async () => { calls++; throw new Error('upstream down'); };

    expect(await c.getOrCreate('alpha:m1', mint)).toEqual([]);
    at(500);
    expect(await c.getOrCreate('alpha:m1', mint)).toEqual([]);
    expect(calls).toBe(1);

    at(1500);
    await c.getOrCreate('alpha:m1', mint);
    expect(calls).toBe(2);
  });

  it('negative-caches an empty (non-throwing) result too', async () => {
    at(0);
    const c = new StreamResolveCache({ negativeTtlMs: 1000 });
    let calls = 0;
    const mint = async () => { calls++; return []; };
    await c.getOrCreate('alpha:m1', mint);
    await c.getOrCreate('alpha:m1', mint);
    expect(calls).toBe(1);
    expect(c.stats().negativeHits).toBe(1);
  });

  it('a failure does not poison the key once the negative window passes', async () => {
    at(0);
    const c = new StreamResolveCache({ negativeTtlMs: 100 });
    await c.getOrCreate('alpha:m1', async () => { throw new Error('boom'); });
    at(200);
    const out = await c.getOrCreate('alpha:m1', async () => streams(2));
    expect(out).toHaveLength(2);
  });

  it('coalesces concurrent resolves of the same key into one mint', async () => {
    let calls = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    const c = new StreamResolveCache();
    const mint = async () => { calls++; await gate; return streams(1); };

    const a = c.getOrCreate('alpha:m1', mint);
    const b = c.getOrCreate('alpha:m1', mint);
    const d = c.getOrCreate('alpha:m1', mint);
    release();
    const [ra, rb, rd] = await Promise.all([a, b, d]);

    expect(calls).toBe(1);
    expect(ra).toHaveLength(1);
    expect(rb).toEqual(ra);
    expect(rd).toEqual(ra);
    expect(c.stats().inFlight).toBe(0);
  });

  it('a coalesced rejection resolves all waiters to [] without unhandled rejection', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const c = new StreamResolveCache();
    const mint = async () => { await gate; throw new Error('nope'); };

    const a = c.getOrCreate('alpha:m1', mint);
    const b = c.getOrCreate('alpha:m1', mint);
    release();
    expect(await a).toEqual([]);
    expect(await b).toEqual([]);
  });

  it('different keys are minted independently', async () => {
    const c = new StreamResolveCache();
    const seen = [];
    await Promise.all([
      c.getOrCreate('alpha:m1', async () => { seen.push('a'); return streams(); }),
      c.getOrCreate('beta:m1', async () => { seen.push('b'); return streams(); })
    ]);
    expect(seen.sort()).toEqual(['a', 'b']);
  });

  it('hands out clones so caller mutations never touch the cached entry', async () => {
    const c = new StreamResolveCache();
    const original = [{ url: 'u', label: 'orig' }];
    const first = await c.getOrCreate('alpha:m1', async () => original);
    first[0].label = 'mutated';
    original[0].label = 'also-mutated';
    const second = await c.getOrCreate('alpha:m1', async () => streams());
    expect(second[0].label).toBe('orig');
  });

  it('get() returns null for a miss, an expired entry and a negative entry', async () => {
    at(0);
    const c = new StreamResolveCache({ defaultTtlMs: 100, negativeTtlMs: 100 });
    expect(c.get('alpha:m1')).toBeNull();

    await c.getOrCreate('alpha:m1', async () => streams());
    expect(c.get('alpha:m1')).toHaveLength(1);
    at(200);
    expect(c.get('alpha:m1')).toBeNull();

    await c.getOrCreate('beta:m1', async () => []);
    expect(c.get('beta:m1')).toBeNull();
  });

  it('noteSuccess doubles the learned TTL up to the cap and extends the live entry', async () => {
    at(0);
    const c = new StreamResolveCache({ defaultTtlMs: 1000, maxTtlMs: 3000 });
    await c.getOrCreate('alpha:m1', async () => streams());

    c.noteSuccess('alpha:m1');
    expect(c.stats().learnedTtls.alpha).toBe(2000);
    c.noteSuccess('alpha:m1');
    expect(c.stats().learnedTtls.alpha).toBe(3000);
    c.noteSuccess('alpha:m1');
    expect(c.stats().learnedTtls.alpha).toBe(3000);

    at(2500);
    expect(c.get('alpha:m1')).toHaveLength(1);
  });

  it('noteFailure halves the learned TTL down to the floor and evicts the entry', async () => {
    at(0);
    const c = new StreamResolveCache({ defaultTtlMs: 4000, minTtlMs: 2000 });
    await c.getOrCreate('alpha:m1', async () => streams());

    c.noteFailure('alpha:m1');
    expect(c.get('alpha:m1')).toBeNull();
    expect(c.stats().learnedTtls.alpha).toBe(2000);
    c.noteFailure('alpha:m1');
    expect(c.stats().learnedTtls.alpha).toBe(2000);
  });

  it('a learned TTL from noteSuccess applies to the next mint of the same source', async () => {
    at(0);
    const c = new StreamResolveCache({ defaultTtlMs: 1000, maxTtlMs: 100000 });
    await c.getOrCreate('alpha:m1', async () => streams());
    c.noteSuccess('alpha:m1');

    let calls = 0;
    await c.getOrCreate('alpha:m2', async () => { calls++; return streams(); });
    at(1500);
    await c.getOrCreate('alpha:m2', async () => { calls++; return streams(); });
    expect(calls).toBe(1);
  });

  it('pruneEnded drops entries for inactive matches but keeps evergreen channel keys', async () => {
    const c = new StreamResolveCache();
    await c.getOrCreate('alpha:m1', async () => streams());
    await c.getOrCreate('alpha:m2', async () => streams());
    await c.getOrCreate('alpha:__channel__', async () => streams());

    c.pruneEnded(new Set(['m1']));
    expect(c.get('alpha:m1')).toHaveLength(1);
    expect(c.get('alpha:m2')).toBeNull();
    expect(c.get('alpha:__channel__')).toHaveLength(1);
  });

  it('pruneEnded accepts a plain array of active ids', async () => {
    const c = new StreamResolveCache();
    await c.getOrCreate('alpha:m1', async () => streams());
    await c.getOrCreate('alpha:m2', async () => streams());
    c.pruneEnded(['m2']);
    expect(c.get('alpha:m1')).toBeNull();
    expect(c.get('alpha:m2')).toHaveLength(1);
  });

  it('evicts the least recently accessed entry when the cap is exceeded', async () => {
    at(0);
    const c = new StreamResolveCache({ maxEntries: 2, defaultTtlMs: 100000 });
    await c.getOrCreate('alpha:m1', async () => streams());
    at(10);
    await c.getOrCreate('alpha:m2', async () => streams());

    at(20);
    expect(c.get('alpha:m1')).toHaveLength(1); // refresh m1's access time

    at(30);
    await c.getOrCreate('alpha:m3', async () => streams());

    expect(c.get('alpha:m2')).toBeNull();
    expect(c.get('alpha:m1')).toHaveLength(1);
    expect(c.get('alpha:m3')).toHaveLength(1);
    expect(c.stats().evictions).toBe(1);
  });

  it('counts hits and misses separately', async () => {
    const c = new StreamResolveCache();
    await c.getOrCreate('alpha:m1', async () => streams());
    await c.getOrCreate('alpha:m1', async () => streams());
    const s = c.stats();
    expect(s.misses).toBe(1);
    expect(s.hits).toBe(1);
    expect(s.entries).toBe(1);
  });
});
