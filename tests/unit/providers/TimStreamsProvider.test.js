const { describe, it, expect, beforeEach, afterEach, setSystemTime } = require('bun:test');
const TimStreamsProvider = require('../../../src/providers/TimStreamsProvider');
const { makeCradle, res } = require('./fixtures/helpers');
const { BASE_URL } = require('../../../src/config');

const NOW = new Date('2026-03-01T18:00:00Z');

/** Encode plaintext the way TimStreams embed pages do. */
function obfuscate(text, xor, sub) {
  const arr = [...text].map((c) => ((c.charCodeAt(0) + sub) % 256) ^ xor);
  return `<html><script>
var _so7 = [${arr.join(',')}];
var _bw9 = ${xor}; var _jr2 = ${sub};
var out = ''; for (var _ix3 = 0; _ix3 < _so7.length; _ix3++) { out += String.fromCharCode(((_so7[_ix3]^_bw9)-_jr2+256)%256); }
</script></html>`;
}

function makeProvider({ data, pages = {} } = {}) {
  const p = new TimStreamsProvider(makeCradle());
  p.proxyFetch = async (url, opts) => {
    p._calls = p._calls || [];
    p._calls.push({ url, opts });
    if (url === p.apiUrl) return res({ json: data });
    if (url in pages) return res({ body: pages[url] });
    return res({ status: 404, body: '' });
  };
  return p;
}

const hex = (s) => Buffer.from(s).toString('hex');

describe('TimStreamsProvider.getMatches', () => {
  beforeEach(() => setSystemTime(NOW));
  afterEach(() => setSystemTime());

  const data = {
    genres: { 3: { name: 'Ice Hockey' }, 4: 'Soccer' },
    events: [
      { url: 'e1', name: 'Rangers vs Bruins', genre: 3, time: '2026-03-01 12:30:00', logo: 'https://l/1.png', streams: [{ name: 'HD', url: 'https://logic.icelanders.st/embed/a' }, { name: 'VIP', url: 'https://x/vip', vip: true }] },
      { url: 'e2', name: 'Arsenal vs Chelsea', genre: 4, time: '2026-03-01 16:00:00', streams: [{ name: 'EN', url: 'https://logic.icelanders.st/embed/b' }] },
      { url: 'e3', name: 'VIP only', genre: 4, time: '2026-03-01 16:00:00', streams: [{ name: 'VIP', url: 'https://x/v', vip: true }] },
    ],
  };

  it('maps genre ids through both genre map shapes', async () => {
    const matches = await makeProvider({ data }).getMatches();
    expect(matches.map((m) => m.category)).toEqual(['hockey', 'football']);
  });

  it('parses event times as America/New_York wall clock', async () => {
    const [m] = await makeProvider({ data }).getMatches();
    expect(m.date).toBe(String(Date.UTC(2026, 2, 1, 17, 30, 0)));
  });

  it('flags an event inside the four-hour live window as popular', async () => {
    const [hockey, soccer] = await makeProvider({ data }).getMatches();
    expect(hockey.popular).toBe('1');
    expect(soccer.popular).toBe('0');
  });

  it('drops the live flag once the event is older than four hours', async () => {
    const old = { genres: {}, events: [{ url: 'e', name: 'Old', time: '2026-03-01 08:00:00', streams: [{ name: 'A', url: 'https://x/a' }] }] };
    const [m] = await makeProvider({ data: old }).getMatches();
    expect(m.popular).toBe('0');
  });

  it('excludes vip streams and omits events left with no source', async () => {
    const matches = await makeProvider({ data }).getMatches();
    expect(matches.map((m) => m.id)).toEqual(['ts_e1', 'ts_e2']);
    expect(matches[0].sources).toHaveLength(1);
    expect(matches[0].sources[0].id).toBe(hex('https://logic.icelanders.st/embed/a'));
    expect(matches[0].sources[0].name).toBe('HD');
  });

  it('supports the array genre shape and falls back to other', async () => {
    const arrData = { genres: [{ id: 9, name: 'Basketball' }], events: [
      { url: 'a', name: 'A', genre: 9, streams: [{ url: 'https://x/a' }] },
      { url: 'b', name: 'B', genre: 77, streams: [{ url: 'https://x/b' }] },
    ] };
    const matches = await makeProvider({ data: arrData }).getMatches();
    expect(matches.map((m) => m.category)).toEqual(['basketball', 'other']);
  });

  it('returns [] when events is missing or the fetch fails', async () => {
    expect(await makeProvider({ data: { genres: {} } }).getMatches()).toEqual([]);
    const p = makeProvider({ data: {} });
    p.proxyFetch = async () => res({ status: 500, body: '' });
    expect(await p.getMatches()).toEqual([]);
  });
});

