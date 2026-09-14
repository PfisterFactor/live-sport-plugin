const { describe, it, expect, beforeEach, afterEach, afterAll, setSystemTime, mock } = require('bun:test');
const extractor = require('../../../src/providers/SportsEmbedExtractor');
const WatchFootyProvider = require('../../../src/providers/WatchFootyProvider');
const { makeCradle, res } = require('./fixtures/helpers');

const realExtract = extractor.extractSportsEmbed;
let extractImpl = async () => null;
extractor.extractSportsEmbed = (...a) => extractImpl(...a);

afterAll(() => { extractor.extractSportsEmbed = realExtract; });
const NOW = new Date('2026-03-01T12:00:00Z');

const LIST = [
  {
    matchId: 'm1',
    title: 'Arsenal vs Chelsea',
    sport: 'soccer',
    status: 'in',
    timestamp: 1772366400,
    poster: '/img/m1.jpg',
    streams: [{ url: 'https://watchfooty.st/embed/m1/1' }],
  },
  { matchId: 'm2', sport: 'basketball', status: 'pre', timestamp: 1772366400, teams: { home: { name: 'Lakers' }, away: { name: 'Celtics' } }, streams: [{ url: 'https://x/1' }] },
  { matchId: 'm3', title: 'No Streams FC', sport: 'soccer', status: 'pre', timestamp: 1772366400, streams: [] },
  { matchId: 'm4', title: 'Finished', sport: 'soccer', status: 'post', timestamp: 1772366400, streams: [{ url: 'https://x/4' }] },
  { matchId: 'm5', title: 'Called Off', sport: 'soccer', status: 'postponed', timestamp: 1772366400, streams: [{ url: 'https://x/5' }] },
];

function makeProvider({ list = LIST, details, embedIndiaProvider, html } = {}) {
  const p = new WatchFootyProvider(makeCradle({ embedIndiaProvider }));
  p.embedIndiaProvider = embedIndiaProvider;
  p.proxyFetch = async (url, opts) => {
    p._lastOpts = opts;
    if (url === p.apiUrl) return res({ json: list });
    if (url.startsWith('https://api.watchfooty.st/api/v1/match/')) return res({ json: details });
    return html ? res({ body: html }) : res({ status: 500, body: '' });
  };
  return p;
}

describe('WatchFootyProvider.getMatches', () => {
  beforeEach(() => setSystemTime(NOW));
  afterEach(() => setSystemTime());

  it('keeps only streamable, non-finished fixtures', async () => {
    const matches = await makeProvider().getMatches();
    expect(matches.map((m) => m.id)).toEqual(['wf_m1', 'wf_m2']);
  });

  it('maps status, category, title fallback and absolute poster', async () => {
    const [m1, m2] = await makeProvider().getMatches();
    expect(m1.status).toBe('live');
    expect(m1.category).toBe('football');
    expect(m1.poster).toBe('https://api.watchfooty.st/img/m1.jpg');
    expect(m1.sources).toEqual([{ source: 'watchfooty', id: 'm1' }]);
    expect(m2.status).toBe('upcoming');
    expect(m2.title).toBe('Lakers vs Celtics');
    expect(m2.category).toBe('basketball');
  });

  it('converts second-precision API timestamps to millis', async () => {
    const [m1] = await makeProvider().getMatches();
    expect(m1.date).toBe('1772366400000');
  });

  it('keeps protocol-relative and absolute posters intact', async () => {
    const list = [
      { matchId: 'a', title: 'A', sport: 'soccer', status: 'pre', timestamp: 1772366400, poster: '//cdn.x/p.jpg', streams: [{ url: 'u' }] },
      { matchId: 'b', title: 'B', sport: 'soccer', status: 'pre', timestamp: 1772366400, poster: 'https://cdn.x/q.jpg', streams: [{ url: 'u' }] },
      { matchId: 'c', title: 'C', sport: 'soccer', status: 'pre', timestamp: 1772366400, poster: 'r.jpg', streams: [{ url: 'u' }] },
    ];
    const [a, b, c] = await makeProvider({ list }).getMatches();
    expect(a.poster).toBe('https://cdn.x/p.jpg');
    expect(b.poster).toBe('https://cdn.x/q.jpg');
    expect(c.poster).toBe('https://api.watchfooty.st/r.jpg');
  });

  it('returns [] when the API errors or answers with a non-array', async () => {
    const p = makeProvider();
    p.proxyFetch = async () => res({ status: 500, body: '' });
    expect(await p.getMatches()).toEqual([]);
    const p2 = makeProvider({ list: { events: [] } });
    expect(await p2.getMatches()).toEqual([]);
  });
});

