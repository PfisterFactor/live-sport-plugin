const { describe, it, expect, beforeEach, afterEach, spyOn } = require('bun:test');

const impitClient = require('../../../src/impitClient');
const { verifyStreams } = require('../../../src/streams');
const M3U8ParserService = require('../../../src/services/M3U8ParserService');

const PLAYLIST = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:5\n#EXTINF:4.0,\nseg0.ts\n';
const WRONG_FAMILY_REFERER = 'https://wrong-family.example/';
const TERMINAL_TARGET = 'https://c2807p.7odxv0l067ka.net/hls/live/302.m3u8?token=t&e=1770000000';

const ok = (body = PLAYLIST) => ({ status: 200, text: async () => body });
const status = (code) => ({ status: code, text: async () => 'error' });
const netFail = (code) => Object.assign(new Error('socket failure'), { code });

const parser = new M3U8ParserService();
let safeFetch;
let logSpy;

const makeCache = () => ({
  failures: 0,
  successes: 0,
  noteFailure() { this.failures++; },
  noteSuccess() { this.successes++; },
});

const stream = (url = 'https://edge.example/live.m3u8') => ({
  url,
  name: '⚡ Direct Stream',
  behaviorHints: { proxyHeaders: { request: { Referer: 'https://embed.st/' } } },
});

function proxiedStream(targetUrl, referer) {
  const origin = referer ? referer.replace(/\/$/, '') : '';
  const url = 'http://addon.local/api/manifest'
    + `?url=${encodeURIComponent(targetUrl)}`
    + `&referer=${encodeURIComponent(referer)}`
    + `&origin=${encodeURIComponent(origin)}`;
  return { url, name: 'DaddyLive', title: 'DaddyLive (Test Channel)', behaviorHints: { notWebReady: true } };
}

beforeEach(() => {
  safeFetch = spyOn(impitClient, 'safeFetch');
  logSpy = spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  safeFetch.mockRestore();
  logSpy.mockRestore();
});

describe('verifyStreams retry policy', () => {
  it('keeps a stream that fails once with a connection reset then succeeds', async () => {
    safeFetch.mockRejectedValueOnce(netFail('ECONNRESET')).mockResolvedValue(ok());
    const cache = makeCache();
    const out = await verifyStreams([stream()], 'watchfooty:m1:s1', parser, cache);
    expect(out).toHaveLength(1);
    expect(safeFetch).toHaveBeenCalledTimes(2);
    expect(cache.failures).toBe(0);
    expect(cache.successes).toBe(1);
  });

  it('keeps a stream that answers 503 once then serves the playlist', async () => {
    safeFetch.mockResolvedValueOnce(status(503)).mockResolvedValue(ok());
    const cache = makeCache();
    expect(await verifyStreams([stream()], 'k', parser, cache)).toHaveLength(1);
    expect(safeFetch).toHaveBeenCalledTimes(2);
    expect(cache.failures).toBe(0);
  });

  it('drops and negative-caches a stream that stays unreachable', async () => {
    safeFetch.mockRejectedValue(netFail('ECONNRESET'));
    const cache = makeCache();
    expect(await verifyStreams([stream()], 'k', parser, cache)).toHaveLength(0);
    expect(safeFetch).toHaveBeenCalledTimes(3);
    expect(cache.failures).toBe(1);
  });

  it('does not retry a 404', async () => {
    safeFetch.mockResolvedValue(status(404));
    const cache = makeCache();
    expect(await verifyStreams([stream()], 'k', parser, cache)).toHaveLength(0);
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(cache.failures).toBe(1);
  });

  it('drops a 200 whose body is not a playlist', async () => {
    safeFetch.mockResolvedValue(ok('Not found'));
    const cache = makeCache();
    expect(await verifyStreams([stream()], 'k', parser, cache)).toHaveLength(0);
    expect(cache.failures).toBe(1);
  });

  it.each([
    ['web player link', { url: 'http://host/watch?u=abc', name: '🌐 Web Stream' }],
    ['direct mp4', { url: 'https://cdn.example/replay.mp4', name: '⚡ Direct Stream' }],
    ['ok.ru cdn', { url: 'https://vd1.okcdn.ru/?expires=1', name: '⚡ Direct Stream' }],
    ['pixeldrain', { url: 'https://pixeldrain.com/api/file/x', name: '⚡ Direct Stream' }],
    ['youtube (no url)', { externalUrl: 'https://www.youtube.com/watch?v=abc', name: '▶️ YouTube' }],
  ])('passes %s through without pinging anything', async (_label, s) => {
    expect(await verifyStreams([s], 'k', parser, makeCache())).toHaveLength(1);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it('lets each stream in a batch fail or survive independently', async () => {
    safeFetch.mockImplementation(async (url) => {
      if (url.includes('dead')) throw netFail('ECONNRESET');
      return ok();
    });
    const out = await verifyStreams(
      [stream('https://edge.example/good.m3u8'), stream('https://edge.example/dead.m3u8')],
      null, parser, makeCache()
    );
    expect(out.map(s => s.url)).toEqual(['https://edge.example/good.m3u8']);
  });
});

describe('verifyStreams 403/401 Referer repair', () => {
  it('retries once with the terminal-host Referer and keeps a stream that then serves 200', async () => {
    safeFetch.mockImplementation(async (url, opts) => (
      opts.headers.Referer === 'https://assetrage.net/' ? ok() : status(403)
    ));
    const cache = makeCache();
    const s = proxiedStream(TERMINAL_TARGET, WRONG_FAMILY_REFERER);
    const out = await verifyStreams([s], 'dlive:m1:s1', parser, cache);

    expect(out).toEqual([s]);
    expect(safeFetch).toHaveBeenCalledTimes(2);
    expect(safeFetch.mock.calls[0][1].headers.Referer).toBe(WRONG_FAMILY_REFERER);
    expect(safeFetch.mock.calls[1][1].headers.Referer).toBe('https://assetrage.net/');
    expect(safeFetch.mock.calls[1][1].headers.Origin).toBe('https://assetrage.net');
    expect(cache.failures).toBe(0);
    expect(cache.successes).toBe(1);
  });

  it('retries at most once - a stream that keeps refusing is dropped', async () => {
    safeFetch.mockResolvedValue(status(403));
    const cache = makeCache();
    const out = await verifyStreams(
      [proxiedStream('https://cdn.unknown-family.example/live/302.m3u8', WRONG_FAMILY_REFERER)],
      'dlive:m1:s3', parser, cache
    );
    expect(out).toHaveLength(0);
    expect(safeFetch).toHaveBeenCalledTimes(2);
    expect(safeFetch.mock.calls[1][1].headers.Referer).toBe('https://cdn.unknown-family.example/');
    expect(cache.failures).toBe(1);
  });

  it('does not re-send the very Referer that was just refused', async () => {
    safeFetch.mockResolvedValue(status(403));
    const out = await verifyStreams(
      [proxiedStream(TERMINAL_TARGET, 'https://assetrage.net/')],
      'dlive:m1:s5', parser, makeCache()
    );
    expect(out).toHaveLength(0);
    expect(safeFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps a 403 stream when no Referer is available at all', async () => {
    safeFetch.mockResolvedValue(status(403));
    const cache = makeCache();
    const bare = { url: 'https://edge.example/live.m3u8', name: '⚡ Direct Stream' };
    const out = await verifyStreams([bare], 'k', parser, cache);
    expect(out).toEqual([bare]);
    expect(cache.failures).toBe(0);
  });
});
