const { describe, it, expect, beforeEach, afterEach, spyOn, setSystemTime } = require('bun:test');
const MatchAggregator = require('../../../src/services/MatchAggregator');
const CacheService = require('../../../src/services/CacheService');

const NOW = new Date('2026-09-15T12:00:00Z');
const H = 3600 * 1000;
const DAY = 24 * H;

let spies;
beforeEach(() => {
  setSystemTime(NOW);
  spies = [spyOn(console, 'log'), spyOn(console, 'error'), spyOn(console, 'warn')].map((s) => s.mockImplementation(() => {}));
});
afterEach(() => {
  spies.forEach((s) => s.mockRestore());
  setSystemTime();
});

const provider = (matches, extra = {}) => ({ getMatches: async () => matches, ...extra });
const src = (source, id = 's') => ({ source, id, url: `https://x/${id}` });
const match = (o) => ({ id: o.id, title: o.title, category: 'football', date: String(NOW.getTime() + 2 * H), sources: [src('a', o.id)], ...o });

describe('same-event merging fixes', () => {
  const agg = new MatchAggregator({});
  const same = (a, b) => agg.isSameEvent(a, b);

  it('merges F1 race titles that differ in spelling and calendar year', () => {
    const t = String(NOW.getTime() + DAY);
    expect(same(
      { id: '1', title: 'Formula 1 Azerbaijan GP', category: 'motorsport', date: t },
      { id: '2', title: 'Azerbaijan Grand Prix 2026', category: 'motorsport', date: t }
    )).toBe(true);
    expect(same(
      { id: '1', title: 'F1 Azerbaijan GP', category: 'motorsport', date: t },
      { id: '2', title: 'Formula 1 Azerbaijan Grand Prix', category: 'motorsport', date: t }
    )).toBe(true);
  });

  it('keeps different Grand Prix venues apart', () => {
    const t = String(NOW.getTime() + DAY);
    expect(same(
      { id: '1', title: 'Monaco Grand Prix', category: 'motorsport', date: t },
      { id: '2', title: 'Azerbaijan Grand Prix', category: 'motorsport', date: t }
    )).toBe(false);
  });

  it('treats league slugs and the parent sport as one category', () => {
    const t = String(NOW.getTime() + DAY);
    expect(same(
      { id: '1', title: 'Perth Wildcats vs Sydney Kings', category: 'nbl', date: t },
      { id: '2', title: 'Perth Wildcats vs Sydney Kings', category: 'basketball', date: t }
    )).toBe(true);
  });

  it('folds "ice hockey" into hockey', () => {
    const t = String(NOW.getTime() + DAY);
    expect(same(
      { id: '1', title: 'Boston Bruins vs Toronto Maple Leafs', category: 'ice hockey', date: t },
      { id: '2', title: 'Boston Bruins vs Toronto Maple Leafs', category: 'hockey', date: t }
    )).toBe(true);
  });

  it('lets a college fixture merge with the same game filed under american football', () => {
    const t = String(NOW.getTime() + DAY);
    expect(same(
      { id: '1', title: 'Ohio State vs Michigan', category: 'college', date: t },
      { id: '2', title: 'Ohio State vs Michigan', category: 'american_football', date: t }
    )).toBe(true);
  });

  it('does not merge the same fixture on different days when a date is an ISO string', () => {
    expect(same(
      { id: '1', title: 'Chicago Cubs @ Atlanta Braves', category: 'baseball', date: '2026-05-10' },
      { id: '2', title: 'Chicago Cubs vs Atlanta Braves', category: 'baseball', date: String(Date.parse('2026-09-14T23:00:00Z')) }
    )).toBe(false);
  });
});

