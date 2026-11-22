const crypto = require('crypto');
const { describe, test, expect, beforeEach, afterEach, setSystemTime } = require('bun:test');
const fs = require('fs');
const path = require('path');
const SkTechProvider = require('../../../src/providers/SkTechProvider');
const { verifyPayload } = require('../../../src/services/DashPayload');
const { decryptPrimary } = require('../../../src/services/SkTechCrypto');
const { makeCradle } = require('./fixtures/helpers');

const m3u = fs.readFileSync(path.join(__dirname, 'fixtures/live/sktech_sonyliv.m3u'), 'utf8');

/** Provider whose app backend is unreachable, so only the playlist feeds contribute. */
function feedsOnly(p) {
  p.fetchRemoteConfig = { fire: async () => { throw new Error('offline'); } };
  p.fetchBackend = { fire: async () => { throw new Error('offline'); } };
  return p;
}

describe('SkTechProvider', () => {
  test('cleanEventTitle strips language prefix and date suffix', () => {
    expect(SkTechProvider.cleanEventTitle('ENG | India A vs Pakistan Shaheens - 22 Nov 2026')).toBe('India A vs Pakistan Shaheens');
  });

  test('parsePlaylist reads attributes and pipe headers', () => {
    const rows = SkTechProvider.parsePlaylist(m3u);
    expect(rows.length).toBe(5);
    expect(rows[0].url).toContain('/ENG/master.m3u8');
    expect(rows[0].headers.Referer).toBe('https://www.sonyliv.com/');
    expect(rows[1].lang).toBe('Hindi');
  });

  test('one match per fixture with a source per language', async () => {
    const p = feedsOnly(new SkTechProvider(makeCradle()));
    p.fetchFeed = { fire: async (url) => (url.includes('nony2') ? m3u : '#EXTM3U\n') };
    const matches = await p.getMatches();
    expect(matches.length).toBe(1);
    expect(matches[0].title).toBe('India A vs Pakistan Shaheens');
    expect(matches[0].category).toBe('cricket');
    expect(matches[0].sources.map((s) => s.lang)).toEqual(['English', 'Hindi', 'Tamil', 'Telugu', 'Kannada']);
  });

  test('keeps only 720p and 1080p rows from tagged feeds', () => {
    const p = new SkTechProvider(makeCradle());
    const text = ['240p', '720p', '1080p'].map((r) =>
      `#EXTINF:-1 tvg-id="9" tvg-name="A vs B" group-title="Cricket", NAM vs UGA | ${r} | ENG\nhttps://cdn.example/${r}.m3u8`).join('\n');
    const events = new Map();
    p._collect(SkTechProvider.parsePlaylist(text), { label: 'FanCode' }, events);
    const [event] = [...events.values()];
    expect(event.sources.map((s) => s.resolution)).toEqual(['720P', '1080P']);
  });

  test('resolveStream proxies the playlist URL with its referer', async () => {
    const p = feedsOnly(new SkTechProvider(makeCradle()));
    const [match] = await Object.assign(p, { fetchFeed: { fire: async () => m3u } }).getMatches();
    const [stream] = await p.resolveStream(match.sources[1].id, 'cricket', match.title, match.sources[1]);
    const q = new URL(stream.url).searchParams;
    expect(q.get('url')).toContain('/HIN/master.m3u8');
    expect(q.get('referer')).toBe('https://www.sonyliv.com/');
    expect(stream.title).toContain('Hindi');
  });
});

