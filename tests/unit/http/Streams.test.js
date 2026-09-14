const { describe, it, expect, beforeEach, afterEach, spyOn } = require('bun:test');

const container = require('../../../src/container');
const impitClient = require('../../../src/impitClient');
const { selectSources, resolveSource, handleStream, SOURCES } = require('../../../src/streams');

const fakes = {};
let resolveSpy;
let safeFetchSpy;
let parsed;

beforeEach(() => {
  for (const k of Object.keys(fakes)) delete fakes[k];
  parsed = null;
  fakes.streamScorer = { calculateScore: (s) => s.score ?? 0 };
  fakes.m3u8Parser = { parseManifestText: () => parsed };
  fakes.streamResolveCache = {
    get: () => null,
    getOrCreate: (_k, fn) => fn(),
    noteSuccess() {},
    noteFailure() {},
  };
  fakes.cacheService = { getMatches: () => [] };
  resolveSpy = spyOn(container, 'resolve').mockImplementation((name) => {
    if (name in fakes) return fakes[name];
    throw new Error(`unexpected resolve('${name}')`);
  });
  safeFetchSpy = spyOn(impitClient, 'safeFetch').mockImplementation(async () => ({
    ok: true,
    status: 200,
    headers: {},
    text: async () => '#EXTM3U\n#EXT-X-TARGETDURATION:4\nseg.ts',
    json: async () => ({}),
  }));
});

afterEach(() => {
  resolveSpy.mockRestore();
  safeFetchSpy.mockRestore();
});

describe('selectSources', () => {
  const src = (source) => ({ source, id: `${source}-1` });

  it('keeps only default-enabled sources when no config is supplied', () => {
    const picked = selectSources([src('watchfooty'), src('embedindia'), src('embedst')], null);
    expect(picked.map((s) => s.source)).toEqual(['embedst', 'watchfooty']);
  });

  it('treats sources:"none" as "use the defaults"', () => {
    const picked = selectSources([src('watchfooty'), src('embedindia')], { sources: 'none' });
    expect(picked.map((s) => s.source)).toEqual(['watchfooty']);
  });

  it('enables embedindia only when explicitly opted in', () => {
    const picked = selectSources([src('watchfooty'), src('embedindia')], { sources: 'watchfooty,embedindia' });
    expect(picked.map((s) => s.source)).toEqual(['watchfooty', 'embedindia']);
  });

  it('drops configured sources that are not in the list', () => {
    const picked = selectSources([src('watchfooty'), src('cdnlive')], { sources: 'cdnlive' });
    expect(picked.map((s) => s.source)).toEqual(['cdnlive']);
  });

  it('orders by ascending priority and keeps equal priorities in input order', () => {
    const picked = selectSources(
      [src('timstreams'), src('streamedpk'), src('watchfooty'), src('embedst')],
      null
    );
    expect(picked.map((s) => s.source)).toEqual(['streamedpk', 'embedst', 'watchfooty', 'timstreams']);
    expect(SOURCES.streamedpk.priority).toBe(SOURCES.embedst.priority);
  });

  it('never selects an unknown source, in either config mode', () => {
    const list = [src('brand-new'), src('watchfooty')];
    expect(selectSources(list, null).map((s) => s.source)).toEqual(['watchfooty']);
    expect(selectSources(list, { sources: 'brand-new,watchfooty' }).map((s) => s.source)).toEqual(['watchfooty']);
  });
});

