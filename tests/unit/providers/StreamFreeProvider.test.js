const { describe, it, expect } = require('bun:test');
const StreamFreeProvider = require('../../../src/providers/StreamFreeProvider');
const { makeCradle, res } = require('./fixtures/helpers');
const { BASE_URL } = require('../../../src/config');


function tokenHtml(tokens) {
  return `<html><script>const _0x = ${JSON.stringify(tokens)};\nplay(_0x);</script></html>`;
}

function makeProvider({ list, embeds = {}, streamKey, sources } = {}) {
  const p = new StreamFreeProvider(makeCradle());
  p.proxyFetch = async (url) => {
    if (url === p.apiUrl) return res({ json: list });
    if (url.startsWith('https://streamfree.top/api/v1/sources/')) {
      return sources ? res({ json: { sources } }) : res({ status: 500, body: '' });
    }
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

const EMBED = 'https://strmfree.st/embed/football/nfl11080p';
const EMBED2 = 'https://strmfree.st/embed/football/nfl11080p2';
const tok = (n) => ({ _t: `t${n}`, _ta: `ta${n}`, _e: 1000 + n, _s: `s${n}`, _sa: `sa${n}` });
const tokens = { nfl11080p: tok(1), nfl11080p2: tok(2), nfl1720p: { _t: null } };
const query = (n) => `_t=t${n}&_ta=ta${n}&_e=${1000 + n}&_s=s${n}&_sa=sa${n}`;
const targetOf = (s) => decodeURIComponent(s.url.split('url=')[1].split('&referer')[0]);

describe('StreamFreeProvider.resolveStream', () => {
  it('builds one stream per live source variant with its quality label', async () => {
    const sources = [
      { quality: 'FHD', url: EMBED, live: true },
      { quality: 'HD', url: EMBED2, live: true },
      { quality: 'SD', url: 'https://strmfree.st/embed/football/nfl1540p', live: false },
    ];
    const embeds = { [EMBED]: tokenHtml(tokens), [EMBED2]: tokenHtml(tokens) };
    const streams = await makeProvider({ sources, embeds, streamKey: { server_name: 'externalcdn' } }).resolveStream('nfl1');
    expect(streams.map((s) => s.title)).toEqual(['StreamFree (FHD)', 'StreamFree (HD)']);
    expect(streams[0].resolution).toBe('FHD');
    expect(targetOf(streams[0])).toBe(`https://strmfree.st/live-externalcdn/nfl11080p/index.m3u8?${query(1)}`);
    expect(targetOf(streams[1])).toBe(`https://strmfree.st/live-externalcdn/nfl11080p2/index.m3u8?${query(2)}`);
    expect(streams[0].url.startsWith(`${BASE_URL}/api/manifest?`)).toBe(true);
  });

  it('uses the CDN path for other servers and the bare live path for origin', async () => {
    const sources = [{ quality: 'FHD', url: EMBED, live: true }];
    const embeds = { [EMBED]: tokenHtml(tokens) };
    const [cdn] = await makeProvider({ sources, embeds, streamKey: { server_name: 'edge7' } }).resolveStream('nfl1');
    expect(targetOf(cdn)).toContain('https://strmfree.st/live-cdn/nfl11080p/index.m3u8');
    const [origin] = await makeProvider({ sources, embeds, streamKey: { server_name: 'origin' } }).resolveStream('nfl1');
    expect(targetOf(origin)).toContain('https://strmfree.st/live/nfl11080p/index.m3u8');
    const [noKey] = await makeProvider({ sources, embeds }).resolveStream('nfl1');
    expect(targetOf(noKey)).toContain('/live/nfl11080p/index.m3u8');
  });

  it('prefers an external url verbatim when the stream key marks the event external', async () => {
    const sources = [{ quality: 'FHD', url: EMBED, live: true }];
    const embeds = { [EMBED]: tokenHtml(tokens) };
    const [s] = await makeProvider({ sources, embeds, streamKey: { is_external: true, external_url: 'https://other.tv/live.m3u8' } }).resolveStream('nfl1');
    expect(targetOf(s)).toBe('https://other.tv/live.m3u8');
    expect(s.url).not.toContain('renew=');
  });

  it('skips variants missing from the embed token map or without a token', async () => {
    const e720 = 'https://strmfree.st/embed/football/nfl1720p';
    const e999 = 'https://strmfree.st/embed/football/nfl1999p';
    const sources = [
      { quality: 'FHD', url: EMBED, live: true },
      { quality: 'HD', url: e720, live: true },
      { quality: 'X', url: e999, live: true },
    ];
    const embeds = { [EMBED]: tokenHtml(tokens), [e720]: tokenHtml(tokens), [e999]: '<html>blocked</html>' };
    const streams = await makeProvider({ sources, embeds }).resolveStream('nfl1');
    expect(streams.map((s) => s.title)).toEqual(['StreamFree (FHD)']);
  });

  it('returns [] when the sources lookup or the embed fetch fails', async () => {
    expect(await makeProvider({}).resolveStream('nfl1')).toEqual([]);
    expect(await makeProvider({ sources: [{ quality: 'FHD', url: EMBED, live: true }] }).resolveStream('nfl1')).toEqual([]);
  });
});

describe('StreamFreeProvider.refreshSignedUrl', () => {
  const dead = 'https://strmfree.st/live-externalcdn/nfl11080p2/index.m3u8?_t=old&_ta=old&_e=1&_s=old&_sa=old';

  it('re-signs the dead URL with the token entry for its exact variant', async () => {
    const p = makeProvider({ embeds: { [EMBED2]: tokenHtml(tokens) } });
    const out = await p.refreshSignedUrl(EMBED2, dead);
    expect(out).toEqual({ m3u8: `https://strmfree.st/live-externalcdn/nfl11080p2/index.m3u8?${query(2)}`, referer: EMBED2 });
  });

  it('returns null when the variant is absent or the page has no tokens', async () => {
    expect(await makeProvider({ embeds: { [EMBED2]: tokenHtml({ other: tok(1) }) } }).refreshSignedUrl(EMBED2, dead)).toBeNull();
    expect(await makeProvider({ embeds: { [EMBED2]: '<html></html>' } }).refreshSignedUrl(EMBED2, dead)).toBeNull();
    expect(await makeProvider({ embeds: { [EMBED2]: tokenHtml(tokens) } }).refreshSignedUrl(EMBED2, 'not a url')).toBeNull();
  });
});
