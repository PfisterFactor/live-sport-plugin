const { describe, it, expect, beforeEach, afterEach, setSystemTime, mock } = require('bun:test');
const StreamedPkProvider = require('../../../src/providers/StreamedPkProvider');
const { makeCradle, res } = require('./fixtures/helpers');

const NOW = new Date('2026-03-01T12:00:00Z');
const T = NOW.getTime();

function makeProvider({ all = [], live = [], streams = {}, embedStProvider, embedIndiaProvider } = {}) {
  const p = new StreamedPkProvider(makeCradle({ embedStProvider, embedIndiaProvider }));
  p.embedStProvider = embedStProvider;
  p.embedIndiaProvider = embedIndiaProvider;
  p.proxyFetch = async (url) => {
    if (url.endsWith('/matches/all')) return res({ json: all });
    if (url.endsWith('/matches/live')) return res({ json: live });
    const m = url.match(/\/stream\/([^/]+)\/([^/]+)$/);
    if (m) {
      const key = `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`;
      if (!(key in streams)) return res({ status: 404, body: '[]' });
      return res({ json: streams[key] });
    }
    return res({ status: 404, body: '' });
  };
  return p;
}

describe('StreamedPkProvider.getMatches', () => {
  beforeEach(() => setSystemTime(NOW));
  afterEach(() => setSystemTime());

  it('drops finished fixtures but keeps upcoming, verified-live and 24/7 entries', async () => {
    const all = [
      { id: 'finished', title: 'Finished', category: 'football', date: T - 3600000, sources: [{ source: 'alpha', id: 'f1' }] },
      { id: 'livematch', title: 'Live Match', category: 'football', date: T - 1800000, sources: [{ source: 'alpha', id: 'l1' }] },
      { id: 'soon', title: 'Soon', category: 'football', date: T + 3600000, sources: [{ source: 'alpha', id: 's1' }] },
      { id: 'sky-sports-channel', title: 'Sky Sports', category: 'football', date: 0 },
    ];
    const live = [{ id: 'livematch', sources: [{ source: 'alpha', id: 'l1' }] }];
    const streams = { 'alpha/l1': [{ embedUrl: 'https://embed.st/embed/admin/x/1' }] };
    const matches = await makeProvider({ all, live, streams }).getMatches();
    expect(matches.map((m) => m.id)).toEqual(['spk_livematch', 'spk_soon', 'spk_sky-sports-channel']);
    expect(matches[0].status).toBe('live');
    expect(matches[1].status).toBe('upcoming');
    expect(matches[2].status).toBe('');
    expect(matches[2].date).toBe('');
    expect(matches[2].popular).toBe('1');
  });

  it('treats a live entry whose stream endpoint returns nothing as finished', async () => {
    const all = [{ id: 'stale', title: 'Stale', category: 'football', date: T - 3600000, sources: [{ source: 'alpha', id: 'x' }] }];
    const live = [{ id: 'stale', sources: [{ source: 'alpha', id: 'x' }] }];
    const matches = await makeProvider({ all, live, streams: { 'alpha/x': [] } }).getMatches();
    expect(matches).toEqual([]);
  });

  it('marks a fixture live when any of its sources is verified through a sibling entry', async () => {
    const all = [{ id: 'aliased', title: 'Aliased', category: 'football', date: T - 3600000, sources: [{ source: 'alpha', id: 'shared' }] }];
    const live = [{ id: 'other-id', sources: [{ source: 'alpha', id: 'shared' }] }];
    const matches = await makeProvider({ all, live, streams: { 'alpha/shared': [{ embedUrl: 'u' }] } }).getMatches();
    expect(matches.map((m) => m.status)).toEqual(['live']);
  });

  it('survives numeric ids on 24/7 channels', async () => {
    const all = [
      { id: 90210, title: 'Numeric Channel', category: 'tennis', date: 0 },
      { id: 'x1', title: 'Regular', category: 'cricket', date: T + 1000 },
    ];
    const matches = await makeProvider({ all }).getMatches();
    expect(matches.map((m) => m.id)).toEqual(['spk_90210', 'spk_x1']);
    expect(matches[0].category).toBe('tennis');
  });

  it('expands sources into per-stream descriptors and synthesises one when absent', async () => {
    const all = [
      { id: 'a', title: 'A', category: 'football', date: T + 1000, sources: [{ source: 'alpha', id: 'a1' }, { source: 'bravo', id: 'b1' }] },
      { id: 'b', title: 'B', category: 'football', date: T + 1000 },
    ];
    const matches = await makeProvider({ all }).getMatches();
    expect(matches[0].sources).toEqual([
      { source: 'streamedpk', id: 'a', streamSource: 'alpha', streamId: 'a1' },
      { source: 'streamedpk', id: 'a', streamSource: 'bravo', streamId: 'b1' },
    ]);
    expect(matches[1].sources).toEqual([{ source: 'streamedpk', id: 'b' }]);
  });

  it('builds absolute poster and badge urls and skips items missing id or title', async () => {
    const all = [
      { id: 'p1', title: 'P', category: 'football', date: T + 1000, poster: '/api/images/poster/x.webp', teams: { home: { name: 'H', badge: 'hb' }, away: { name: 'A', badge: 'ab' } } },
      { id: 'p2', category: 'football', date: T + 1000 },
      { title: 'no id', category: 'football', date: T + 1000 },
    ];
    const matches = await makeProvider({ all }).getMatches();
    expect(matches).toHaveLength(1);
    expect(matches[0].poster).toBe('https://streamed.pk/api/images/poster/x.webp');
    expect(matches[0].team1).toEqual({ name: 'H', logo: 'https://streamed.pk/api/images/proxy/hb' });
    expect(matches[0].team2.logo).toBe('https://streamed.pk/api/images/proxy/ab');
  });

  it('still returns the all-matches list when the live endpoint fails', async () => {
    const p = makeProvider({ all: [{ id: 'a', title: 'A', category: 'football', date: T + 1000 }] });
    const inner = p.proxyFetch;
    p.proxyFetch = async (url) => (url.endsWith('/matches/live') ? res({ status: 500, body: '' }) : inner(url));
    const matches = await p.getMatches();
    expect(matches.map((m) => m.id)).toEqual(['spk_a']);
  });
});

