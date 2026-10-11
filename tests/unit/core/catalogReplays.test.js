const { describe, it, expect, beforeEach, afterEach, spyOn, afterAll, mock, setSystemTime } = require('bun:test');

const NOW = new Date('2026-09-15T18:00:00Z').getTime();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

let matches = [];

const container = require('../../../src/container');
const streams = require('../../../src/streams');

spyOn(container, 'resolve').mockImplementation((name) => {
  if (name === 'cronService') return { ensureFresh: () => {} };
  if (name === 'cacheService') return { getMatches: () => matches, findMatch: () => null };
  throw new Error(`unexpected resolve('${name}')`);
});
spyOn(streams, 'prewarmMatch').mockImplementation(async () => {});

const { handleCatalog } = require('../../../src/catalog');

const replay = (over = {}) => ({
  id: over.id || 'r1',
  title: 'Arsenal vs Chelsea - Full Match Replay',
  category: 'football',
  date: String(NOW - DAY),
  status: 'finished',
  popular: '0',
  league: 'Premier League',
  sources: [{ source: 'replayzone', id: 'u1', url: 'u1' }],
  team1: null,
  team2: null,
  ...over
});

const live = (over = {}) => ({
  id: over.id || 'l1',
  title: 'Sevilla vs Valencia',
  category: 'football',
  date: String(NOW - 30 * MIN),
  status: '',
  popular: '0',
  league: 'La Liga',
  sources: [{ source: 'dlive', id: 'x' }],
  team1: null,
  team2: null,
  ...over
});

const ids = (res) => res.metas.map(m => m.id.replace('nuvio_sport_', ''));

beforeEach(() => {
  setSystemTime(new Date(NOW));
  matches = [];
});

afterEach(() => setSystemTime());

describe('live and upcoming catalogs hide replays', () => {
  it('keeps a replay out of Live Now, Upcoming and the sport catalog', async () => {
    matches = [replay(), live(), live({ id: 'u1', date: String(NOW + 3 * HOUR) })];
    expect(ids(await handleCatalog('tv', 'nuvio_sports_live', {}, {}))).toEqual(['l1']);
    expect(ids(await handleCatalog('tv', 'nuvio_sports_upcoming', {}, {}))).toEqual(['u1']);
    expect(ids(await handleCatalog('tv', 'nuvio_sports_football', {}, {})).sort()).toEqual(['l1', 'u1']);
  });

  it('hides finished live-provider streams from sport catalogs', async () => {
    matches = [live({ id: 'done', status: 'finished' }), live({ id: 'ok' })];
    expect(ids(await handleCatalog('tv', 'nuvio_sports_football', {}, {}))).toEqual(['ok']);
  });
});

describe('replay catalogs', () => {
  it('lists replays newest first in the all-sports replay catalog', async () => {
    matches = [
      replay({ id: 'old', date: String(NOW - 5 * DAY) }),
      replay({ id: 'new', date: String(NOW - 1 * DAY) }),
      live()
    ];
    const res = await handleCatalog('tv', 'nuvio_sports_replays', {}, {});
    expect(ids(res)).toEqual(['new', 'old']);
    expect(res.cacheMaxAge).toBe(1800);
  });

  it('requires a replay-capable provider and excludes timstreams VODs', async () => {
    matches = [
      replay({ id: 'ok' }),
      replay({ id: 'vod', sources: [{ source: 'timstreams', id: 'v' }] }),
      replay({ id: 'both', sources: [{ source: 'replayzone', id: 'a' }, { source: 'timstreams', id: 'b' }] }),
      replay({ id: 'liveprov', sources: [{ source: 'streamedpk', id: 'c' }] })
    ];
    expect(ids(await handleCatalog('tv', 'nuvio_sports_replays', {}, {}))).toEqual(['ok']);
  });

  it('serves per-sport replay rows', async () => {
    matches = [
      replay({ id: 'f' }),
      replay({ id: 'b', title: 'Yankees @ Red Sox - Full Game Replay', category: 'baseball', league: 'MLB' })
    ];
    expect(ids(await handleCatalog('tv', 'nuvio_sports_replays_baseball', {}, {}))).toEqual(['b']);
    expect(ids(await handleCatalog('tv', 'nuvio_sports_replays_football', {}, {}))).toEqual(['f']);
  });

  it('supports date sub-filters on the kickoff day', async () => {
    matches = [
      replay({ id: 'y', date: String(NOW - DAY) }),
      replay({ id: 'w', date: String(NOW - 4 * DAY) }),
      replay({ id: 'o', date: String(NOW - 12 * DAY) })
    ];
    expect(ids(await handleCatalog('tv', 'nuvio_sports_replays_football_yesterday', {}, {}))).toEqual(['y']);
    expect(ids(await handleCatalog('tv', 'nuvio_sports_replays_football_this_week', {}, {}))).toEqual(['w']);
    expect(ids(await handleCatalog('tv', 'nuvio_sports_replays_football_older', {}, {}))).toEqual(['o']);
    expect(ids(await handleCatalog('tv', 'nuvio_sports_replays_football_date_2026-09-11', {}, {}))).toEqual(['w']);
  });

  it('serves replays through the "Replays" genre on a live catalog', async () => {
    matches = [replay(), live()];
    expect(ids(await handleCatalog('tv', 'nuvio_sports_live', { genre: 'Replays' }, {}))).toEqual(['r1']);
  });

  it('pages replay rows with skip', async () => {
    matches = Array.from({ length: 130 }, (_, i) => replay({ id: `r${i}`, date: String(NOW - DAY - i * MIN) }));
    const first = await handleCatalog('tv', 'nuvio_sports_replays', {}, {});
    const second = await handleCatalog('tv', 'nuvio_sports_replays', { skip: '100' }, {});
    expect(first.metas).toHaveLength(100);
    expect(second.metas).toHaveLength(30);
  });
});

