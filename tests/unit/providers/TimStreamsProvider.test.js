const { describe, test, expect, mock, afterEach } = require('bun:test');

// TimStreams provider suite. The feed shape is a capture of
// https://tim-streams.com/api/live-upcoming (2026-11-22); the embed page and
// ticket are rebuilt with the site's real encodings (XOR/subtract number array,
// rolling-key XOR ticket). The network seams are the provider's own proxyFetch
// and the global fetch used for the binary ticket and segment probe.

const TimStreamsProvider = require('../../../src/providers/TimStreamsProvider');
const CircuitBreakerService = require('../../../src/services/CircuitBreakerService');
const { pngSegment, tsBytes } = require('./fixtures/pngSegment');

/** 2026-11-22T13:12 US Eastern. */
const NOW = Date.UTC(2026, 10, 22, 18, 12, 0);

const GENRES = [
  { id: 1, name: 'Soccer', sub_categories: [{ id: 4, name: 'Ligue One', featured: true }] },
  { id: 8, name: 'American Football', sub_categories: [{ id: 1, name: 'NFL', featured: true }] },
];

const FEED = {
  genres: GENRES,
  events: [
    {
      url: 'stade-rennais-v-lorient-401876401',
      name: 'Stade Rennais @ Lorient',
      logo: '/img/ligue1-401876401.png',
      genre: 1,
      sub_genre: 4,
      time: '2026-11-22T11:15',
      isevent: true,
      vip: false,
      viewers: 0,
      streams: [
        { name: 'beIN Sports Connect 5 (USA)', url: 'https://shoewiki.click/8a9rv4ba-6687', vip: false },
        { name: 'VIP feed', url: 'https://shoewiki.click/vipvipvi-0001', vip: true },
        { name: 'DAZN France', url: 'https://shoewiki.click/ul4qm7pi-3616', vip: false },
      ],
    },
    {
      url: 'nfl-redzone-week-11',
      name: 'NFL Redzone: WEEK 11',
      logo: 'https://www.secv.com/images/header_redzone_2024.jpg',
      genre: 8,
      sub_genre: 1,
      time: '2026-11-22T13:00',
      isevent: true,
      vip: false,
      featured: true,
      viewers: 0,
      streams: [{ name: 'NFL Redzone', url: 'https://shoewiki.click/3agka6w8-6060', vip: false }],
    },
    {
      url: 'dolphins-v-chargers-401873099',
      name: 'Dolphins @ Chargers',
      genre: 8,
      sub_genre: 1,
      time: '2026-11-22T16:25',
      vip: false,
      streams: [{ name: 'NFL Game Pass on DAZN', url: 'https://shoewiki.click/odvlrpit-3695', vip: false }],
    },
    {
      url: 'old-game-1',
      name: 'Finished Game',
      genre: 8,
      time: '2026-11-21T20:00',
      vip: false,
      streams: [{ name: 'Feed', url: 'https://shoewiki.click/aaaaaaaa-0001', vip: false }],
    },
    {
      url: 'vip-only-1',
      name: 'VIP Only',
      genre: 8,
      time: '2026-11-22T13:00',
      vip: true,
      streams: [{ name: 'Feed', url: 'https://shoewiki.click/aaaaaaaa-0002', vip: true }],
    },
  ],
};

const TICKET_URL = 'https://tims-001.servehttp.com/p/1ed7e986ebf0e34387b79770c62cbbf7';
const M3U8 = 'https://tims-001.servehttp.com/main/secure/4b6ecb703c22d474/1795380248/beinconnect5-usa.m3u8';

/** Inverse of the page's `((n ^ xor) - sub) mod 256` decoder. */
function obfuscate(text, xor, sub) {
  return Array.from(text, (ch) => ((ch.charCodeAt(0) + sub) % 256) ^ xor).join(',');
}

/** Embed page in the shape served by shoewiki.click: encoded array, constants, decoding loop. */
function embedPage(script) {
  const body = obfuscate(script, 167, 13);
  return `<!DOCTYPE html><html><head><title>Player</title></head><body>
<script>(function(){var _ub1=[${body}],_gd3=167,_uo7=13,_hm7="",_jh0;for(_jh0=0;_jh0<_ub1.length;_jh0++){_hm7+=String.fromCharCode(((_ub1[_jh0]^_gd3)-_uo7+256)%256);}window["ev"+"al"](_hm7);})();</script>
</body></html>`;
}

const PLAYER_SCRIPT = `(function () {\n  var CFG = {"ticketUrl":"${TICKET_URL}","autoplay":false,"debug":false};\n  var DEBUG = CFG.debug;\n})();`.padEnd(120, ' ');

/** Inverse of decryptTicket. */
function encryptTicket(plain, ticketUrl, seed = 77) {
  const key = ticketUrl.substring(ticketUrl.lastIndexOf('/') + 1);
  const out = Buffer.alloc(plain.length + 1);
  out[0] = seed;
  for (let i = 1; i <= plain.length; i++) {
    out[i] = plain.charCodeAt(i - 1) ^ key.charCodeAt((i - 1) % key.length) ^ ((seed + i - 1) & 255);
  }
  return out;
}