describe('StreamedPkProvider.resolveStream', () => {
  beforeEach(() => setSystemTime(NOW));
  afterEach(() => setSystemTime());

  it('enumerates every sub-source, ordered by viewers, through the embed providers', async () => {
    const embedStProvider = { resolveStream: mock(async (id, cat, label) => [{ name: 'EmbedSt', title: label }]) };
    const embedIndiaProvider = { resolveStream: mock(async (id, cat, label) => [{ name: 'EmbedIndia', title: label }]) };
    const streams = {
      'alpha/a1': [
        { embedUrl: 'https://embed.st/embed/admin/x/1', viewers: 10, language: 'English' },
        { embedUrl: 'https://embedindia.st/embed/admin/y', viewers: 900, streamNo: 2 },
        { viewers: 5000 },
      ],
    };
    const p = makeProvider({ streams, embedStProvider, embedIndiaProvider });
    const out = await p.resolveStream('a', 'football', 'A vs B', { streamSource: 'alpha', streamId: 'a1' });
    expect(out.map((s) => s.title)).toEqual([
      'A vs B Stream 2 | 👥 900 Viewers',
      'A vs B (English) | 👥 10 Viewers',
    ]);
    expect(embedIndiaProvider.resolveStream).toHaveBeenCalledTimes(1);
    expect(embedStProvider.resolveStream).toHaveBeenCalledTimes(1);
    expect(embedStProvider.resolveStream.mock.calls[0][3]).toEqual({ embedUrl: 'https://embed.st/embed/admin/x/1' });
  });

  it('defaults to the admin source when the caller passes no src descriptor', async () => {
    const embedStProvider = { resolveStream: mock(async () => [{ name: 'EmbedSt', title: 't' }]) };
    const streams = { 'admin/a': [{ embedUrl: 'https://embed.st/e/1' }] };
    const out = await makeProvider({ streams, embedStProvider }).resolveStream('a', 'football', 'A vs B');
    expect(out).toHaveLength(1);
  });

  it('emits a raw /watch fallback when no embed provider is wired in', async () => {
    const streams = { 'admin/a': [{ embedUrl: 'https://embed.st/e/1', viewers: 3 }] };
    const [s] = await makeProvider({ streams }).resolveStream('a', 'football', 'A vs B');
    expect(s.name).toBe('StreamedPk');
    expect(s.externalUrl).toBe('/watch?url=https%3A%2F%2Fembed.st%2Fe%2F1&title=A%20vs%20B');
  });

  it('keeps working when one sub-source resolver rejects', async () => {
    let n = 0;
    const embedStProvider = {
      resolveStream: async () => { n += 1; if (n === 1) throw new Error('boom'); return [{ name: 'EmbedSt', title: 'ok' }]; },
    };
    const streams = { 'admin/a': [{ embedUrl: 'https://embed.st/e/1', viewers: 9 }, { embedUrl: 'https://embed.st/e/2', viewers: 1 }] };
    const out = await makeProvider({ streams, embedStProvider }).resolveStream('a', 'football', 'A vs B');
    expect(out.map((s) => s.title)).toEqual(['ok']);
  });

  it('returns [] when the stream endpoint errors', async () => {
    const out = await makeProvider({}).resolveStream('missing', 'football', 'A vs B');
    expect(out).toEqual([]);
  });
});
