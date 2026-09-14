const { describe, it, expect, beforeEach, afterEach, spyOn, afterAll, mock } = require('bun:test');

let pings = [];
let pingImpl = async () => ({ statusCode: 200 });

spyOn(require('undici'), 'request').mockImplementation(async (url, opts) => { pings.push(url); return pingImpl(url, opts); });

const CronService = require('../../../src/services/CronService');

let intervals;
let timeouts;
let spies;

function makeDeps(overrides = {}) {
  return {
    matchAggregator: { syncMatches: async () => [{ id: 'm1' }], ...(overrides.matchAggregator || {}) },
    streamResolveCache: { pruned: [], pruneEnded(ids) { this.pruned.push(ids); }, ...(overrides.streamResolveCache || {}) },
    cacheService: { stale: false, isStale() { return this.stale; }, ...(overrides.cacheService || {}) }
  };
}

beforeEach(() => {
  intervals = [];
  timeouts = [];
  pings = [];
  pingImpl = async () => ({ statusCode: 200 });
  delete process.env.RENDER_EXTERNAL_URL;
  spies = [
    spyOn(globalThis, 'setInterval').mockImplementation((fn, ms) => {
      intervals.push({ fn, ms });
      return { unref() { return this; } };
    }),
    spyOn(globalThis, 'setTimeout').mockImplementation((fn, ms) => {
      timeouts.push({ fn, ms });
      return { unref() { return this; } };
    }),
    spyOn(console, 'log').mockImplementation(() => {}),
    spyOn(console, 'error').mockImplementation(() => {})
  ];
});

afterEach(() => {
  spies.forEach((s) => s.mockRestore());
  delete process.env.RENDER_EXTERNAL_URL;
});

describe('CronService.start', () => {
  it('schedules only the match-sync interval when no external URL is configured', () => {
    new CronService(makeDeps()).start();
    expect(intervals).toHaveLength(1);
    expect(intervals[0].ms).toBe(4 * 60 * 60 * 1000);
  });

  it('adds a keep-alive interval that pings /health when RENDER_EXTERNAL_URL is set', async () => {
    process.env.RENDER_EXTERNAL_URL = 'https://addon.example';
    new CronService(makeDeps()).start();

    expect(intervals).toHaveLength(2);
    const keepAlive = intervals[1];
    expect(keepAlive.ms).toBe(14 * 60 * 1000);

    await keepAlive.fn();
    expect(pings).toEqual(['https://addon.example/health']);
  });

  it('swallows a failed keep-alive ping', async () => {
    process.env.RENDER_EXTERNAL_URL = 'https://addon.example';
    pingImpl = async () => { throw new Error('ECONNRESET'); };
    new CronService(makeDeps()).start();
    expect(await intervals[1].fn()).toBeUndefined();
  });

  it('runs an initial sync shortly after boot', async () => {
    const deps = makeDeps();
    new CronService(deps).start();
    expect(timeouts).toHaveLength(1);
    await timeouts[0].fn();
    expect(deps.streamResolveCache.pruned).toHaveLength(1);
  });

  it('does not let a failing sync escape the scheduled job', async () => {
    const deps = makeDeps({ matchAggregator: { syncMatches: async () => { throw new Error('all providers down'); } } });
    const cron = new CronService(deps);
    cron.start();
    expect(await intervals[0].fn()).toBeUndefined();
    expect(await timeouts[0].fn()).toBeUndefined();
  });
});

describe('CronService.runSync', () => {
  it('prunes the stream cache with the ids of the matches that are still active', async () => {
    const deps = makeDeps({ matchAggregator: { syncMatches: async () => [{ id: 'm1' }, { id: 'm2' }, null, {}] } });
    await new CronService(deps).runSync();
    const ids = deps.streamResolveCache.pruned[0];
    expect([...ids].sort()).toEqual(['m1', 'm2']);
  });

  it('does not prune when the sync reports a total provider outage', async () => {
    const deps = makeDeps({ matchAggregator: { syncMatches: async () => null } });
    await new CronService(deps).runSync();
    expect(deps.streamResolveCache.pruned).toHaveLength(0);
  });

  it('ignores a concurrent sync request while one is already running', async () => {
    let calls = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    const deps = makeDeps({ matchAggregator: { syncMatches: async () => { calls++; await gate; return []; } } });
    const cron = new CronService(deps);

    const first = cron.runSync();
    await cron.runSync();
    expect(calls).toBe(1);
    release();
    await first;
  });

  it('releases the in-flight flag when the sync rejects, so the next sync still runs', async () => {
    let calls = 0;
    const deps = makeDeps({
      matchAggregator: { syncMatches: async () => { calls++; if (calls === 1) throw new Error('boom'); return []; } }
    });
    const cron = new CronService(deps);
    await expect(cron.runSync()).rejects.toThrow('boom');
    expect(cron.syncing).toBe(false);
    await cron.runSync();
    expect(calls).toBe(2);
  });

  it('survives a stream cache that throws while pruning', async () => {
    const deps = makeDeps({ streamResolveCache: { pruneEnded() { throw new Error('bad cache'); } } });
    expect(await new CronService(deps).runSync()).toBeUndefined();
  });
});

describe('CronService.ensureFresh', () => {
  it('does nothing while the catalog cache is still fresh', () => {
    let calls = 0;
    const deps = makeDeps({ matchAggregator: { syncMatches: async () => { calls++; return []; } } });
    new CronService(deps).ensureFresh();
    expect(calls).toBe(0);
  });

  it('triggers a background re-sync once the cache passes the revalidate window', async () => {
    let calls = 0;
    let seenTtl = null;
    const deps = makeDeps({
      matchAggregator: { syncMatches: async () => { calls++; return []; } },
      cacheService: { isStale(ttl) { seenTtl = ttl; return true; } }
    });
    const cron = new CronService(deps);
    cron.ensureFresh();
    expect(seenTtl).toBe(10 * 60 * 1000);
    expect(calls).toBe(1);
    expect(cron.syncing).toBe(true);
    await Promise.resolve();
  });

  it('does not stack a second re-sync while one is in flight', async () => {
    let calls = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    const deps = makeDeps({
      matchAggregator: { syncMatches: async () => { calls++; await gate; return []; } },
      cacheService: { isStale: () => true }
    });
    const cron = new CronService(deps);
    cron.ensureFresh();
    cron.ensureFresh();
    expect(calls).toBe(1);
    release();
    await new Promise((r) => process.nextTick(r));
  });

  it('swallows a rejected background sync instead of surfacing an unhandled rejection', async () => {
    const deps = makeDeps({
      matchAggregator: { syncMatches: async () => { throw new Error('boom'); } },
      cacheService: { isStale: () => true }
    });
    const cron = new CronService(deps);
    expect(() => cron.ensureFresh()).not.toThrow();
    await new Promise((r) => process.nextTick(r));
    expect(cron.syncing).toBe(false);
  });

  it('is a no-op when no catalog cache is wired up', () => {
    const cron = new CronService({ matchAggregator: {}, streamResolveCache: null, cacheService: null });
    expect(() => cron.ensureFresh()).not.toThrow();
  });
});

afterAll(() => mock.restore());
