const { describe, it, expect, beforeEach, afterEach, setSystemTime, spyOn } = require('bun:test');
const EmbedIndiaProvider = require('../../../src/providers/EmbedIndiaProvider');
const { makeCradle } = require('./fixtures/helpers');

const NOW = new Date('2026-03-01T12:00:00Z');

function makeProvider() {
  const p = new EmbedIndiaProvider(makeCradle());
  p._tryWasmExtraction = async () => null;
  return p;
}

describe('EmbedIndiaProvider._shouldSkipServerSide', () => {
  beforeEach(() => setSystemTime(NOW));
  afterEach(() => { setSystemTime(); delete process.env.RESIDENTIAL_PROXY; });

  it('skips known Cloudflare-protected hosts', () => {
    const p = makeProvider();
    expect(p._shouldSkipServerSide('https://embedindia.st/embed/admin/x')).toBe(true);
    expect(p._shouldSkipServerSide('https://embedsport.xyz/e/1')).toBe(true);
    expect(p._shouldSkipServerSide('https://other.tv/e/1')).toBe(false);
  });

  it('skips a host that failed recently and forgets it after the TTL', () => {
    const p = makeProvider();
    p._markFailure('https://other.tv/e/1');
    expect(p._shouldSkipServerSide('https://other.tv/e/2')).toBe(true);
    setSystemTime(new Date(NOW.getTime() + p.FAILURE_TTL_MS + 1));
    expect(p._shouldSkipServerSide('https://other.tv/e/2')).toBe(false);
  });

  it('never skips when a residential proxy is configured', () => {
    const p = makeProvider();
    p._markFailure('https://other.tv/e/1');
    process.env.RESIDENTIAL_PROXY = 'http://proxy:8080';
    expect(p._shouldSkipServerSide('https://embedindia.st/embed/admin/x')).toBe(false);
  });

  it('treats an unparseable url as not skippable', () => {
    expect(makeProvider()._shouldSkipServerSide('not-a-url')).toBe(false);
  });
});

describe('EmbedIndiaProvider.resolveStream', () => {
  it('rejects a non-http embed reference', async () => {
    expect(await makeProvider().resolveStream('abc123', 'football', 'A vs B')).toEqual([]);
    expect(await makeProvider().resolveStream(null, 'football', 'A vs B', {})).toEqual([]);
  });

  it('returns the extract tier plus the always-appended raw fallback', async () => {
    const url = 'https://embedindia.st/embed/admin/ch5';
    const streams = await makeProvider().resolveStream(url, 'football', 'A vs B');
    expect(streams).toHaveLength(2);
    expect(streams[0].externalUrl).toBe(`/watch?mode=extract&embed=${encodeURIComponent(url)}&referer=${encodeURIComponent('https://embedindia.st/')}&title=A%20vs%20B`);
    expect(streams[1].externalUrl).toBe(`/watch?url=${encodeURIComponent(url)}&title=A%20vs%20B`);
  });

  it('honours an explicit referer from the source descriptor', async () => {
    const streams = await makeProvider().resolveStream('x', 'football', 'A vs B', { embedUrl: 'https://embedindia.st/embed/admin/ch5', referer: 'https://watchfooty.st/' });
    expect(streams[0].externalUrl).toContain(encodeURIComponent('https://watchfooty.st/'));
  });

  it('suppresses the extract tier once WASM extraction produced a direct stream', async () => {
    const p = makeProvider();
    p._tryWasmExtraction = async () => ({ name: 'EmbedIndia', title: 'direct', url: 'https://proxy/x.m3u8' });
    const streams = await p.resolveStream('https://embedindia.st/embed/admin/ch5', 'football', 'A vs B');
    expect(streams.map((s) => s.title)).toEqual(['direct', 'A vs B (Web Player)']);
  });

  it('labels untitled events in both tiers', async () => {
    const streams = await makeProvider().resolveStream('https://embedindia.st/embed/admin/ch5', 'football', undefined);
    expect(streams[0].externalUrl).toContain('title=Live%20Event');
    expect(streams[1].externalUrl).toContain('title=Live%20Event');
  });
});

describe('EmbedIndiaProvider._tryWasmExtraction', () => {
  it('ignores embed urls from other providers without spawning anything', async () => {
    const p = new EmbedIndiaProvider(makeCradle());
    const child = require('child_process');
    const spy = spyOn(child, 'execFile');
    expect(await p._tryWasmExtraction('https://embed.st/embed/admin/x/1', 'https://embed.st/', 'A vs B')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('ignores embedindia urls whose channel id cannot be parsed', async () => {
    const p = new EmbedIndiaProvider(makeCradle());
    expect(await p._tryWasmExtraction('https://embedindia.st/', 'https://embedindia.st/', 'A vs B')).toBeNull();
  });

  it('returns nothing for an empty getMatches contract', async () => {
    expect(await makeProvider().getMatches()).toEqual([]);
  });
});
