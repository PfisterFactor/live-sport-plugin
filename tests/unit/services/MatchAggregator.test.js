const { describe, it, expect, beforeEach, afterEach, spyOn, setSystemTime } = require('bun:test');
const MatchAggregator = require('../../../src/services/MatchAggregator');
const CacheService = require('../../../src/services/CacheService');

const NOW = new Date('2026-03-01T12:00:00Z');
const H = 3600 * 1000;

let spies;
beforeEach(() => {
  setSystemTime(NOW);
  spies = [spyOn(console, 'log'), spyOn(console, 'error')].map((s) => s.mockImplementation(() => {}));
});
afterEach(() => {
  spies.forEach((s) => s.mockRestore());
  setSystemTime();
  delete process.env.LOW_MEMORY_MODE;
});

const provider = (matches) => ({ getMatches: async () => matches });
const thrower = (msg = 'upstream down') => ({ getMatches: async () => { throw new Error(msg); } });

function build(providers, cacheService = new CacheService()) {
  const names = ['streamFreeProvider', 'timStreamsProvider', 'sportyHunterProvider', 'watchFootyProvider',
    'cdnLiveProvider', 'streamSports99Provider', 'streamicProvider', 'streamedPkProvider'];
  const deps = { cacheService };
  providers.forEach((p, i) => { deps[names[i]] = p; });
  return new MatchAggregator(deps);
}

const match = (o) => ({ id: o.id || 'x', title: o.title, sources: [], ...o });

describe('MatchAggregator.isSameEvent', () => {
  const agg = build([]);
  const same = (a, b) => agg.isSameEvent({ id: '1', title: a }, { id: '2', title: b });

  it('merges the same fixture written with different separators and noise words', () => {
    expect(same('Real Madrid vs Barcelona', 'Real Madrid - FC Barcelona')).toBe(true);
    expect(same('Real Madrid vs. Barcelona', 'Real Madrid @ Barcelona')).toBe(true);
    expect(same('Real Madrid v Barcelona', 'Real Madrid – Barcelona (LIVE HD)')).toBe(true);
  });

  it('merges a reversed home/away ordering', () => {
    expect(same('Barcelona vs Real Madrid', 'Real Madrid vs Barcelona')).toBe(true);
  });

  it('merges known club aliases and abbreviations', () => {
    expect(same('Man Utd vs Arsenal', 'Manchester United vs Arsenal')).toBe(true);
    expect(same('Man United vs Arsenal', 'Manchester United vs Arsenal')).toBe(true);
    expect(same('Spurs vs Wolves', 'Tottenham Hotspur vs Wolverhampton Wanderers')).toBe(true);
    expect(same('PSG vs Bayern Munich', 'Paris Saint Germain vs Bayern München')).toBe(true);
  });

  it('normalizes accented team names to their unaccented spelling', () => {
    expect(same('Atlético Madrid vs Sevilla', 'Atletico Madrid vs Sevilla')).toBe(true);
    expect(same('Bayern München vs Köln', 'Bayern Munchen vs Koln')).toBe(true);
  });

  it('never merges different clubs that share a city word', () => {
    expect(same('Inter Milan vs Roma', 'AC Milan vs Roma')).toBe(false);
    expect(same('Inter Miami vs Orlando', 'Inter Milan vs Orlando')).toBe(false);
    expect(same('Manchester United vs Arsenal', 'Manchester City vs Arsenal')).toBe(false);
  });

  it('never merges different channels that share branding, and keeps numbered siblings apart', () => {
    expect(same('Sky Sports F1', 'Sky Sports Main Event')).toBe(false);
    expect(same('beIN Sports 1', 'beIN Sports 2')).toBe(false);
    expect(same('US Open Court 13', 'US Open Court 7')).toBe(false);
    expect(same('Sky Sports F1', 'Sky Sports F1')).toBe(true);
  });

  it('folds a single-team listing into the full fixture it belongs to', () => {
    expect(same('Real Madrid vs Barcelona', 'Real Madrid Live')).toBe(true);
    expect(same('Real Madrid vs Barcelona', 'Sevilla Live')).toBe(false);
  });

  it('refuses to merge across different categories', () => {
    expect(agg.isSameEvent(
      { id: '1', title: 'Arsenal vs Chelsea', category: 'football' },
      { id: '2', title: 'Arsenal vs Chelsea', category: 'basketball' }
    )).toBe(false);
    expect(agg.isSameEvent(
      { id: '1', title: 'Arsenal vs Chelsea', category: 'football' },
      { id: '2', title: 'Arsenal vs Chelsea', category: 'other' }
    )).toBe(true);
  });

  it('refuses to merge events more than a day apart', () => {
    const t = NOW.getTime();
    expect(agg.isSameEvent(
      { id: '1', title: 'Arsenal vs Chelsea', date: t },
      { id: '2', title: 'Arsenal vs Chelsea', date: t + 25 * H }
    )).toBe(false);
    expect(agg.isSameEvent(
      { id: '1', title: 'Arsenal vs Chelsea', date: t },
      { id: '2', title: 'Arsenal vs Chelsea', date: t + 2 * H }
    )).toBe(true);
  });

  it('always merges on an identical provider id', () => {
    expect(agg.isSameEvent(
      { id: 'abc', title: 'Something Entirely Different' },
      { id: 'abc', title: 'Arsenal vs Chelsea' }
    )).toBe(true);
  });
});