describe('syncMatches merge bookkeeping', () => {
  it('records alias ids, carries the score and prefers the college category', async () => {
    const cache = new CacheService();
    const agg = new MatchAggregator({
      streamFreeProvider: provider([match({ id: 'a1', title: 'Ohio State vs Michigan', category: 'american_football' })]),
      timStreamsProvider: provider([match({ id: 'b1', title: 'Ohio State vs Michigan', category: 'college', score: '7:3', aliasIds: ['b0'] })]),
      cacheService: cache
    });
    const [m] = await agg.syncMatches();
    expect(m.aliasIds).toEqual(['b1', 'b0']);
    expect(m.score).toBe('7:3');
    expect(m.category).toBe('college');
    expect(cache.findMatch('b0').id).toBe('a1');
  });

  it('adopts the incoming kickoff when the first provider had none', async () => {
    const t = NOW.getTime() + 2 * H;
    const agg = new MatchAggregator({
      streamFreeProvider: provider([match({ id: 'a1', title: 'Arsenal vs Chelsea', date: '' })]),
      timStreamsProvider: provider([match({ id: 'b1', title: 'Arsenal vs Chelsea', date: String(t) })]),
      cacheService: new CacheService()
    });
    const [m] = await agg.syncMatches();
    expect(m.date).toBe(String(t));
  });

  it("prefers StreamedPk's precise kickoff over a coarse one", async () => {
    const coarse = NOW.getTime() + 2 * H;
    const precise = coarse + 20 * 60 * 1000;
    const agg = new MatchAggregator({
      streamFreeProvider: provider([match({ id: 'a1', title: 'Arsenal vs Chelsea', date: String(coarse) })]),
      streamedPkProvider: provider([match({ id: 'b1', title: 'Arsenal vs Chelsea', date: String(precise), sources: [src('streamedpk', 'b1')] })]),
      cacheService: new CacheService()
    });
    const [m] = await agg.syncMatches();
    expect(m.date).toBe(String(precise));
  });

  it('backfills competitors from a head-to-head title', async () => {
    const agg = new MatchAggregator({
      streamFreeProvider: provider([match({ id: 'a1', title: 'WTA - Singles: Iga Swiatek vs Coco Gauff', category: 'tennis' })]),
      cacheService: new CacheService()
    });
    const [m] = await agg.syncMatches();
    expect(m.team1).toEqual({ name: 'Iga Swiatek' });
    expect(m.team2).toEqual({ name: 'Coco Gauff' });
  });
});

describe('syncMatches retention', () => {
  it('keeps replay-provider sessions for 21 days and other fixtures for 24 hours', async () => {
    const agg = new MatchAggregator({
      liveTvProvider: provider([
        match({ id: 'r20', title: 'A vs B - Replay', date: String(NOW.getTime() - 20 * DAY), sources: [src('livetv', 'r20')] }),
        match({ id: 'r22', title: 'C vs D - Replay', date: String(NOW.getTime() - 22 * DAY), sources: [src('livetv', 'r22')] })
      ]),
      streamFreeProvider: provider([
        match({ id: 'fresh', title: 'E vs F', date: String(NOW.getTime() - 23 * H) }),
        match({ id: 'stale', title: 'G vs H', date: String(NOW.getTime() - 25 * H) })
      ]),
      cacheService: new CacheService()
    });
    const out = await agg.syncMatches();
    expect(out.map(m => m.id).sort()).toEqual(['fresh', 'r20']);
  });

  it('reuses cached replays for 12 hours instead of re-scraping the replay providers', async () => {
    const cache = new CacheService();
    let scrapes = 0;
    const liveTv = {
      sourceName: 'livetv',
      getMatches: async () => {
        scrapes += 1;
        return [match({ id: 'r1', title: 'A vs B - Replay', date: String(NOW.getTime() - DAY), sources: [src('livetv', 'r1')] })];
      }
    };
    const agg = new MatchAggregator({ liveTvProvider: liveTv, streamFreeProvider: provider([match({ id: 'x', title: 'E vs F' })]), cacheService: cache });

    await agg.syncMatches();
    expect(scrapes).toBe(1);

    setSystemTime(new Date(NOW.getTime() + 11 * H));
    const second = await agg.syncMatches();
    expect(scrapes).toBe(1);
    expect(second.some(m => m.id === 'r1')).toBe(true);

    setSystemTime(new Date(NOW.getTime() + 13 * H));
    await agg.syncMatches();
    expect(scrapes).toBe(2);
  });
});

