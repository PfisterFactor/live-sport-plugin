const { describe, it, expect, beforeEach, afterEach, afterAll } = require('bun:test');
const impitClient = require('../../../src/impitClient');
const StreamFreeProvider = require('../../../src/providers/StreamFreeProvider');
const { makeCradle, res } = require('./fixtures/helpers');
const { BASE_URL } = require('../../../src/config');

const realSafeFetch = impitClient.safeFetch;
const noStatus = async () => ({ ok: false, status: 500, text: async () => '', json: async () => ({}) });
let statusImpl = noStatus;
impitClient.safeFetch = (url, opts) => statusImpl(url, opts);

afterAll(() => { impitClient.safeFetch = realSafeFetch; });
function tokenHtml(tokens) {
  return `<html><script>const _0x = ${JSON.stringify(tokens)};\nplay(_0x);</script></html>`;
}

function makeProvider({ list, embeds = {}, streamKey } = {}) {
  const p = new StreamFreeProvider(makeCradle());
  p.proxyFetch = async (url) => {
    if (url === p.apiUrl) return res({ json: list });
    if (url.startsWith('https://streamfree.top/get-stream-key/')) {
      return streamKey ? res({ json: streamKey }) : res({ status: 500, body: '' });
    }
    if (url in embeds) return res({ body: embeds[url] });
    return res({ status: 404, body: '' });
  };
  return p;
}

describe('StreamFreeProvider.normalizeCategory', () => {
  const p = new StreamFreeProvider(makeCradle());
  it('reads the upstream "football" bucket as american football', () => {
    expect(p.normalizeCategory('football')).toBe('american_football');
    expect(p.normalizeCategory('Football')).toBe('american_football');
  });
  it('still maps soccer to football and other sports via the base rules', () => {
    expect(p.normalizeCategory('soccer')).toBe('football');
    expect(p.normalizeCategory('basketball')).toBe('basketball');
  });
});

describe('StreamFreeProvider.getMatches', () => {
  it('flattens the category map into sf_ prefixed matches', async () => {
    const list = {
      streams: {
        football: [{ stream_key: 'nfl1', name: 'Chiefs vs Bills', match_timestamp: 1772366400, viewers: 500, league: 'NFL', team1: 'Chiefs', team2: 'Bills' }],
        soccer: [{ id: 'sc1', name: 'Arsenal vs Chelsea', match_timestamp: 1772370000, viewers: 12 }, { name: 'no id' }],
      },
    };
    const matches = await makeProvider({ list }).getMatches();
    expect(matches.map((m) => m.id)).toEqual(['sf_nfl1', 'sf_sc1']);
    expect(matches[0].category).toBe('american_football');
    expect(matches[0].date).toBe('1772366400000');
    expect(matches[0].popular).toBe('1');
    expect(matches[0].sources).toEqual([{ source: 'streamfree', id: 'nfl1', original_category: 'football' }]);
    expect(matches[1].category).toBe('football');
    expect(matches[1].popular).toBe('0');
  });

  it('returns [] for an empty or failing payload', async () => {
    expect(await makeProvider({ list: {} }).getMatches()).toEqual([]);
    const p = makeProvider({ list: {} });
    p.proxyFetch = async () => res({ status: 502, body: '' });
    expect(await p.getMatches()).toEqual([]);
  });
});

describe('StreamFreeProvider.resolveStream', () => {
  beforeEach(() => {
    statusImpl = async () => ({ ok: false, status: 500, text: async () => '', json: async () => ({}) });
  });
  afterEach(() => {
    statusImpl = async () => ({ ok: false, status: 500, text: async () => '', json: async () => ({}) });
  });

  const tokens = {
    '720p': { _t: 't7', _e: 'e7', _n: 'n7' },
    '1080p': { _t: 't10', _e: 'e10', _n: 'n10' },
    '480p': { _t: null },
  };

  it('builds one stream per available source using each source suffix', async () => {
    statusImpl = async () => ({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ sources: { 1: { available: true, qualities: { '720p': true } }, 2: { available: true, qualities: {} }, 3: { available: false } } }),
    });
    const embeds = {
      'https://streamfree.top/embed/football/nfl1': tokenHtml(tokens),
      'https://streamfree.top/embed/football/nfl12': tokenHtml(tokens),
    };
    const streams = await makeProvider({ embeds, streamKey: { server_name: 'origin' } }).resolveStream('nfl1', 'football', 'x');
    expect(streams.map((s) => s.title)).toEqual(['StreamFree (720p)', 'StreamFree S2 (1080p)']);
    expect(streams[0].resolution).toBe('720p');
    const target = decodeURIComponent(streams[0].url.split('url=')[1].split('&referer')[0]);
    expect(target).toBe('https://streamfree.top/live-origin/nfl1720p/index.m3u8?_t=t7&_e=e7&_n=n7');
    const target2 = decodeURIComponent(streams[1].url.split('url=')[1].split('&referer')[0]);
    expect(target2).toBe('https://streamfree.top/live-origin/nfl11080p2/index.m3u8?_t=t10&_e=e10&_n=n10');
    expect(streams[0].url.startsWith(`${BASE_URL}/api/manifest?`)).toBe(true);
  });

  it('falls back to source 1 when stream-status is unavailable and picks the highest quality', async () => {
    const embeds = { 'https://streamfree.top/embed/soccer/sc1': tokenHtml(tokens) };
    const [s] = await makeProvider({ embeds, streamKey: { server_name: 'origin' } }).resolveStream('sc1', 'soccer', 'x');
    expect(s.title).toBe('StreamFree (1080p)');
  });

  it('uses the CDN path when the stream key names a non-origin server', async () => {
    const embeds = { 'https://streamfree.top/embed/soccer/sc1': tokenHtml(tokens) };
    const [s] = await makeProvider({ embeds, streamKey: { server_name: 'edge7' } }).resolveStream('sc1', 'soccer', 'x');
    expect(decodeURIComponent(s.url)).toContain('https://streamfree.top/live-cdn/sc11080p/index.m3u8');
  });

  it('prefers an external url verbatim when the stream key marks the event external', async () => {
    const embeds = { 'https://streamfree.top/embed/soccer/sc1': tokenHtml(tokens) };
    const [s] = await makeProvider({ embeds, streamKey: { is_external: true, external_url: 'https://other.tv/live.m3u8' } }).resolveStream('sc1', 'soccer', 'x');
    expect(decodeURIComponent(s.url.split('url=')[1].split('&referer')[0])).toBe('https://other.tv/live.m3u8');
  });

  it('still resolves with the origin path when get-stream-key fails', async () => {
    const embeds = { 'https://streamfree.top/embed/soccer/sc1': tokenHtml(tokens) };
    const [s] = await makeProvider({ embeds }).resolveStream('sc1', 'soccer', 'x');
    expect(decodeURIComponent(s.url)).toContain('/live-origin/sc11080p/index.m3u8');
  });

  it('skips sources whose embed page has no token blob or no usable token', async () => {
    const embeds = {
      'https://streamfree.top/embed/soccer/sc1': '<html>blocked</html>',
      'https://streamfree.top/embed/soccer/sc2': tokenHtml({ '480p': { _t: null } }),
    };
    expect(await makeProvider({ embeds }).resolveStream('sc1', 'soccer', 'x')).toEqual([]);
    expect(await makeProvider({ embeds }).resolveStream('sc2', 'soccer', 'x')).toEqual([]);
  });

  it('returns [] when the embed fetch fails', async () => {
    expect(await makeProvider({ embeds: {} }).resolveStream('sc1', 'soccer', 'x')).toEqual([]);
  });
});