describe('resolveSource', () => {
  const match = { id: 'm1', title: 'A vs B', category: 'football' };

  it('calls a plain provider with (id, category, title)', async () => {
    const args = [];
    fakes.timStreamsProvider = { resolveStream: async (...a) => { args.push(a); return []; } };
    await resolveSource({ source: 'timstreams', id: 'ts-1' }, match);
    expect(args[0]).toEqual(['ts-1', 'football', 'A vs B']);
  });

  it('passes the source object as a fourth argument for passSrc providers', async () => {
    const args = [];
    const src = { source: 'embedst', id: 'e-1', extra: 1 };
    fakes.embedStProvider = { resolveStream: async (...a) => { args.push(a); return []; } };
    await resolveSource(src, match);
    expect(args[0]).toEqual(['e-1', 'football', 'A vs B', src]);
  });

  it('gives streamfree the source-specific category when present', async () => {
    const args = [];
    fakes.streamFreeProvider = { resolveStream: async (...a) => { args.push(a); return []; } };
    await resolveSource({ source: 'streamfree', id: 'sf-1', original_category: 'cricket' }, match);
    await resolveSource({ source: 'streamfree', id: 'sf-2' }, match);
    expect(args[0]).toEqual(['sf-1', 'cricket', 'A vs B']);
    expect(args[1]).toEqual(['sf-2', 'football', 'A vs B']);
  });

  it('tags each resolved stream with its score and source', async () => {
    fakes.streamScorer = { calculateScore: (s, source) => `${source}:${s.url}`.length };
    fakes.watchFootyProvider = { resolveStream: async () => [{ url: 'https://a/x.m3u8' }] };
    const out = await resolveSource({ source: 'watchfooty', id: 'w-1' }, match);
    expect(out[0]._source).toBe('watchfooty');
    expect(out[0].score).toBe('watchfooty:https://a/x.m3u8'.length);
  });

  it('swallows provider failures and returns no streams', async () => {
    fakes.watchFootyProvider = { resolveStream: async () => { throw new Error('upstream 500'); } };
    expect(await resolveSource({ source: 'watchfooty', id: 'w-1' }, match)).toEqual([]);
  });

  it('returns nothing for an unregistered source without resolving a provider', async () => {
    expect(await resolveSource({ source: 'brand-new', id: 'x' }, match)).toEqual([]);
    expect(resolveSpy).not.toHaveBeenCalled();
  });
});