describe('MatchAggregator.syncMatches', () => {
  it('merges the same fixture across providers and unions their sources in provider order', async () => {
    const agg = build([
      provider([match({ id: 'a1', title: 'Real Madrid vs Barcelona', sources: [{ id: 's1', source: 'alpha' }] })]),
      provider([match({ id: 'b1', title: 'FC Barcelona vs Real Madrid', sources: [{ id: 's2', source: 'beta' }] })])
    ]);
    const out = await agg.syncMatches();
    expect(out).toHaveLength(1);
    expect(out[0].sources.map((s) => s.source)).toEqual(['alpha', 'beta']);
  });

  it('deduplicates identical sources contributed by two providers', async () => {
    const agg = build([
      provider([match({ id: 'a1', title: 'Arsenal vs Chelsea', sources: [{ id: 's1', source: 'alpha' }] })]),
      provider([match({ id: 'b1', title: 'Arsenal vs Chelsea', sources: [{ id: 's1', source: 'alpha' }, { id: 's1', source: 'beta' }] })])
    ]);
    const out = await agg.syncMatches();
    expect(out[0].sources).toHaveLength(2);
  });

  it('merges sources into a match that arrived without a sources array', async () => {
    const first = { id: 'a1', title: 'Arsenal vs Chelsea' };
    const agg = build([
      provider([first]),
      provider([match({ id: 'b1', title: 'Arsenal vs Chelsea', sources: [{ id: 's2', source: 'beta' }] })])
    ]);
    const out = await agg.syncMatches();
    expect(out).toHaveLength(1);
    expect(out[0].sources.map((s) => s.source)).toEqual(['beta']);
  });

  it('keeps distinct events separate', async () => {
    const agg = build([
      provider([match({ id: 'a1', title: 'Arsenal vs Chelsea' }), match({ id: 'a2', title: 'Inter Milan vs Roma' })]),
      provider([match({ id: 'b1', title: 'AC Milan vs Roma' })])
    ]);
    expect(await agg.syncMatches()).toHaveLength(3);
  });

  it('fills missing artwork and metadata from the later provider without overwriting existing values', async () => {
    const agg = build([
      provider([match({ id: 'a1', title: 'Arsenal vs Chelsea', poster: 'p1', team1: { name: 'Arsenal' } })]),
      provider([match({
        id: 'b1', title: 'Arsenal vs Chelsea', poster: 'p2', logo: 'l2', league: 'EPL',
        team1: { name: 'Arsenal', logo: 'tl' }, team2: { name: 'Chelsea' }
      })])
    ]);
    const [m] = await agg.syncMatches();
    expect(m.poster).toBe('p1');
    expect(m.logo).toBe('l2');
    expect(m.league).toBe('EPL');
    expect(m.team1.logo).toBe('tl');
    expect(m.team2.name).toBe('Chelsea');
  });

  it('adopts the fixture title when a channel-style listing was seen first', async () => {
    const agg = build([
      provider([match({ id: 'a1', title: 'Real Madrid Live' })]),
      provider([match({ id: 'b1', title: 'Real Madrid vs Barcelona' })]),
      provider([match({ id: 'c1', title: 'Real Madrid - FC Barcelona' })])
    ]);
    const out = await agg.syncMatches();
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('Real Madrid vs Barcelona');
  });

  it('keeps the results of healthy providers when one throws', async () => {
    const agg = build([
      thrower(),
      provider([match({ id: 'b1', title: 'Arsenal vs Chelsea' })]),
      thrower('also down')
    ]);
    const out = await agg.syncMatches();
    expect(out.map((m) => m.id)).toEqual(['b1']);
  });

  it('returns null and leaves the cache untouched when every provider is empty or failing', async () => {
    const cache = new CacheService();
    cache.setMatches([match({ id: 'old', title: 'Old vs Cache' })]);
    const agg = build([thrower(), provider([]), provider(null)], cache);

    expect(await agg.syncMatches()).toBeNull();
    expect(cache.getMatches().map((m) => m.id)).toEqual(['old']);
  });

  it('publishes the merged catalog to the cache on a successful sync', async () => {
    const cache = new CacheService();
    const agg = build([provider([match({ id: 'a1', title: 'Arsenal vs Chelsea' })])], cache);
    const out = await agg.syncMatches();
    expect(cache.getMatches().map((m) => m.id)).toEqual(out.map((m) => m.id));
    expect(cache.isStale()).toBe(false);
  });

  it('drops matches whose id or title is missing', async () => {
    const agg = build([provider([
      match({ id: 'a1', title: 'Arsenal vs Chelsea' }),
      { id: 'a2', sources: [] },
      { title: 'No Id Here', sources: [] }
    ])]);
    expect((await agg.syncMatches()).map((m) => m.id)).toEqual(['a1']);
  });

  it('expires matches more than 24h past kickoff, and TimStreams VODs after 48h', async () => {
    const t = NOW.getTime();
    const agg = build([provider([
      match({ id: 'fresh', title: 'A vs B', date: t - 2 * H }),
      match({ id: 'stale', title: 'C vs D', date: t - 25 * H }),
      match({ id: 'vod', title: 'E vs F', date: t - 30 * H, sources: [{ id: 's', source: 'timstreams' }] }),
      match({ id: 'oldvod', title: 'G vs H', date: t - 50 * H, sources: [{ id: 's', source: 'timstreams' }] }),
      match({ id: 'undated', title: 'I vs J' })
    ])]);
    const ids = (await agg.syncMatches()).map((m) => m.id).sort();
    expect(ids).toEqual(['fresh', 'undated', 'vod']);
  });

  it('accepts ISO string kickoff times when deciding what is still active', async () => {
    const agg = build([provider([
      match({ id: 'fresh', title: 'A vs B', date: new Date(NOW.getTime() - H).toISOString() }),
      match({ id: 'stale', title: 'C vs D', date: new Date(NOW.getTime() - 30 * H).toISOString() })
    ])]);
    expect((await agg.syncMatches()).map((m) => m.id)).toEqual(['fresh']);
  });

  it('flags trending matches as popular only inside the live window', async () => {
    const t = NOW.getTime();
    const agg = build([provider([
      match({ id: 'soon', title: 'Real Madrid vs Sevilla', date: t + 2 * H }),
      match({ id: 'later', title: 'Barcelona vs Sevilla', date: t + 20 * H }),
      match({ id: 'plain', title: 'Luton vs Burnley', date: t })
    ])]);
    const out = await agg.syncMatches();
    const by = Object.fromEntries(out.map((m) => [m.id, m.popular]));
    expect(by.soon).toBe('1');
    expect(by.later).toBeUndefined();
    expect(by.plain).toBeUndefined();
  });

  it('strips a provider-supplied popular flag from events that are still far away', async () => {
    const t = NOW.getTime();
    const agg = build([provider([
      match({ id: 'far', title: 'Luton vs Burnley', date: t + 20 * H, popular: '1' }),
      match({ id: 'near', title: 'Luton vs Brentford', date: t + 1 * H, popular: '1' })
    ])]);
    const out = await agg.syncMatches();
    expect(out.find((m) => m.id === 'far').popular).toBe('0');
    expect(out.find((m) => m.id === 'near').popular).toBe('1');
  });

  it('propagates a popular flag onto the merged event', async () => {
    const agg = build([
      provider([match({ id: 'a1', title: 'Luton vs Burnley' })]),
      provider([match({ id: 'b1', title: 'Luton vs Burnley', popular: '1' })])
    ]);
    expect((await agg.syncMatches())[0].popular).toBe('1');
  });

  it('aggregates the same way in LOW_MEMORY_MODE, including around a failing provider', async () => {
    process.env.LOW_MEMORY_MODE = 'true';
    const agg = build([
      thrower(),
      provider([match({ id: 'a1', title: 'Real Madrid vs Barcelona', sources: [{ id: 's1', source: 'alpha' }] })]),
      provider([match({ id: 'b1', title: 'Barcelona vs Real Madrid', sources: [{ id: 's2', source: 'beta' }] })])
    ]);
    const out = await agg.syncMatches();
    expect(out).toHaveLength(1);
    expect(out[0].sources.map((s) => s.source)).toEqual(['alpha', 'beta']);
  });
});
