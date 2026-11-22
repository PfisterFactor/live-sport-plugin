const { describe, test, expect, afterEach } = require('bun:test');
const VavooProvider = require('../../../src/providers/VavooProvider');
const { makeCradle, res } = require('./fixtures/helpers');

const REAL_PLAY = 'https://vavoo.to/vavoo-iptv/play/338305598923178e2e001f';

afterEach(() => { delete process.env.VAVOO_ENABLED; });

describe('VavooProvider', () => {
  test('is disabled unless VAVOO_ENABLED=true', async () => {
    expect(await new VavooProvider(makeCradle()).getMatches()).toEqual([]);
  });

  test('collapses feeds of one channel into a networks match', async () => {
    process.env.VAVOO_ENABLED = 'true';
    const matches = await new VavooProvider(makeCradle()).getMatches();
    expect(matches.length).toBeGreaterThan(500);
    const sky = matches.find((m) => m.title === 'SKY SPORT 1 - Germany');
    expect(sky.category).toBe('networks');
    expect(sky.sources.length).toBeGreaterThan(1);
    expect(new Set(matches.map((m) => m.id)).size).toBe(matches.length);
  });

  test('channelKey and serverTag normalise variants', () => {
    expect(VavooProvider.channelKey('SKY SPORT 1 (BACKUP) .b')).toBe(VavooProvider.channelKey('SKY SPORT 1 HD .c'));
    expect(VavooProvider.serverTag('SKY SPORT 1 .c')).toBe('Server C');
    expect(VavooProvider.serverTag('SKY SPORT 1 (BACKUP) .b')).toBe('Backup');
  });

  test('resolves via signature and mirror, then proxies the HLS URL', async () => {
    process.env.VAVOO_ENABLED = 'true';
    const p = new VavooProvider(makeCradle());
    const seen = [];
    p.proxyFetch = async (url, opts) => {
      seen.push(url);
      if (url.includes('vypn.net')) return res({ json: { addonSig: 'c2ln' } });
      expect(opts.headers['mediahubmx-signature']).toBe('c2ln');
      return res({ json: [{ id: 'SKY SPORT 1 .b', url: 'http://185.156.74.195:8008/sunshine/abc' }] });
    };
    const [stream] = await p.resolveStream(REAL_PLAY, 'networks', 'SKY SPORT 1 - Germany', { id: REAL_PLAY, channelName: 'SKY SPORT 1 .b', group: 'Germany' });
    const q = new URL(stream.url).searchParams;
    expect(q.get('url')).toBe('http://185.156.74.195:8008/sunshine/abc');
    expect(q.get('referer')).toBe('https://vavoo.to/');
    expect(stream.title).toBe('Vavoo (SKY SPORT 1 - Germany) [Server B]');
  });

  test('rotates mirrors on gateway errors and refuses foreign hosts', async () => {
    process.env.VAVOO_ENABLED = 'true';
    const p = new VavooProvider(makeCradle());
    let resolves = 0;
    p.proxyFetch = async (url) => {
      if (url.includes('vypn.net')) return res({ json: { addonSig: 'c2ln' } });
      resolves += 1;
      return resolves === 1 ? res({ status: 502 }) : res({ json: { url: 'http://1.2.3.4/x.m3u8' } });
    };
    expect((await p.resolveStream(REAL_PLAY, 'networks', 'X', { id: REAL_PLAY })).length).toBe(1);
    expect(resolves).toBe(2);
    expect(await p.resolveStream('https://evil.example/play/1', 'networks', 'X', {})).toEqual([]);
  });
});