describe('SkTechProvider ClearKey DASH', () => {
  const KID = '6752015acf084572a08dfe21796f8b45';
  const KEY = 'ff823ddbe5625c35d3e93f0ed4520115';
  const dashPlaylist = [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="7" tvg-name="India vs Australia" tvg-language="Hindi" group-title="Cricket",India vs Australia',
    `#KODIPROP:inputstream.adaptive.license_key=${KID}:${KEY}`,
    'https://cdn.example/live/manifest.mpd|User-Agent=UA9&Referer=https://www.sonyliv.com/',
    '#EXTINF:-1 tvg-id="7" tvg-name="India vs Australia" tvg-language="English" group-title="Cricket",India vs Australia',
    'https://cdn.example/live/keyless.mpd',
  ].join('\n');

  test('parsePlaylist attaches the KODIPROP key to the row that follows and no other', () => {
    const rows = SkTechProvider.parsePlaylist(dashPlaylist);
    expect(rows[0].clearKey).toEqual({ kid: KID, key: KEY });
    expect(rows[1].clearKey).toBeNull();
  });

  test('a keyed DASH row becomes a /api/dash stream; a keyless one is skipped', async () => {
    const p = feedsOnly(new SkTechProvider(makeCradle()));
    p.fetchFeed = { fire: async (url) => (url.includes('nony2') ? dashPlaylist : '#EXTM3U\n') };
    const [match] = await p.getMatches();
    expect(match.sources).toHaveLength(1);

    const [stream] = await p.resolveStream(match.sources[0].id, 'cricket', match.title, match.sources[0]);
    const url = new URL(stream.url);
    expect(url.pathname).toBe('/api/dash/index.m3u8');
    const verified = verifyPayload(url.searchParams.get('d'));
    expect(verified.payload).toMatchObject({ mpdUrl: 'https://cdn.example/live/manifest.mpd', key: KEY, kid: KID });
    expect(verified.payload.headers).toMatchObject({ 'User-Agent': 'UA9', Referer: 'https://www.sonyliv.com/' });
    expect(stream.behaviorHints.notWebReady).toBe(true);
  });

  test('a malformed key yields no stream', async () => {
    const p = new SkTechProvider(makeCradle());
    const [stream] = [await p.resolveStream('id', 'cricket', 'A vs B', {
      streamUrl: 'https://cdn.example/a.mpd', clearKey: { kid: KID, key: 'short' }, feed: 'FanCode', resolution: 'HD', lang: 'English', headers: {},
    })];
    expect(stream).toEqual([]);
  });
});

