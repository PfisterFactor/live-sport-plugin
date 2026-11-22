const crypto = require('crypto');
const { describe, it, expect, beforeEach, afterEach, setSystemTime } = require('bun:test');
const Ak47LiveProvider = require('../../../src/providers/Ak47LiveProvider');
const { makeCradle, res } = require('./fixtures/helpers');
const EmbedIndiaProvider = require('../../../src/providers/EmbedIndiaProvider');
const { verifyPayload } = require('../../../src/services/DashPayload');

const KEY = Buffer.from('az1sUE8zNnNUVXpN', 'ascii');
const IV = Buffer.from('dz00QVhsNmZZU0Fw', 'ascii');

function encrypt(value) {
  const cipher = crypto.createCipheriv('aes-128-cbc', KEY, IV);
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const b = Buffer.from(ct.toString('base64'), 'ascii').reverse();
  for (let i = 0; i < b.length - 1; i += 2) {
    const t = b[i]; b[i] = b[i + 1]; b[i + 1] = t;
  }
  return b.toString('base64');
}

const EVENTS = [
  {
    event: JSON.stringify({
      teamAName: 'Minnesota Vikings', teamBName: 'Detroit Lions', category: 'NFL', eventName: 'NFL',
      date: '01/11/2026', time: '18:00:00', end_date: '01/11/2026', end_time: '21:30:00',
      links: 'pro/vikings.txt', link_names: ['CH 1', 'CH 2'], visible: true,
    }),
  },
  {
    event: JSON.stringify({
      teamAName: 'Old', teamBName: 'Game', category: 'Football', date: '30/10/2026', time: '12:00:00',
      end_date: '30/10/2026', end_time: '14:00:00', links: 'pro/old.txt', visible: true,
    }),
  },
  { event: JSON.stringify({ teamAName: 'Hidden', teamBName: 'Team', visible: false }) },
];

const PLAYLIST = `#EXTM3U
#EXTVLCOPT:http-referrer=https://ref.example/
#EXTVLCOPT:http-origin=https://ref.example
#EXTINF:-1 tvg-name="x" group-title="NFL" tvg-logo="http://l/x.png",NFL : Minnesota Vikings vs Detroit Lions --- CH 3
http://193.47.62.55/hls/G999A.m3u8
#EXTINF:-1 group-title="Football",Old vs Game --- CH 1
http://cdn.example/old.m3u8
#EXTINF:-1 group-title="Football",Dash vs Game
http://cdn.example/x.mpd
#EXTINF:-1 group-title="Premier League",Arsenal vs Chelsea
http://cdn.example/arsenal.m3u8
`;

function makeProvider(routes, embedIndiaProvider) {
  const p = new Ak47LiveProvider(makeCradle({ embedIndiaProvider }));
  p.proxyFetch = async (url) => {
    for (const [needle, body] of Object.entries(routes)) {
      if (url.includes(needle)) return res({ body });
    }
    return res({ status: 404 });
  };
  return p;
}

const ROUTES = {
  'hellobabu.xyz/events.txt': encrypt(EVENTS),
  'fawasp.pages.dev': PLAYLIST,
  'axsp.pages.dev': '',
};

