const { describe, it, expect, beforeEach, afterEach, spyOn, afterAll, mock, setSystemTime } = require('bun:test');
const path = require('path');

const NOW = new Date('2026-08-16T18:00:00Z').getTime();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

const srcPath = (f) => path.join(__dirname, '../../../src', f);

let matches = [];
let ensureFreshCalls = 0;
let prewarmed = [];

const container = require('../../../src/container');
const streams = require('../../../src/streams');

spyOn(container, 'resolve').mockImplementation((name) => {
  if (name === 'cronService') return { ensureFresh: () => { ensureFreshCalls += 1; } };
  if (name === 'cacheService') return { getMatches: () => matches };
  throw new Error(`unexpected resolve('${name}')`);
});
spyOn(streams, 'prewarmMatch').mockImplementation(async (match) => { prewarmed.push(match); });

const { handleCatalog, handleMeta, isMatchLive } = require('../../../src/catalog');
const { manifest } = require('../../../src/manifest');

const match = (over = {}) => ({
  id: over.id || 'm1',
  title: 'Arsenal vs Chelsea',
  category: 'football',
  date: String(NOW - HOUR),
  status: '',
  popular: '0',
  sources: [],
  league: '',
  team1: null,
  team2: null,
  ...over
});

const names = (res) => res.metas.map(m => m.name);

beforeEach(() => {
  setSystemTime(new Date(NOW));
  matches = [];
  ensureFreshCalls = 0;
  prewarmed = [];
});

afterEach(() => setSystemTime());

describe('isMatchLive', () => {
  it('treats 24/7 networks and dateless entries as always live', () => {
    expect(isMatchLive(match({ category: 'networks', date: '' }))).toBe(true);
    expect(isMatchLive(match({ date: '' }))).toBe(true);
  });

  it('returns false for a missing match', () => {
    expect(isMatchLive(null)).toBe(false);
  });

  it('lets a finished/postponed status win over an in-window kickoff', () => {
    for (const status of ['finished', 'ended', 'postponed', 'cancelled']) {
      expect(isMatchLive(match({ status }))).toBe(false);
    }
  });

  it('lets an explicit live status win over a far-future kickoff', () => {
    for (const status of ['live', 'in', 'in_progress']) {
      expect(isMatchLive(match({ status, date: String(NOW + 10 * HOUR) }))).toBe(true);
    }
  });

  it('lets an explicit upcoming status win over an in-window kickoff', () => {
    expect(isMatchLive(match({ status: 'upcoming' }))).toBe(false);
    expect(isMatchLive(match({ status: 'pre' }))).toBe(false);
  });

  it('goes live exactly 15 minutes before kickoff', () => {
    expect(isMatchLive(match({ date: String(NOW + 15 * MIN) }))).toBe(true);
    expect(isMatchLive(match({ date: String(NOW + 15 * MIN + 1) }))).toBe(false);
  });

  it('expires at the sport-specific max duration', () => {
    expect(isMatchLive(match({ category: 'football', date: String(NOW - 2.5 * HOUR) }))).toBe(true);
    expect(isMatchLive(match({ category: 'football', date: String(NOW - 2.5 * HOUR - 1) }))).toBe(false);
    expect(isMatchLive(match({ category: 'cricket', date: String(NOW - 7 * HOUR) }))).toBe(true);
    expect(isMatchLive(match({ category: 'cricket', date: String(NOW - 9 * HOUR) }))).toBe(false);
  });

  it('falls back to a 3 hour window for unknown categories', () => {
    expect(isMatchLive(match({ category: 'kabaddi', date: String(NOW - 2.9 * HOUR) }))).toBe(true);
    expect(isMatchLive(match({ category: 'kabaddi', date: String(NOW - 3.1 * HOUR) }))).toBe(false);
  });
});