describe('SkTechProvider app backend', () => {
  const live = (name) => fs.readFileSync(path.join(__dirname, 'fixtures/live', name), 'utf8');
  const eventRows = JSON.parse(live('sktech_app_events.json'));
  const PRO = {
    'pro/U2VyaWUgQS1BdGFsYW50YS12cy1JbnRlcjE3OTUzMjQ3MjI1MDU.txt': live('sktech_app_pro_atalanta.txt'),
    'pro/TkJBLVV0YWggSmF6ei12cy1EYWxsYXMgTWF2ZXJpY2tzMTc5NTI5MTEwNjcyMw.txt': live('sktech_app_pro_utah.txt'),
  };
  const API = 'https://backend.example/';
  const ATALANTA = Object.keys(PRO)[0];
  const UTAH = Object.keys(PRO)[1];

  /** Inverse of decryptPrimary, to serve the decoded fixture rows the way the backend does. */
  function encryptPrimary(value) {
    const cipher = crypto.createCipheriv('aes-128-cbc', 'l2l5kB7xC5qP1rK1', 'p1K5nP7uB8hH1l19');
    const inner = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]).toString('base64');
    const outer = Buffer.from([...inner].reverse().join('')).toString('base64').replace(/=+$/, '');
    const plain = 'aAbBcCdDeEfFgGhHiIjJkKlLmMnNoOpPqQrRsStTuUvVwWxXyYzZ';
    const subst = 'fFgGjJkKaApPbBmMoOzZeEnNcCdDrRqQtTvVuUxXhHiIwWyYlLsS';
    return [...outer].map((ch) => (plain.includes(ch) ? subst[plain.indexOf(ch)] : ch)).join('');
  }

  function makeProvider({ embedIndia, rows = eventRows, feed = '#EXTM3U\n', proxyFetch } = {}) {
    const p = new SkTechProvider(makeCradle({ embedIndiaProvider: embedIndia }));
    p.fetchFeed = { fire: async () => feed };
    p.fetchRemoteConfig = { fire: async () => ({ api_url: API }) };
    p.fetchBackend = {
      fire: async (url) => {
        if (url === `${API}events.txt`) return encryptPrimary(rows);
        const rel = url.slice(API.length);
        if (PRO[rel]) return PRO[rel];
        throw new Error('HTTP 404');
      },
    };
    if (proxyFetch) p.proxyFetch = proxyFetch;
    return p;
  }

  beforeEach(() => setSystemTime(new Date('2026-11-22T19:00:00Z')));
  afterEach(() => setSystemTime());

  test('decryptPrimary reads a captured backend payload', () => {
    const channels = JSON.parse(decryptPrimary(PRO[ATALANTA]));
    expect(channels).toHaveLength(4);
    expect(channels[0].link).toContain('cenc.mpd');
    expect(channels[0].api).toMatch(/^[0-9a-f]{32}:[0-9a-f]{32}$/);
  });

  test('the backend host comes from Remote Config, is cached, and falls back when Remote Config fails', async () => {
    const p = makeProvider();
    let calls = 0;
    p.fetchRemoteConfig = { fire: async () => { calls += 1; return { api_url: 'https://cfg.example' }; } };
    expect(await p.getApiHost()).toBe('https://cfg.example/');
    await p.getApiHost();
    expect(calls).toBe(1);

    const failing = makeProvider();
    failing.fetchRemoteConfig = { fire: async () => { throw new Error('HTTP 429'); } };
    expect(await failing.getApiHost()).toMatch(/^https:\/\/.+\/$/);
  });

  test('events become matches with UTC kickoff, status and the visible/finished filters applied', async () => {
    const matches = await makeProvider().getMatches();
    expect(matches.map((m) => m.title)).toEqual(['Atalanta vs Inter', 'Utah Jazz vs Dallas Mavericks', 'New Zealand vs India']);

    const atalanta = matches[0];
    expect(atalanta.date).toBe(String(Date.UTC(2026, 10, 22, 19, 45)));
    expect(atalanta.status).toBe('upcoming');
    expect(atalanta.category).toBe('football');
    expect(atalanta.team1.name).toBe('Atalanta');
    expect(matches[1].category).toBe('basketball');
    expect(atalanta.sources.map((s) => s.id)).toEqual([0, 1, 2, 3].map((i) => `${ATALANTA}#${i}`));
    expect(atalanta.sources[0]).toMatchObject({ source: 'sktech', linksPath: ATALANTA, streamIndex: 0, channelName: 'TNT SPORTS' });

    setSystemTime(new Date('2026-11-22T20:30:00Z'));
    const later = await makeProvider().getMatches();
    expect(later[0].status).toBe('live');

    setSystemTime(new Date('2026-11-22T22:40:00Z'));
    expect((await makeProvider().getMatches()).map((m) => m.title)).not.toContain('Atalanta vs Inter');
  });

  test('a backend event shares its match with a playlist feed fixture of the same title', async () => {
    const feed = '#EXTM3U\n#EXTINF:-1 tvg-id="5" tvg-name="Atalanta vs Inter" group-title="Football",Atalanta vs Inter\nhttps://cdn.example/a.m3u8\n';
    const matches = await makeProvider({ feed }).getMatches();
    const atalanta = matches.filter((m) => m.title === 'Atalanta vs Inter');
    expect(atalanta).toHaveLength(1);
    expect(atalanta[0].sources.filter((s) => s.linksPath)).toHaveLength(4);
    expect(atalanta[0].sources.filter((s) => s.streamUrl).map((s) => s.feed)).toEqual(['FanCode', 'Sony LIV']);
  });

  test('the playlist feeds still work when the backend is down', async () => {
    const p = makeProvider({ feed: '#EXTM3U\n#EXTINF:-1 tvg-id="7" tvg-name="India vs Australia" group-title="Cricket",India vs Australia\nhttps://cdn.example/a.m3u8' });
    p.fetchBackend = { fire: async () => { throw new Error('HTTP 503'); } };
    expect((await p.getMatches()).map((m) => m.title)).toEqual(['India vs Australia']);
  });

  test('a ClearKey DASH channel becomes a signed /api/dash stream labeled with the channel', async () => {
    const p = makeProvider();
    const [match] = await p.getMatches();
    const [stream] = await p.resolveStream(match.sources[0].id, 'football', match.title, match.sources[0]);

    const u = new URL(stream.url);
    expect(u.pathname).toBe('/api/dash/index.m3u8');
    const verified = verifyPayload(u.searchParams.get('d'));
    expect(verified.payload.mpdUrl).toContain('/rhf2dwosdt/');
    expect(verified.payload).toMatchObject({ key: 'd02feac8a999bd06bf4059bf33411749', kid: '69a5aa835a061ce64a630d1046727e40' });
    expect(stream.title).toBe('Atalanta vs Inter (TNT SPORTS)');
    expect(stream.behaviorHints.notWebReady).toBe(true);
  });

  test('a plain HLS channel is proxied with the referer from its link', async () => {
    const p = makeProvider();
    const [stream] = await p.resolveStream(`${UTAH}#0`, 'basketball', 'Utah Jazz vs Dallas Mavericks', { linksPath: UTAH, streamIndex: 0, channelName: 'SK LIVE' });
    const q = new URL(stream.url).searchParams;
    expect(new URL(stream.url).pathname).toBe('/api/manifest');
    expect(q.get('url')).toBe('https://chatgpt.hereisman.net/playlist//load-playlist-multi?.m3u8');
    expect(q.get('referer')).toBe('https://gooz.aapmains.net');
    expect(stream.title).toBe('Utah Jazz vs Dallas Mavericks (SK LIVE)');
  });

  test('an embedindia tokenApi channel resolves through EmbedIndia with renewal', async () => {
    const extracted = [];
    const embedIndia = {
      isEmbedUrl: (url) => /taifood-blog\.asia\/embed\//.test(url),
      extractM3u8: async (url) => { extracted.push(url); return { m3u8: 'https://cdn.example/live/index.m3u8?t=1', referer: 'https://taifood-blog.asia/' }; },
    };
    const p = makeProvider({ embedIndia });
    const [stream] = await p.resolveStream(`${UTAH}#1`, 'basketball', 'Utah Jazz vs Dallas Mavericks', { linksPath: UTAH, streamIndex: 1, channelName: 'SD SERVER' });
    expect(extracted).toEqual(['https://taifood-blog.asia/embed/nba/2026-11-22/dal-utah_540p']);
    const q = new URL(stream.url).searchParams;
    expect(q.get('renew')).toBe('embedindia');
    expect(q.get('embed')).toBe(extracted[0]);
  });

  test('a generic tokenApi channel resolves a Clappr player or a JSON link_key to a proxied stream', async () => {
    const p = makeProvider();
    const call = async (body) => {
      p.proxyFetch = async () => ({ ok: true, status: 200, text: async () => body });
      return p._resolveTokenApiRow({ api: 'https://page.example/x.php?c=1', link_key: 'playback_url' }, 'T', 'FOX');
    };

    const clappr = '<script>player.load({source: src()});function src(){return ["https:\\/\\/cdn.example\\/live","index.m3u8?k=1"].join("/");}</script>';
    const [fromClappr] = await call(clappr);
    expect(new URL(fromClappr.url).searchParams.get('url')).toBe('https://cdn.example/live/index.m3u8?k=1');
    expect(new URL(fromClappr.url).searchParams.get('referer')).toBe('https://page.example/x.php?c=1');

    const [fromJson] = await call(JSON.stringify({ playback_url: 'https://cdn.example/j.m3u8' }));
    expect(new URL(fromJson.url).searchParams.get('url')).toBe('https://cdn.example/j.m3u8');

    expect(await call('<html>nothing</html>')).toEqual([]);
  });

  test('missing channels, a dead channel list and DASH without a key yield no stream', async () => {
    const p = makeProvider();
    expect(await p.resolveStream('x', 'a', 'T', { linksPath: UTAH, streamIndex: 9, channelName: 'nope' })).toEqual([]);
    expect(await p.resolveStream('x', 'a', 'T', { linksPath: 'pro/missing.txt', streamIndex: 0 })).toEqual([]);

    const keyless = encryptPrimary([{ name: 'CH', link: 'https://cdn.example/a.mpd', api: '' }]);
    p.fetchBackend = { fire: async () => keyless };
    expect(await p.resolveStream('x', 'a', 'T', { linksPath: 'pro/k.txt', streamIndex: 0 })).toEqual([]);
  });

  test('extractClapprUrl ignores pages without a Clappr source', () => {
    expect(SkTechProvider.extractClapprUrl('<html></html>')).toBeNull();
  });
});