describe('Ak47LiveProvider getMatches', () => {
  beforeEach(() => setSystemTime(new Date('2026-11-01T19:00:00Z')));
  afterEach(() => setSystemTime());

  it('decodes events, merges playlist channels, and drops finished or hidden fixtures', async () => {
    const matches = await makeProvider(ROUTES).getMatches();
    expect(matches.map(m => m.title)).toEqual(['Minnesota Vikings vs Detroit Lions', 'Arsenal vs Chelsea']);
    const [nfl, arsenal] = matches;
    expect(nfl.category).toBe('american_football');
    expect(nfl.status).toBe('live');
    expect(nfl.date).toBe(String(Date.UTC(2026, 10, 1, 18)));
    expect(nfl.sources.map(s => s.id)).toEqual(['pro/vikings.txt#0', 'pro/vikings.txt#1', 'http://193.47.62.55/hls/G999A.m3u8']);
    expect(nfl.sources[2].referer).toBe('https://ref.example/');
    expect(arsenal.category).toBe('football');
    expect(arsenal.team1).toEqual({ name: 'Arsenal' });
  });

  it('reads a reused entry with a days-old start as kicking off on its end date', async () => {
    const stale = (teamAName, date, time, end_date, end_time) => ({
      event: JSON.stringify({
        teamAName, teamBName: 'Rival', category: 'NFL', date, time,
        end_date, end_time, links: `pro/${teamAName}.txt`, visible: true,
      }),
    });
    const matches = await makeProvider({
      'hellobabu.xyz/events.txt': encrypt([
        stale('Lions', '26/10/2026', '18:00:00', '01/11/2026', '21:30:00'),
        stale('Ravens', '26/10/2026', '23:00:00', '02/11/2026', '02:30:00'),
      ]),
      'fawasp.pages.dev': '',
      'axsp.pages.dev': '',
    }).getMatches();
    const date = (team) => matches.find(m => m.title.startsWith(team)).date;
    expect(date('Lions')).toBe(String(Date.UTC(2026, 10, 1, 18)));
    expect(date('Ravens')).toBe(String(Date.UTC(2026, 10, 1, 23)));
  });
});