describe('TimStreamsProvider.decodeObfuscatedScript', () => {
  const p = new TimStreamsProvider(makeCradle());

  it('reverses the xor/offset encoding', () => {
    const html = obfuscate('var file="https://edge.ts/live/a.m3u8";', 55, 13);
    expect(p.decodeObfuscatedScript(html)).toBe('var file="https://edge.ts/live/a.m3u8";');
  });

  it('handles the &255 loop variant and different key values', () => {
    const html = obfuscate('x.m3u8', 200, 91).replace('%256)', '&255)');
    expect(p.decodeObfuscatedScript(html)).toBe('x.m3u8');
  });

  it('returns null when the array, loop or key constants are missing', () => {
    expect(p.decodeObfuscatedScript('<html>nothing</html>')).toBeNull();
    expect(p.decodeObfuscatedScript('<script>var a = [1,2,3];</script>')).toBeNull();
    const noKeys = obfuscate('abc', 55, 13).replace('var _bw9 = 55;', '');
    expect(p.decodeObfuscatedScript(noKeys)).toBeNull();
  });
});

describe('TimStreamsProvider.extractM3u8', () => {
  it('pulls the signed url out of the decoded payload and reports the embed origin', async () => {
    const pages = { 'https://logic.icelanders.st/embed/a': obfuscate(`jwplayer().setup({file:"https://edge.ts/live/a.m3u8?t=9"});`, 55, 13) };
    const p = makeProvider({ pages });
    expect(await p.extractM3u8('https://logic.icelanders.st/embed/a')).toEqual({
      m3u8: 'https://edge.ts/live/a.m3u8?t=9',
      referer: 'https://logic.icelanders.st',
    });
    expect(p._calls[0].opts.headers.Referer).toBe('https://timst.cfd/');
  });

  it('returns null on a non-2xx page, an undecodable page and a payload without an m3u8', async () => {
    const p = makeProvider({ pages: { 'https://e/b': '<html>plain</html>', 'https://e/c': obfuscate('no url here', 55, 13) } });
    expect(await p.extractM3u8('https://e/missing')).toBeNull();
    expect(await p.extractM3u8('https://e/b')).toBeNull();
    expect(await p.extractM3u8('https://e/c')).toBeNull();
  });
});

describe('TimStreamsProvider.resolveStream', () => {
  beforeEach(() => setSystemTime(NOW));
  afterEach(() => setSystemTime());

  it('decodes a hex source id into the embed url and proxies the extracted manifest', async () => {
    const embed = 'https://logic.icelanders.st/embed/a';
    const pages = { [embed]: obfuscate('file: "https://edge.ts/live/a.m3u8"', 55, 13) };
    const streams = await makeProvider({ pages }).resolveStream(hex(embed), 'football', 'A vs B');
    expect(streams).toHaveLength(2);
    expect(streams[0].url).toBe(`${BASE_URL}/api/manifest?url=${encodeURIComponent('https://edge.ts/live/a.m3u8')}&referer=${encodeURIComponent('https://logic.icelanders.st')}&origin=${encodeURIComponent('https://logic.icelanders.st')}&renew=timstreams&embed=${encodeURIComponent(embed)}`);
    expect(streams[1].externalUrl).toBe(`/watch?url=${encodeURIComponent(embed)}&title=A%20vs%20B`);
  });

  it('offers only the web fallback when extraction fails', async () => {
    const embed = 'https://logic.icelanders.st/embed/a';
    const streams = await makeProvider({ pages: {} }).resolveStream(hex(embed), 'football', 'A vs B');
    expect(streams).toHaveLength(1);
    expect(streams[0].name).toBe('Nuvio Web Player');
  });

  it('looks the source up in the catalogue when the id is not a hex url', async () => {
    const data = { genres: {}, events: [{ url: 'e1', name: 'A vs B', time: '2026-03-01 12:30:00', streams: [{ name: 'HD', url: 'https://logic.icelanders.st/embed/a' }] }] };
    const p = makeProvider({ data, pages: {} });
    const streams = await p.resolveStream('ts_e1_unknown', 'football', 'A vs B');
    expect(streams[0].externalUrl).toBe(`/watch?url=${encodeURIComponent('https://logic.icelanders.st/embed/ts_e1_unknown')}&title=A%20vs%20B`);
  });

  it('resolves every non-vip source of a match addressed by its event id', async () => {
    const data = { genres: {}, events: [{ url: 'e1', name: 'A vs B', time: '2026-03-01 12:30:00', streams: [{ name: 'HD', url: 'https://a/1' }, { name: 'SD', url: 'https://a/2' }] }] };
    const p = makeProvider({ data, pages: {} });
    const streams = await p.resolveStream('e1', 'football', 'A vs B');
    expect(streams.map((s) => s.title)).toEqual(['TimStreams (HD) (Web)', 'TimStreams (SD) (Web)']);
  });
});