describe('WatchFootyProvider.resolveStream', () => {
  beforeEach(() => { setSystemTime(NOW); extractImpl = async () => null; });
  afterEach(() => setSystemTime());

  it('returns direct m3u8/mp4 links with playback headers and quality', async () => {
    const details = { streams: [{ url: 'https://edge.wf/live/a.m3u8', quality: 'hd' }, { url: 'https://edge.wf/v.mp4' }] };
    const streams = await makeProvider({ details }).resolveStream('m1', 'football', 'A vs B');
    expect(streams.map((s) => s.url)).toEqual(['https://edge.wf/live/a.m3u8', 'https://edge.wf/v.mp4']);
    expect(streams[0].resolution).toBe('HD');
    expect(streams[1].resolution).toBe('SD');
    expect(streams[0].title).toBe('WatchFooty Stream 1');
    expect(streams[1].title).toBe('WatchFooty Stream 2');
    expect(streams[0].behaviorHints.proxyHeaders.request.Referer).toBe('https://watchfooty.st/');
  });

  it('unwraps an array-shaped match details payload', async () => {
    const details = [{ streams: [{ url: 'https://edge.wf/a.m3u8' }] }];
    const streams = await makeProvider({ details }).resolveStream('m1', 'football', 'A vs B');
    expect(streams).toHaveLength(1);
  });

  it('delegates an embedindia iframe redirect to EmbedIndia and rebrands the result', async () => {
    const embedIndiaProvider = {
      resolveStream: mock(async () => [{ name: 'EmbedIndia', title: 'EmbedIndia (A vs B)', url: 'https://proxy/x.m3u8' }]),
    };
    const details = { streams: [{ url: 'https://sportsembed.su/embed/1/a/platinum/1' }] };
    const html = "<iframe src='https://embedindia.st/embed/admin/ch5'></iframe>";
    const streams = await makeProvider({ details, embedIndiaProvider, html }).resolveStream('m1', 'football', 'A vs B');
    expect(embedIndiaProvider.resolveStream).toHaveBeenCalledTimes(1);
    expect(embedIndiaProvider.resolveStream.mock.calls[0][3]).toEqual({ referer: 'https://embedindia.st/' });
    expect(streams).toHaveLength(1);
    expect(streams[0].name).toBe('WatchFooty');
    expect(streams[0].title).toBe('WatchFooty (A vs B)');
  });

  it('falls back to native sportsembed extraction when no iframe redirect is present', async () => {
    extractImpl = async () => 'https://edge.se/live/secret.m3u8';
    const details = { streams: [{ url: 'https://sportsembed.su/embed/1/a/platinum/1', quality: '1080p' }] };
    const [s] = await makeProvider({ details, html: '<html>no iframe</html>' }).resolveStream('m1', 'football', 'A vs B');
    expect(s.url).toContain('/api/manifest?url=');
    expect(decodeURIComponent(s.url.split('url=')[1].split('&')[0])).toBe('https://edge.se/live/secret.m3u8');
    expect(s.behaviorHints).toEqual({ notWebReady: true });
  });

  it('offers the /watch fallback when native extraction throws', async () => {
    extractImpl = async () => { throw new Error('API Blocked'); };
    const details = { streams: [{ url: 'https://sportsembed.su/embed/1/a/platinum/1' }] };
    const [s] = await makeProvider({ details, html: '<html></html>' }).resolveStream('m1', 'football', 'A vs B');
    expect(s.externalUrl).toContain('/watch?url=https%3A%2F%2Fsportsembed.su');
  });

  it('emits nothing extra when extraction silently returns no url', async () => {
    const details = { streams: [{ url: 'https://sportsembed.su/embed/1/a/platinum/1' }] };
    const streams = await makeProvider({ details, html: '<html></html>' }).resolveStream('m1', 'football', 'A vs B');
    expect(streams).toEqual([]);
  });

  it('wraps unknown embed hosts in the /watch player and skips url-less entries', async () => {
    const details = { streams: [{ url: 'https://random.tv/e/1' }, { quality: 'hd' }] };
    const streams = await makeProvider({ details }).resolveStream('m1', 'football', 'A vs B');
    expect(streams).toHaveLength(1);
    expect(streams[0].externalUrl).toBe('/watch?url=https%3A%2F%2Frandom.tv%2Fe%2F1&title=A%20vs%20B');
  });

  it('returns [] when the details fetch fails', async () => {
    const p = makeProvider();
    p.proxyFetch = async () => res({ status: 404, body: '' });
    expect(await p.resolveStream('m1', 'football', 'A vs B')).toEqual([]);
  });
});
