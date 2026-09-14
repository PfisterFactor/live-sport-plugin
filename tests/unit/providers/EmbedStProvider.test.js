const { describe, it, expect, beforeEach, afterAll, mock } = require('bun:test');
const extractor = require('../../../src/providers/SportsEmbedExtractor');
const EmbedStProvider = require('../../../src/providers/EmbedStProvider');
const { makeCradle, res } = require('./fixtures/helpers');
const { BASE_URL } = require('../../../src/config');

const realExtract = extractor.extractSportsEmbed;
let extractImpl = async () => null;
extractor.extractSportsEmbed = (...a) => extractImpl(...a);

afterAll(() => { extractor.extractSportsEmbed = realExtract; });
function makeProvider({ html, embedIndiaProvider, fetchFails } = {}) {
  const p = new EmbedStProvider(makeCradle({ embedIndiaProvider }));
  p.embedIndiaProvider = embedIndiaProvider;
  p.proxyFetch = async (url, opts) => {
    p._lastOpts = opts;
    if (fetchFails) throw new Error('cf challenge');
    return res({ body: html || '<html></html>' });
  };
  return p;
}

describe('EmbedStProvider.resolveStream', () => {
  beforeEach(() => { extractImpl = async () => null; });

  it('rejects a non-http embed reference', async () => {
    expect(await makeProvider().resolveStream('ch12', 'football', 'A vs B')).toEqual([]);
  });

  it('delegates an embedindia iframe redirect and rebrands the delegated streams', async () => {
    const embedIndiaProvider = { resolveStream: mock(async () => [{ name: 'EmbedIndia', title: 'EmbedIndia (A vs B)', url: 'https://p/x.m3u8' }]) };
    const html = '<iframe src="https://embedindia.st/embed/admin/ch5"></iframe>';
    const streams = await makeProvider({ html, embedIndiaProvider }).resolveStream('https://embed.st/embed/admin/rally-tv/1', 'football', 'A vs B');
    expect(embedIndiaProvider.resolveStream.mock.calls[0][0]).toBe('https://embedindia.st/embed/admin/ch5');
    expect(embedIndiaProvider.resolveStream.mock.calls[0][3]).toEqual({ referer: 'https://embedindia.st/' });
    expect(streams.map((s) => s.name)).toEqual(['EmbedSt', 'EmbedSt']);
    expect(streams[0].title).toBe('EmbedSt (A vs B)');
    expect(streams[1].externalUrl).toContain('/watch?url=https%3A%2F%2Fembed.st');
  });

  it('offers client-side extraction when the iframe target has no provider behind it', async () => {
    const html = "<iframe src='//embedsport.xyz/embed/9'></iframe>";
    const streams = await makeProvider({ html }).resolveStream('https://embed.st/embed/admin/rally-tv/1', 'football', 'A vs B');
    expect(streams[0].externalUrl).toBe(`/watch?mode=extract&embed=${encodeURIComponent('https://embedsport.xyz/embed/9')}&referer=${encodeURIComponent('https://embedsport.xyz/')}&title=A%20vs%20B`);
    expect(streams).toHaveLength(2);
  });

  it('falls back to the delegated extract tier when the iframe provider yields nothing', async () => {
    const embedIndiaProvider = { resolveStream: async () => [] };
    const html = '<iframe src="https://embedindia.st/embed/admin/ch5"></iframe>';
    const streams = await makeProvider({ html, embedIndiaProvider }).resolveStream('https://embed.st/embed/admin/rally-tv/1', 'football', 'A vs B');
    expect(streams[0].externalUrl).toContain('mode=extract');
  });

  it('sends the derived referer with the prefetch and survives a failing prefetch', async () => {
    const p = makeProvider({ html: '<html></html>' });
    await p.resolveStream('https://embed.st/x', 'football', 'A vs B');
    expect(p._lastOpts.headers.Referer).toBe('https://embed.st/');

    const failing = makeProvider({ fetchFails: true });
    const streams = await failing.resolveStream('https://embed.st/x', 'football', 'A vs B');
    expect(streams).toHaveLength(1);
    expect(streams[0].externalUrl).toBe(`/watch?url=${encodeURIComponent('https://embed.st/x')}&title=A%20vs%20B`);
  });

  it('proxies the natively extracted sportsembed manifest', async () => {
    extractImpl = async () => 'https://edge.se/live/a.m3u8';
    const url = 'https://sportsembed.su/embed/6028327/club-america-columbus-crew/platinum/1';
    const streams = await makeProvider().resolveStream(url, 'football', 'A vs B');
    expect(streams).toHaveLength(2);
    expect(streams[0].url).toBe(`${BASE_URL}/api/manifest?url=${encodeURIComponent('https://edge.se/live/a.m3u8')}&referer=${encodeURIComponent('https://sportsembed.su/')}&origin=${encodeURIComponent('https://sportsembed.su')}`);
    expect(streams[0].title).toBe('[Direct] A vs B');
  });

  it('skips the iframe prefetch entirely for sportsembed urls', async () => {
    extractImpl = async () => null;
    const p = makeProvider({ html: '<iframe src="https://embedindia.st/embed/admin/ch5"></iframe>' });
    const streams = await p.resolveStream('https://sportsembed.su/embed/1/a/platinum/1', 'football', 'A vs B');
    expect(p._lastOpts).toBeUndefined();
    expect(streams).toHaveLength(1);
  });

  it('degrades to the web player when native extraction throws', async () => {
    extractImpl = async () => { throw new Error('API Blocked'); };
    const streams = await makeProvider().resolveStream('https://sportsembed.su/embed/1/a/platinum/1', 'football', 'A vs B');
    expect(streams).toHaveLength(1);
    expect(streams[0].externalUrl).toContain('/watch?url=https%3A%2F%2Fsportsembed.su');
  });

  it('exposes no catalogue of its own', async () => {
    expect(await makeProvider().getMatches()).toEqual([]);
  });
});