describe('handleCatalog routing', () => {
  it('ignores non-tv types and foreign catalog ids', async () => {
    matches = [match()];
    expect((await handleCatalog('movie', 'nuvio_sports_live', {}, {})).metas).toEqual([]);
    expect((await handleCatalog('tv', 'someone_elses_catalog', {}, {})).metas).toEqual([]);
  });

  it('kicks off a background refresh on every catalog request', async () => {
    await handleCatalog('tv', 'nuvio_sports_live', {}, {});
    expect(ensureFreshCalls).toBe(1);
  });

  it('lists only live matches in the live catalog', async () => {
    matches = [
      match({ id: 'live', title: 'Live Game' }),
      match({ id: 'later', title: 'Later Game', date: String(NOW + 5 * HOUR) })
    ];
    expect(names(await handleCatalog('tv', 'nuvio_sports_live', {}, {}))).toEqual(['🔴 LIVE: Live Game']);
  });

  it('lists only future non-live matches in the upcoming catalog, nearest first', async () => {
    matches = [
      match({ id: 'far', title: 'Far Game', date: String(NOW + 9 * HOUR) }),
      match({ id: 'soon', title: 'Soon Game', date: String(NOW + 3 * HOUR) }),
      match({ id: 'live', title: 'Live Game' }),
      match({ id: 'net', title: 'Sky Network', category: 'networks', date: '' })
    ];
    expect(names(await handleCatalog('tv', 'nuvio_sports_upcoming', {}, {})))
      .toEqual(['⏱️ Soon Game', '⏱️ Far Game']);
  });

  it('routes a sport catalog to matches of that category only', async () => {
    matches = [match({ id: 'f' }), match({ id: 'b', title: 'Lakers vs Bulls', category: 'basketball' })];
    const res = await handleCatalog('tv', 'nuvio_sports_basketball', {}, {});
    expect(res.metas.map(m => m.id)).toEqual(['nuvio_sport_b']);
  });

  it('routes college and american football to their own catalogs', async () => {
    matches = [
      match({ id: 'c', title: 'Duke vs UNC', category: 'college' }),
      match({ id: 'a', title: 'Chiefs vs Bills', category: 'american_football' })
    ];
    expect((await handleCatalog('tv', 'nuvio_sports_college', {}, {})).metas.map(m => m.id))
      .toEqual(['nuvio_sport_c']);
    expect((await handleCatalog('tv', 'nuvio_sports_american_football', {}, {})).metas.map(m => m.id))
      .toEqual(['nuvio_sport_a']);
  });

  it('pulls a topically matching 24/7 network into a sport catalog', async () => {
    matches = [
      match({ id: 'n1', title: 'beIN Sports 1', category: 'networks', date: '' }),
      match({ id: 'n2', title: 'Willow Cricket', category: 'networks', date: '' }),
      match({ id: 'n3', title: 'Cartoon Channel', category: 'networks', date: '' })
    ];
    expect((await handleCatalog('tv', 'nuvio_sports_football', {}, {})).metas.map(m => m.id))
      .toEqual(['nuvio_sport_n1']);
    expect((await handleCatalog('tv', 'nuvio_sports_cricket', {}, {})).metas.map(m => m.id))
      .toEqual(['nuvio_sport_n2']);
  });

  it('collects only unclassified categories in the other bucket', async () => {
    matches = [
      match({ id: 'f' }),
      match({ id: 'net', title: 'Sky', category: 'networks', date: '' }),
      match({ id: 'col', title: 'Duke vs UNC', category: 'college' }),
      match({ id: 'k', title: 'Kabaddi Final', category: 'kabaddi' })
    ];
    expect((await handleCatalog('tv', 'nuvio_sports_other', {}, {})).metas.map(m => m.id))
      .toEqual(['nuvio_sport_k']);
  });

  it('every manifest catalog id resolves through a handled branch', async () => {
    matches = [match({ id: 'k', title: 'Kabaddi Final', category: 'kabaddi' })];
    for (const c of manifest.catalogs) {
      const res = await handleCatalog('tv', c.id, {}, { teams: 'kabaddi' });
      expect(Array.isArray(res.metas)).toBe(true);
    }
  });
});