describe('replayFilter', () => {
  const mixed = () => [
    replay({ id: 'epl', league: 'Premier League', title: 'Arsenal vs Chelsea - Replay' }),
    replay({ id: 'lower', league: 'La Liga 2', title: 'Zaragoza vs Gijon - Replay' }),
    replay({ id: 'local', league: '', title: 'Foo United vs Bar Town - Replay' })
  ];

  it("'all' (and absent) lists every replay", async () => {
    matches = mixed();
    expect(ids(await handleCatalog('tv', 'nuvio_sports_replays', {}, {})).sort()).toEqual(['epl', 'local', 'lower']);
    expect(ids(await handleCatalog('tv', 'nuvio_sports_replays', {}, { replayFilter: 'all' })).sort()).toEqual(['epl', 'local', 'lower']);
  });

  it("'mainstream' narrows to mainstream fixtures", async () => {
    matches = mixed();
    expect(ids(await handleCatalog('tv', 'nuvio_sports_replays', {}, { replayFilter: 'mainstream' }))).toEqual(['epl']);
    expect(ids(await handleCatalog('tv', 'nuvio_sports_replays_football', {}, { replayFilter: 'mainstream' }))).toEqual(['epl']);
  });

  it("'disabled' serves no replays on any route", async () => {
    matches = mixed();
    const conf = { replayFilter: 'disabled' };
    expect((await handleCatalog('tv', 'nuvio_sports_replays', {}, conf)).metas).toEqual([]);
    expect((await handleCatalog('tv', 'nuvio_sports_replays_football', {}, conf)).metas).toEqual([]);
    expect((await handleCatalog('tv', 'nuvio_sports_live', { genre: 'Replays' }, conf)).metas).toEqual([]);
  });
});

describe('ranking', () => {
  it('ranks a mainstream fixture above a lower-division one even when the minor is popular', async () => {
    matches = [
      live({ id: 'minor', title: 'Zaragoza vs Gijon', league: 'La Liga 2', popular: '1' }),
      live({ id: 'major', title: 'Real Madrid vs Barcelona', league: 'La Liga', popular: '0' })
    ];
    expect(ids(await handleCatalog('tv', 'nuvio_sports_live', {}, {}))).toEqual(['major', 'minor']);
  });

  it('does not reorder catalogs by favourite teams', async () => {
    matches = [
      live({ id: 'major', title: 'Real Madrid vs Barcelona', league: 'La Liga' }),
      live({ id: 'minor', title: 'Zaragoza vs Gijon', league: 'La Liga 2' })
    ];
    expect(ids(await handleCatalog('tv', 'nuvio_sports_live', {}, { teams: 'zaragoza' }))).toEqual(['major', 'minor']);
  });
});

describe('Your Teams matching', () => {
  it('is accent- and case-insensitive', async () => {
    matches = [live({ id: 'a', title: 'Atlético Goianiense vs Náutico' })];
    expect(ids(await handleCatalog('tv', 'nuvio_sports_teams', {}, { teams: 'atletico, NAUTICO' }))).toEqual(['a']);
  });

  it('matches whole words, so "real" does not find Montreal', async () => {
    matches = [live({ id: 'mtl', title: 'Montreal Canadiens vs Boston Bruins', category: 'hockey' })];
    expect((await handleCatalog('tv', 'nuvio_sports_teams', {}, { teams: 'real' })).metas).toEqual([]);
  });

  it('requires every word of a multi-word favourite', async () => {
    matches = [live({ id: 'city', title: 'Manchester City vs Leeds' })];
    expect((await handleCatalog('tv', 'nuvio_sports_teams', {}, { teams: 'man united' })).metas).toEqual([]);
    expect(ids(await handleCatalog('tv', 'nuvio_sports_teams', {}, { teams: 'man city' }))).toEqual(['city']);
  });
});

afterAll(() => mock.restore());