describe('syncMatches DaddyLive carry-forward', () => {
  const dlvRow = (id, over = {}) => match({ id, title: `Team ${id} vs Other ${id}`, sources: [src('dlive', id)], ...over });

  it('re-adds the previous dlive rows when the provider returns nothing', async () => {
    const cache = new CacheService();
    cache.setMatches([dlvRow('d1'), dlvRow('d2', { date: '' })]);
    const agg = new MatchAggregator({
      streamFreeProvider: provider([match({ id: 'x', title: 'E vs F' })]),
      dliveProvider: provider([]),
      cacheService: cache
    });
    const out = await agg.syncMatches();
    expect(out.map(m => m.id).sort()).toEqual(['d1', 'd2', 'x']);
  });

  it('carries fixtures forward when the schedule broke but channels still came back', async () => {
    const cache = new CacheService();
    cache.setMatches([dlvRow('d1')]);
    const agg = new MatchAggregator({
      dliveProvider: provider([dlvRow('chan', { title: 'Sky Sports', category: 'networks', date: '' })], { sourceName: 'dlive', lastScheduleOk: false }),
      cacheService: cache
    });
    const out = await agg.syncMatches();
    expect(out.map(m => m.id).sort()).toEqual(['chan', 'd1']);
  });

  it('does not resurrect fixtures past the retention window, nor carry when dlive answered', async () => {
    const cache = new CacheService();
    cache.setMatches([dlvRow('old', { date: String(NOW.getTime() - 30 * H) })]);
    const stale = new MatchAggregator({
      streamFreeProvider: provider([match({ id: 'x', title: 'E vs F' })]),
      dliveProvider: provider([]),
      cacheService: cache
    });
    expect((await stale.syncMatches()).map(m => m.id)).toEqual(['x']);

    cache.setMatches([dlvRow('prev')]);
    const healthy = new MatchAggregator({
      dliveProvider: provider([dlvRow('new', { title: 'Brand vs New' })], { sourceName: 'dlive', lastScheduleOk: true }),
      cacheService: cache
    });
    expect((await healthy.syncMatches()).map(m => m.id)).toEqual(['new']);
  });
});

describe('syncMatches archived replays', () => {
  const archivedDate = String(NOW.getTime() - 4 * DAY);
  const replay = (id, title, over = {}) => match({ id, title, category: 'hockey', date: archivedDate, sources: [src('livetv', id)], ...over });

  it('does not fold an old replay into a 24/7 channel that shares a word', async () => {
    const agg = new MatchAggregator({
      streamedPkProvider: provider([match({ id: 'chan', title: 'Fox League', category: 'networks', date: '', sources: [src('streamedpk', 'chan')] })]),
      liveTvProvider: provider([replay('r1', 'Koelner Haie - Herning Blue Fox')]),
      cacheService: new CacheService()
    });
    const out = await agg.syncMatches();
    const chan = out.find(m => m.id === 'chan');
    expect(chan.title).toBe('Fox League');
    expect(chan.sources.map(s => s.source)).toEqual(['streamedpk']);
    expect(out.some(m => m.id === 'r1')).toBe(true);
  });

  it('still merges the same old replay listed twice on the same day', async () => {
    const agg = new MatchAggregator({
      liveTvProvider: provider([
        replay('r1', 'Koelner Haie vs Herning Blue Fox'),
        replay('r2', 'Herning Blue Fox vs Koelner Haie'),
      ]),
      cacheService: new CacheService()
    });
    const out = await agg.syncMatches();
    expect(out).toHaveLength(1);
    expect(out[0].sources.map(s => s.id).sort()).toEqual(['r1', 'r2']);
  });
});

describe('syncMatches provider budget', () => {
  it('records providers that missed their budget and keeps the ones that answered', async () => {
    const agg = new MatchAggregator({
      streamFreeProvider: provider([match({ id: 'x', title: 'E vs F' })]),
      watchFootyProvider: { name: 'WatchFooty', syncTimeoutMs: 50, getMatches: () => new Promise(() => {}) },
      cacheService: new CacheService()
    });
    const out = await agg.syncMatches();
    expect(out.map(m => m.id)).toEqual(['x']);
    expect(agg.lastSyncTimedOut).toEqual(['WatchFooty']);
  });
});