function makeProvider() {
  const provider = new TimStreamsProvider({ circuitBreaker: new CircuitBreakerService() });
  provider.fetchEvents = { fire: async () => FEED };
  return provider;
}

const realNow = Date.now;
const realFetch = globalThis.fetch;
afterEach(() => {
  Date.now = realNow;
  globalThis.fetch = realFetch;
});

describe('TimStreamsProvider.getMatches', () => {
  test('maps live and upcoming events, dropping finished and VIP-only ones', async () => {
    Date.now = () => NOW;
    const matches = await makeProvider().getMatches();

    expect(matches.map((m) => m.title)).toEqual([
      'Stade Rennais @ Lorient',
      'NFL Redzone: WEEK 11',
      'Dolphins @ Chargers',
    ]);
    expect(matches.map((m) => m.status)).toEqual(['live', 'live', 'upcoming']);
    expect(matches.map((m) => m.category)).toEqual(['football', 'american_football', 'american_football']);
  });

  test('reads kickoff as US Eastern wall-clock time', async () => {
    Date.now = () => NOW;
    const matches = await makeProvider().getMatches();
    expect(matches[0].date).toBe(String(Date.UTC(2026, 10, 22, 16, 15)));
    expect(matches[1].date).toBe(String(Date.UTC(2026, 10, 22, 18, 0)));
  });

  test('keeps one source per non-VIP stream with its broadcaster label and embed URL', async () => {
    Date.now = () => NOW;
    const [first] = await makeProvider().getMatches();

    expect(first.id).toBe('ts_stade-rennais-v-lorient-401876401');
    expect(first.sources).toEqual([
      { source: 'timstreams', id: '8a9rv4ba-6687', channelName: 'beIN Sports Connect 5 USA', url: 'https://shoewiki.click/8a9rv4ba-6687' },
      { source: 'timstreams', id: 'ul4qm7pi-3616', channelName: 'DAZN France', url: 'https://shoewiki.click/ul4qm7pi-3616' },
    ]);
  });

  test('marks only live featured events popular and absolutizes relative logos', async () => {
    Date.now = () => NOW;
    const matches = await makeProvider().getMatches();
    expect(matches.map((m) => m.popular)).toEqual(['0', '1', '0']);
    expect(matches[0].poster).toBe('https://tim-streams.com/img/ligue1-401876401.png');
    expect(matches[1].poster).toBe('https://www.secv.com/images/header_redzone_2024.jpg');
  });

  test('returns no matches when the feed has no events array', async () => {
    const provider = makeProvider();
    provider.fetchEvents = { fire: async () => ({}) };
    expect(await provider.getMatches()).toEqual([]);
  });

  test('returns no matches when the feed request fails', async () => {
    const provider = makeProvider();
    provider.fetchEvents = { fire: async () => { throw new Error('HTTP error! status: 502'); } };
    expect(await provider.getMatches()).toEqual([]);
  });
});

describe('TimStreamsProvider stream extraction', () => {
  test('decodes the obfuscated embed script', () => {
    const decoded = TimStreamsProvider.decodeObfuscatedScript(embedPage(PLAYER_SCRIPT));
    expect(decoded).toBe(PLAYER_SCRIPT);
  });

  test('returns null for a page without the encoded script', () => {
    expect(TimStreamsProvider.decodeObfuscatedScript('<html>nothing</html>')).toBeNull();
  });

  test('decrypts a ticket body into the signed manifest URL', () => {
    const body = encryptTicket(M3U8, TICKET_URL);
    expect(TimStreamsProvider.decryptTicket(body, TICKET_URL)).toBe(M3U8);
  });

  test('extractM3u8 follows the ticket URL and returns the manifest with its referer', async () => {
    const provider = makeProvider();
    provider.proxyFetch = mock(async () => ({ ok: true, text: async () => embedPage(PLAYER_SCRIPT) }));
    const fetchMock = mock(async () => ({ ok: true, arrayBuffer: async () => encryptTicket(M3U8, TICKET_URL) }));
    globalThis.fetch = fetchMock;

    const result = await provider.extractM3u8('https://shoewiki.click/8a9rv4ba-6687');

    expect(result).toEqual({ m3u8: M3U8, referer: 'https://shoewiki.click/' });
    expect(fetchMock.mock.calls[0][0]).toBe(TICKET_URL);
  });

  test('extractM3u8 returns null when the embed page has no player script', async () => {
    const provider = makeProvider();
    provider.proxyFetch = mock(async () => ({ ok: true, text: async () => '<html></html>' }));
    expect(await provider.extractM3u8('https://shoewiki.click/x')).toBeNull();
  });

  test('extractM3u8 returns null when the ticket is gone', async () => {
    const provider = makeProvider();
    provider.proxyFetch = mock(async () => ({ ok: true, text: async () => embedPage(PLAYER_SCRIPT) }));
    globalThis.fetch = mock(async () => ({ ok: false, status: 404 }));
    expect(await provider.extractM3u8('https://shoewiki.click/x')).toBeNull();
  });
});