describe('Ak47LiveProvider resolveStream', () => {
  it('resolves an encrypted channel with link headers through the manifest proxy', async () => {
    const p = makeProvider({
      'pro/vikings.txt': encrypt([
        { name: 'CH 1', link: 'https://a.example/x.m3u8|Referer=https://site.example/page&User-Agent=UA1' },
        { name: 'CH 2', link: 'https://b.example/y.m3u8', key: 'abcd' },
      ]),
    });
    const [s] = await p.resolveStream('pro/vikings.txt#0', 'american_football', 'Vikings vs Lions', {
      linksPath: 'pro/vikings.txt', streamIndex: 0, channelName: 'CH 1',
    });
    const u = new URL(s.url);
    expect(u.pathname).toBe('/api/manifest');
    expect(u.searchParams.get('url')).toBe('https://a.example/x.m3u8');
    expect(u.searchParams.get('referer')).toBe('https://site.example/page');
    expect(u.searchParams.get('origin')).toBe('https://site.example');
    expect(s.title).toBe('Vikings vs Lions (CH 1)');

    expect(await p.resolveStream('x', 'a', 'b', { linksPath: 'pro/vikings.txt', streamIndex: 1 })).toEqual([]);
  });

  it('proxies direct playlist URLs with their own referer and rejects DASH/embed links', async () => {
    const p = makeProvider({});
    const [s] = await p.resolveStream('http://1.2.3.4/a.m3u8', 'x', 'T', {
      id: 'http://1.2.3.4/a.m3u8', referer: 'https://ref.example/', origin: 'https://ref.example', channelName: 'CH 3',
    });
    expect(new URL(s.url).searchParams.get('referer')).toBe('https://ref.example/');
    expect(await p.resolveStream('http://c.example/a.mpd', 'x', 'T', {})).toEqual([]);
    expect(await p.resolveStream('https://embed.st/a.m3u8', 'x', 'T', {})).toEqual([]);
  });

  it('plays a ClearKey DASH channel as signed /api/dash HLS carrying the link headers', async () => {
    const mpd = 'https://otte.cache.aiv-cdn.net/bom-nitro/live/clients/dash/enc/x/out/v1/y/cenc.mpd';
    const kid = '85b277daf5aae05833fe43a68f587968';
    const key = 'd52d7e9bc0bcd98787efd547ac91eca0';
    const p = makeProvider({
      'pro/nhl.txt': encrypt([
        { name: 'TSN2 SPORTS FHD', link: `${mpd}|Origin=https://amazon.com&user-agent=UA2`, api: `${kid}:${key}` },
      ]),
    });
    const [s] = await p.resolveStream('pro/nhl.txt#0', 'hockey', 'Bruins vs Leafs', { linksPath: 'pro/nhl.txt', streamIndex: 0 });

    const u = new URL(s.url);
    expect(u.pathname).toBe('/api/dash/index.m3u8');
    const verified = verifyPayload(u.searchParams.get('d'));
    expect(verified.ok).toBe(true);
    expect(verified.payload).toMatchObject({ mpdUrl: mpd, key, kid });
    expect(verified.payload.headers).toEqual({ 'User-Agent': 'UA2', Origin: 'https://amazon.com' });
    expect(verified.payload.e).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(s.title).toBe('Bruins vs Leafs (TSN2 SPORTS FHD)');
    expect(s.behaviorHints.notWebReady).toBe(true);
  });

  it('drops DASH without a usable key and DRM rows', async () => {
    const mpd = 'https://cdn.example/live/cenc.mpd';
    const p = makeProvider({
      'pro/x.txt': encrypt([
        { name: 'no key', link: mpd },
        { name: 'short key', link: mpd, api: `${'a'.repeat(32)}:abcd` },
        { name: 'widevine', link: mpd, drm_scheme: 'widevine', kid: 'k' },
      ]),
    });
    for (const streamIndex of [0, 1, 2]) {
      expect(await p.resolveStream('pro/x.txt', 'x', 'T', { linksPath: 'pro/x.txt', streamIndex })).toEqual([]);
    }
  });

  it('resolves embedindia-family embed tokens through EmbedIndia with renewal', async () => {
    const embedUrl = 'https://taifood-blog.asia/embed/nfl/2026-11-22/no-chi';
    const embedIndia = new EmbedIndiaProvider(makeCradle());
    const calls = [];
    embedIndia.extractM3u8 = async (url) => {
      calls.push(url);
      return { m3u8: 'https://cdn.example/live/index.m3u8?token=abc', referer: 'https://taifood-blog.asia/' };
    };
    const p = makeProvider({
      'pro/nfl.txt': encrypt([{ name: 'XTREME+ FHD', link: '', tokenApi: JSON.stringify({ type: 'embed', api: embedUrl, url: '' }) }]),
    }, embedIndia);
    const [s] = await p.resolveStream('pro/nfl.txt#0', 'american_football', 'Vikings vs Lions', { linksPath: 'pro/nfl.txt', streamIndex: 0 });
    const u = new URL(s.url);
    expect(u.pathname).toBe('/api/manifest');
    expect(u.searchParams.get('url')).toBe('https://cdn.example/live/index.m3u8?token=abc');
    expect(u.searchParams.get('referer')).toBe('https://taifood-blog.asia/');
    expect(u.searchParams.get('renew')).toBe('embedindia');
    expect(u.searchParams.get('embed')).toBe(embedUrl);
    expect(s.title).toBe('Vikings vs Lions (XTREME+ FHD)');
    expect(calls).toEqual([embedUrl]);
  });

  it('allows embedindia.st embed tokens on the EmbedIndia route only', async () => {
    const embedIndia = new EmbedIndiaProvider(makeCradle());
    embedIndia.extractM3u8 = async () => ({ m3u8: 'https://cdn.example/a.m3u8', referer: 'https://embedindia.st/' });
    const routes = {
      'pro/x.txt': encrypt([{ name: 'CH 1', tokenApi: { type: 'embed', api: 'https://embedindia.st/embed/admin/ch5' } }]),
    };
    const [s] = await makeProvider(routes, embedIndia).resolveStream('pro/x.txt#0', 'x', 'T', { linksPath: 'pro/x.txt', streamIndex: 0 });
    expect(new URL(s.url).searchParams.get('embed')).toBe('https://embedindia.st/embed/admin/ch5');
    expect(await makeProvider(routes).resolveStream('pro/x.txt#0', 'x', 'T', { linksPath: 'pro/x.txt', streamIndex: 0 })).toEqual([]);
  });

  it('drops embed tokens whose EmbedIndia extraction yields nothing', async () => {
    const embedIndia = new EmbedIndiaProvider(makeCradle());
    embedIndia.extractM3u8 = async () => null;
    const p = makeProvider({
      'pro/x.txt': encrypt([{ name: 'CH 1', tokenApi: { type: 'embed', api: 'https://taifood-blog.asia/embed/nfl/a-b' } }]),
    }, embedIndia);
    expect(await p.resolveStream('pro/x.txt#0', 'x', 'T', { linksPath: 'pro/x.txt', streamIndex: 0 })).toEqual([]);
  });
});