describe('handleCatalog config', () => {
  it('matches favorite teams case-insensitively anywhere in the title', async () => {
    matches = [match({ id: 'a' }), match({ id: 'b', title: 'Lakers vs Bulls', category: 'basketball' })];
    const res = await handleCatalog('tv', 'nuvio_sports_teams', {}, { teams: ' CHELSEA , lakers ' });
    expect(res.metas.map(m => m.id).sort()).toEqual(['nuvio_sport_a', 'nuvio_sport_b']);
  });

  it('returns nothing for the teams catalog when no teams are configured', async () => {
    matches = [match()];
    expect((await handleCatalog('tv', 'nuvio_sports_teams', {}, {})).metas).toEqual([]);
    expect((await handleCatalog('tv', 'nuvio_sports_teams', {}, { teams: '   ' })).metas).toEqual([]);
  });

  it('restricts the live catalog to the configured sports but keeps 24/7 networks', async () => {
    matches = [
      match({ id: 'f' }),
      match({ id: 'b', title: 'Lakers vs Bulls', category: 'basketball' }),
      match({ id: 'n', title: 'Sky Sports', category: 'networks', date: '' })
    ];
    const res = await handleCatalog('tv', 'nuvio_sports_live', {}, { sports: 'Basketball' });
    expect(res.metas.map(m => m.id).sort()).toEqual(['nuvio_sport_b', 'nuvio_sport_n']);
  });

  it("applies no sport filtering for the 'all' sentinel", async () => {
    matches = [match({ id: 'f' }), match({ id: 'b', title: 'Lakers vs Bulls', category: 'basketball' })];
    const res = await handleCatalog('tv', 'nuvio_sports_live', {}, { sports: 'all' });
    expect(res.metas).toHaveLength(2);
  });

  it('reads config from extra.config when no config argument is passed', async () => {
    matches = [match()];
    const res = await handleCatalog('tv', 'nuvio_sports_teams', { config: { teams: 'arsenal' } }, undefined);
    expect(res.metas.map(m => m.id)).toEqual(['nuvio_sport_m1']);
  });

  it('searches across name, description and cast', async () => {
    matches = [
      match({ id: 'a' }),
      match({ id: 'b', title: 'Lakers vs Bulls', category: 'basketball' }),
      match({ id: 'c', title: 'Mystery Event', team1: { name: 'Real Madrid' }, team2: { name: 'Barcelona' } })
    ];
    expect((await handleCatalog('tv', 'nuvio_sports_live', { search: 'lakers' }, {})).metas.map(m => m.id))
      .toEqual(['nuvio_sport_b']);
    expect((await handleCatalog('tv', 'nuvio_sports_live', { search: 'barcelona' }, {})).metas.map(m => m.id))
      .toEqual(['nuvio_sport_c']);
    expect((await handleCatalog('tv', 'nuvio_sports_live', { search: 'FOOTBALL' }, {})).metas.map(m => m.id).sort())
      .toEqual(['nuvio_sport_a', 'nuvio_sport_c']);
  });
});

describe('handleCatalog ordering', () => {
  it('puts live matches before upcoming ones', async () => {
    matches = [
      match({ id: 'up', title: 'Upcoming', date: String(NOW + 5 * HOUR) }),
      match({ id: 'live', title: 'Live' })
    ];
    const res = await handleCatalog('tv', 'nuvio_sports_football', {}, {});
    expect(res.metas.map(m => m.id)).toEqual(['nuvio_sport_live', 'nuvio_sport_up']);
  });

  it('puts live events ahead of always-live 24/7 networks', async () => {
    matches = [
      match({ id: 'net', title: 'Sky Sports Football', category: 'networks', date: '' }),
      match({ id: 'live', title: 'Live Game' })
    ];
    const res = await handleCatalog('tv', 'nuvio_sports_football', {}, {});
    expect(res.metas.map(m => m.id)).toEqual(['nuvio_sport_live', 'nuvio_sport_net']);
  });

  it('puts popular matches ahead of the rest within the same liveness tier', async () => {
    matches = [
      match({ id: 'plain', title: 'Plain', date: String(NOW - 10 * MIN) }),
      match({ id: 'pop', title: 'Popular', popular: '1', date: String(NOW - 5 * MIN) })
    ];
    const res = await handleCatalog('tv', 'nuvio_sports_football', {}, {});
    expect(res.metas.map(m => m.id)).toEqual(['nuvio_sport_pop', 'nuvio_sport_plain']);
  });

  it('orders same-tier matches by earliest kickoff', async () => {
    matches = [
      match({ id: 'c', title: 'C', date: String(NOW + 8 * HOUR) }),
      match({ id: 'a', title: 'A', date: String(NOW + 2 * HOUR) }),
      match({ id: 'b', title: 'B', date: String(NOW + 4 * HOUR) })
    ];
    const res = await handleCatalog('tv', 'nuvio_sports_football', {}, {});
    expect(res.metas.map(m => m.id)).toEqual(['nuvio_sport_a', 'nuvio_sport_b', 'nuvio_sport_c']);
  });

  it('does not mutate the cached match list while sorting', async () => {
    const original = [
      match({ id: 'up', title: 'Upcoming', date: String(NOW + 5 * HOUR) }),
      match({ id: 'live', title: 'Live' })
    ];
    matches = original;
    await handleCatalog('tv', 'nuvio_sports_football', {}, {});
    expect(matches.map(m => m.id)).toEqual(['up', 'live']);
  });
});