describe('TimStreamsProvider.resolveStream', () => {
  const src = { source: 'timstreams', id: '8a9rv4ba-6687', channelName: 'beIN Sports USA', url: 'https://shoewiki.click/8a9rv4ba-6687' };

  test('returns a renewable proxied manifest when segments are plain MPEG-TS', async () => {
    const provider = makeProvider();
    provider.extractM3u8 = mock(async () => ({ m3u8: M3U8, referer: 'https://shoewiki.click/' }));
    provider.segmentFormat = mock(async () => 'ts');

    const streams = await provider.resolveStream(src.id, 'football', 'Stade Rennais @ Lorient', src);

    expect(streams).toHaveLength(1);
    expect(streams[0].title).toBe('Stade Rennais @ Lorient (beIN Sports USA)');
    const url = new URL(streams[0].url);
    expect(url.pathname).toBe('/api/manifest');
    expect(url.searchParams.get('url')).toBe(M3U8);
    expect(url.searchParams.get('referer')).toBe('https://shoewiki.click/');
    expect(url.searchParams.get('renew')).toBe('timstreams');
    expect(url.searchParams.get('embed')).toBe(src.url);
    expect(streams[0].behaviorHints.notWebReady).toBe(true);
  });

  test('flags the manifest URL for segment decoding when segments are PNG-wrapped', async () => {
    const provider = makeProvider();
    provider.extractM3u8 = mock(async () => ({ m3u8: M3U8, referer: 'https://shoewiki.click/' }));
    provider.segmentFormat = mock(async () => 'png');

    const streams = await provider.resolveStream(src.id, 'football', 'Stade Rennais @ Lorient', src);

    expect(streams).toHaveLength(1);
    const url = new URL(streams[0].url);
    expect(url.pathname).toBe('/api/manifest');
    expect(url.searchParams.get('seg')).toBe('1');
    expect(url.searchParams.get('renew')).toBe('timstreams');
  });

  test('does not flag plain MPEG-TS streams for decoding', async () => {
    const provider = makeProvider();
    provider.extractM3u8 = mock(async () => ({ m3u8: M3U8, referer: 'https://shoewiki.click/' }));
    provider.segmentFormat = mock(async () => 'ts');
    const [row] = await provider.resolveStream(src.id, 'football', 'Match', src);
    expect(new URL(row.url).searchParams.get('seg')).toBeNull();
  });

  test('falls back to the embed web player when no segment is readable', async () => {
    const provider = makeProvider();
    provider.extractM3u8 = mock(async () => ({ m3u8: M3U8, referer: 'https://shoewiki.click/' }));
    provider.segmentFormat = mock(async () => null);

    const streams = await provider.resolveStream(src.id, 'football', 'Stade Rennais @ Lorient', src);

    expect(streams).toHaveLength(1);
    expect(streams[0].url).toBeUndefined();
    expect(streams[0].externalUrl).toContain(`/watch?url=${encodeURIComponent(src.url)}`);
  });

  test('falls back to the web player when extraction throws', async () => {
    const provider = makeProvider();
    provider.extractM3u8 = mock(async () => { throw new Error('timeout'); });

    const streams = await provider.resolveStream(src.id, 'football', 'Match', src);

    expect(streams).toHaveLength(1);
    expect(streams[0].externalUrl).toContain('/watch?url=');
  });

  test('returns nothing for a source without an embed URL', async () => {
    expect(await makeProvider().resolveStream('x', 'football', 'Match', {})).toEqual([]);
  });

  test('segmentFormat tells PNG-wrapped segments from plain TS', async () => {
    const provider = makeProvider();
    const playlist = '#EXTM3U\n#EXTINF:4,\nhttps://cdn.example/seg1\n';
    provider.proxyFetch = mock(async () => ({ ok: true, text: async () => playlist }));

    const ts = Buffer.alloc(1024);
    for (const i of [0, 188, 376, 564]) ts[i] = 0x47;
    globalThis.fetch = mock(async () => ({ ok: true, arrayBuffer: async () => ts }));
    expect(await provider.segmentFormat(M3U8, 'https://shoewiki.click/')).toBe('ts');

    const png = pngSegment(Buffer.concat([Buffer.from('KWP1'), Buffer.from([0, 0, 7, 0x58]), tsBytes(10)]));
    globalThis.fetch = mock(async () => ({ ok: true, arrayBuffer: async () => png }));
    expect(await provider.segmentFormat(M3U8, 'https://shoewiki.click/')).toBe('png');

    globalThis.fetch = mock(async () => ({ ok: true, arrayBuffer: async () => Buffer.alloc(1024) }));
    expect(await provider.segmentFormat(M3U8, 'https://shoewiki.click/')).toBeNull();
  });
});