describe('handleStream', () => {
  const matchWith = (over = {}) => ({
    id: 'm1',
    title: 'A vs B',
    category: 'football',
    sources: [{ source: 'watchfooty', id: 'w-1' }],
    ...over,
  });

  it('ignores non-tv types and foreign ids', async () => {
    expect(await handleStream('movie', 'nuvio_sport_m1')).toEqual({ streams: [] });
    expect(await handleStream('tv', 'tt1234')).toEqual({ streams: [] });
  });

  it('returns no streams for an unknown or source-less match', async () => {
    fakes.cacheService = { getMatches: () => [matchWith({ sources: [] })] };
    expect(await handleStream('tv', 'nuvio_sport_m1')).toEqual({ streams: [] });
    fakes.cacheService = { getMatches: () => [] };
    expect(await handleStream('tv', 'nuvio_sport_missing')).toEqual({ streams: [] });
  });

  it('keeps streams from healthy providers when another provider throws', async () => {
    fakes.cacheService = {
      getMatches: () => [matchWith({
        sources: [{ source: 'watchfooty', id: 'w-1' }, { source: 'cdnlive', id: 'c-1' }],
      })],
    };
    fakes.watchFootyProvider = { resolveStream: async () => { throw new Error('dead'); } };
    fakes.cdnLiveProvider = { resolveStream: async () => [{ url: 'https://cdn/a.m3u8', title: 'Auto' }] };

    const { streams } = await handleStream('tv', 'nuvio_sport_m1');
    expect(streams).toHaveLength(1);
    expect(streams[0]._source).toBe('cdnlive');
  });

  it('drops streams whose health check fails and keeps web player links', async () => {
    fakes.cacheService = {
      getMatches: () => [matchWith({
        sources: [{ source: 'watchfooty', id: 'w-1' }],
      })],
    };
    fakes.watchFootyProvider = {
      resolveStream: async () => [
        { url: 'https://cdn/dead.m3u8', title: 'Dead' },
        { url: '/watch?url=https%3A%2F%2Fe.st%2Fa', title: 'Web' },
      ],
    };
    safeFetchSpy.mockImplementation(async () => ({
      ok: false, status: 403, headers: {}, text: async () => '', json: async () => ({}),
    }));

    const { streams } = await handleStream('tv', 'nuvio_sport_m1');
    expect(streams.map((s) => s.url)).toEqual(['/watch?url=https%3A%2F%2Fe.st%2Fa']);
  });

  it('drops 200 responses whose body is not an m3u8 playlist', async () => {
    fakes.cacheService = { getMatches: () => [matchWith()] };
    fakes.watchFootyProvider = { resolveStream: async () => [{ url: 'https://cdn/a.m3u8' }] };
    safeFetchSpy.mockImplementation(async () => ({
      ok: true, status: 200, headers: {}, text: async () => 'Not found', json: async () => ({}),
    }));
    const { streams } = await handleStream('tv', 'nuvio_sport_m1');
    expect(streams).toEqual([]);
  });

  it('builds the display title from provider, channel, quality and bitrate', async () => {
    parsed = { qualityTag: '1080p', resolution: '1920x1080', bitrateTag: '4.2 Mbps' };
    fakes.cacheService = { getMatches: () => [matchWith()] };
    fakes.watchFootyProvider = {
      resolveStream: async () => [{ url: 'https://cdn/a.m3u8', title: 'Main Feed (Sky Sports) 👥 42 Viewers' }],
    };
    const { streams } = await handleStream('tv', 'nuvio_sport_m1');
    expect(streams[0].name).toBe('⚡ Direct Stream');
    expect(streams[0].title).toBe('⚽ WatchFooty | 📺 Sky Sports\n📺 Quality: 1080p | 4.2 Mbps\n👥 42 Viewers');
  });

  it('labels web player entries separately and omits an absent bitrate', async () => {
    fakes.cacheService = { getMatches: () => [matchWith({ category: 'tennis' })] };
    fakes.watchFootyProvider = {
      resolveStream: async () => [{ externalUrl: 'https://e.st/a', title: 'Auto' }],
    };
    const { streams } = await handleStream('tv', 'nuvio_sport_m1');
    expect(streams[0].name).toBe('🌐 Web Stream');
    expect(streams[0].title).toBe('📡 WatchFooty\n📺 Quality: Auto');
  });

  it('attaches proxy referer hints only to unproxied direct m3u8 streams', async () => {
    fakes.cacheService = {
      getMatches: () => [matchWith({
        sources: [{ source: 'watchfooty', id: 'w-1' }, { source: 'embedst', id: 'e-1' }],
      })],
    };
    fakes.watchFootyProvider = { resolveStream: async () => [{ url: 'https://cdn/a.m3u8', score: 5 }] };
    fakes.embedStProvider = {
      resolveStream: async () => [{ url: '/api/manifest?url=https%3A%2F%2Fcdn%2Fb.m3u8', score: 1 }],
    };

    const { streams } = await handleStream('tv', 'nuvio_sport_m1');
    const direct = streams.find((s) => s._source === 'watchfooty');
    const proxied = streams.find((s) => s._source === 'embedst');
    expect(direct.behaviorHints.proxyHeaders).toEqual({
      request: { Referer: 'https://watchfooty.st/', Origin: 'https://watchfooty.st/' },
    });
    expect(direct.behaviorHints.notWebReady).toBe(true);
    expect(proxied.behaviorHints.notWebReady).toBeUndefined();
    expect(proxied.behaviorHints.proxyHeaders).toBeUndefined();
    expect(streams.every((s) => s.behaviorHints.bingeGroup === 'nuvio_sport_m1')).toBe(true);
  });

  it('sorts direct streams ahead of web streams, then by descending score', async () => {
    fakes.cacheService = {
      getMatches: () => [matchWith({
        sources: [{ source: 'watchfooty', id: 'w-1' }],
      })],
    };
    fakes.watchFootyProvider = {
      resolveStream: async () => [
        { externalUrl: '/watch?url=a', score: 99 },
        { url: 'https://cdn/low.m3u8', score: 1 },
        { url: 'https://cdn/high.m3u8', score: 50 },
      ],
    };
    const { streams } = await handleStream('tv', 'nuvio_sport_m1');
    expect(streams.map((s) => s.url ?? s.externalUrl)).toEqual([
      'https://cdn/high.m3u8',
      'https://cdn/low.m3u8',
      '/watch?url=a',
    ]);
  });

  it('injects the 24/7 cricket channels only while streamfree is enabled', async () => {
    fakes.cacheService = { getMatches: () => [matchWith({ category: 'cricket' })] };
    fakes.watchFootyProvider = { resolveStream: async () => [] };
    const seen = [];
    fakes.streamFreeProvider = {
      resolveStream: async (id) => { seen.push(id); return [{ url: `https://cdn/${id}.m3u8` }]; },
    };

    const withDefaults = await handleStream('tv', 'nuvio_sport_m1', null);
    expect(seen).toEqual(['willow', 'skycricket']);
    expect(withDefaults.streams.every((s) => s._source === 'streamfree')).toBe(true);

    seen.length = 0;
    const optedOut = await handleStream('tv', 'nuvio_sport_m1', { sources: 'watchfooty' });
    expect(seen).toEqual([]);
    expect(optedOut.streams).toEqual([]);
  });

  it('advertises a short client cache window', async () => {
    fakes.cacheService = { getMatches: () => [matchWith()] };
    fakes.watchFootyProvider = { resolveStream: async () => [] };
    const out = await handleStream('tv', 'nuvio_sport_m1');
    expect(out).toMatchObject({ cacheMaxAge: 30, staleRevalidate: 30, staleError: 60 });
  });
});