describe('handleCatalog paging', () => {
  const many = (n) => Array.from({ length: n }, (_, i) =>
    match({ id: `m${i}`, title: `Team${i} vs Rival${i}`, date: String(NOW + (i + 1) * HOUR) }));

  it('returns one page per request and advances with skip', async () => {
    matches = many(250);
    const first = await handleCatalog('tv', 'nuvio_sports_upcoming', {}, {});
    const second = await handleCatalog('tv', 'nuvio_sports_upcoming', { skip: '100' }, {});
    const last = await handleCatalog('tv', 'nuvio_sports_upcoming', { skip: '200' }, {});

    expect(first.metas).toHaveLength(100);
    expect(second.metas).toHaveLength(100);
    expect(last.metas).toHaveLength(50);
    expect(new Set([...names(first), ...names(second), ...names(last)]).size).toBe(250);
    expect(names(second)[0]).not.toBe(names(first)[0]);
  });

  it('pages the filtered result set, not the raw list, when searching', async () => {
    matches = [...many(120), match({ id: 'x', title: 'Zebra vs Yak', date: String(NOW + 500 * HOUR) })];
    const res = await handleCatalog('tv', 'nuvio_sports_upcoming', { search: 'zebra' }, {});
    expect(names(res)).toEqual(['⏱️ Zebra vs Yak']);
  });

  it('treats a missing or junk skip as the first page', async () => {
    matches = many(150);
    for (const extra of [{}, { skip: '' }, { skip: 'abc' }, { skip: '-5' }]) {
      const res = await handleCatalog('tv', 'nuvio_sports_upcoming', extra, {});
      expect(res.metas).toHaveLength(100);
      expect(names(res)[0]).toBe('⏱️ Team0 vs Rival0');
    }
  });

  it('lets clients cache a page without outliving the background refresh', async () => {
    matches = many(1);
    const res = await handleCatalog('tv', 'nuvio_sports_upcoming', {}, {});
    expect(res.cacheMaxAge).toBe(60);
    expect(res.staleRevalidate).toBe(300);
  });
});

describe('meta preview mapping', () => {
  const metaFor = async (over) => {
    matches = [match(over)];
    const res = await handleCatalog('tv', 'nuvio_sports_live', {}, over.__config || {});
    return res.metas[0];
  };

  it('prefixes the meta id and the default video id with nuvio_sport_', async () => {
    const meta = await metaFor({ id: 'abc' });
    expect(meta.id).toBe('nuvio_sport_abc');
    expect(meta.behaviorHints.defaultVideoId).toBe('nuvio_sport_abc');
    expect(meta.type).toBe('tv');
  });

  it('flags live fixtures, 24/7 networks and upcoming fixtures differently', async () => {
    expect((await metaFor({ id: 'a', title: 'Game' })).name).toBe('🔴 LIVE: Game');
    expect((await metaFor({ id: 'b', title: 'Sky', category: 'networks', date: '' })).name).toBe('📺 Sky');
    matches = [match({ id: 'c', title: 'Later', date: String(NOW + 5 * HOUR) })];
    const upcoming = (await handleCatalog('tv', 'nuvio_sports_football', {}, {})).metas[0];
    expect(upcoming.name).toBe('⏱️ Later');
  });

  it('reports LIVE / 24-7 / kickoff time in releaseInfo', async () => {
    expect((await metaFor({ id: 'a' })).releaseInfo).toBe('LIVE');
    expect((await metaFor({ id: 'b', category: 'networks', date: '' })).releaseInfo).toBe('24/7');
    matches = [match({ id: 'c', date: String(NOW + 5 * HOUR) })];
    const upcoming = (await handleCatalog('tv', 'nuvio_sports_football', {}, {})).metas[0];
    expect(upcoming.releaseInfo).toBe('23:00');
  });

  it('renders kickoff in the configured timezone and labels it', async () => {
    matches = [match({ id: 'c', date: String(NOW + 5 * HOUR) })];
    const res = await handleCatalog('tv', 'nuvio_sports_football', {}, { timezone: 'America/Chicago' });
    expect(res.metas[0].releaseInfo).toBe('18:00 (America/Chicago)');
    expect(res.metas[0].description).toContain('Kickoff at 18:00 (America/Chicago)');
  });

  it('uses a 24 hour clock, never AM/PM', async () => {
    matches = [match({ id: 'c', date: String(NOW + 2 * HOUR) })];
    const res = await handleCatalog('tv', 'nuvio_sports_football', {}, {});
    expect(res.metas[0].releaseInfo).toBe('20:00');
  });

  it('describes category, league and status', async () => {
    const meta = await metaFor({ id: 'a', league: 'Premier League' });
    expect(meta.description).toBe('🏆 League: Premier League\n📅 Category: FOOTBALL\n⏰ Status: 🔴 LIVE NOW');
    expect(meta.genres).toEqual(['FOOTBALL']);
  });

  it('describes a 24/7 network as a live network', async () => {
    const meta = await metaFor({ id: 'a', title: 'Sky', category: 'networks', date: '' });
    expect(meta.description).toContain('⏰ Status: 24/7 Live Network');
    expect(meta.released).toBeUndefined();
  });

  it('adds a relative countdown for upcoming matches', async () => {
    const cases = [
      [30 * MIN, '(in 30 mins)'],
      [3 * HOUR + 10 * MIN, '(in 3h 10m)'],
      [50 * HOUR, '(in 2 days)']
    ];
    for (const [delta, expected] of cases) {
      matches = [match({ id: 'c', date: String(NOW + delta) })];
      const res = await handleCatalog('tv', 'nuvio_sports_football', {}, {});
      expect(res.metas[0].description).toContain(expected);
    }
  });

  it('exposes the kickoff as an ISO released timestamp', async () => {
    const meta = await metaFor({ id: 'a', date: String(NOW) });
    expect(meta.released).toBe(new Date(NOW).toISOString());
  });

  it('lists both teams as cast', async () => {
    const meta = await metaFor({ id: 'a', team1: { name: 'Arsenal' }, team2: { name: 'Chelsea' } });
    expect(meta.cast).toEqual(['Arsenal', 'Chelsea']);
  });

  it('always produces a landscape poster and a background', async () => {
    const meta = await metaFor({ id: 'a' });
    expect(meta.posterShape).toBe('landscape');
    expect(meta.poster).toContain('/img/placeholder?text=');
    expect(meta.background).toBe(meta.poster);
  });

  it('proxies a provider poster instead of serving it directly', async () => {
    const meta = await metaFor({ id: 'a', poster: '//cdn.example.com/p.jpg' });
    expect(meta.poster).toContain('/img?url=');
    expect(meta.poster).toContain(encodeURIComponent('https://cdn.example.com/p.jpg'));
  });

  it('resolves a host-relative provider image against the default host', async () => {
    const meta = await metaFor({ id: 'a', poster: '/p.jpg' });
    expect(meta.poster).toContain(encodeURIComponent('https://streamfree.top/p.jpg'));
  });

  it('falls back to a placeholder name when the provider sent no title', async () => {
    const meta = await metaFor({ id: 'a', title: '' });
    expect(meta.name).toBe('🔴 LIVE: Live Match');
    expect(meta.poster).toContain('/img/placeholder?text=');
  });
});

describe('handleMeta', () => {
  it('returns null for foreign types and ids', async () => {
    expect((await handleMeta('movie', 'nuvio_sport_m1', {})).meta).toBeNull();
    expect((await handleMeta('tv', 'tt12345', {})).meta).toBeNull();
  });

  it('returns null when the id is not in the cache', async () => {
    matches = [match({ id: 'm1' })];
    expect((await handleMeta('tv', 'nuvio_sport_missing', {})).meta).toBeNull();
  });

  it('returns the same meta shape as the catalog and prewarms the match', async () => {
    matches = [match({ id: 'm1', title: 'Game' })];
    const { meta } = await handleMeta('tv', 'nuvio_sport_m1', {});
    expect(meta.id).toBe('nuvio_sport_m1');
    expect(meta.name).toBe('🔴 LIVE: Game');
    expect(prewarmed.map(m => m.id)).toEqual(['m1']);
  });

  it('does not prewarm an unknown match', async () => {
    matches = [];
    await handleMeta('tv', 'nuvio_sport_m1', {});
    expect(prewarmed).toEqual([]);
  });
});

afterAll(() => mock.restore());
