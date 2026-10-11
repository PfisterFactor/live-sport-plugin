const { describe, test, expect, beforeEach } = require('bun:test');
const crypto = require('crypto');
const ReplayZoneProvider = require('../../../src/providers/ReplayZoneProvider');
const { makeCradle, res } = require('./fixtures/helpers');

function makeProvider() {
  return new ReplayZoneProvider(makeCradle());
}

function byse(key_parts, partA, partB, data) {
  const fullKey = Buffer.concat([partA, partB]);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', fullKey, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  return {
    algorithm: 'AES-256-GCM',
    version: '7',
    iv: iv.toString('base64'),
    payload: Buffer.concat([ciphertext, cipher.getAuthTag()]).toString('base64'),
    key_parts,
  };
}

describe('ReplayZoneProvider - feed parsing', () => {
  const FEED = [
    '# Napoli vs Frosinone',
    '~ Football\tSerie A\thttps://img.test/a.png\t2026-10-10T18:45:00+07:00',
    'Full Match\tiframe\thttps://soccerfull.net/play/16364',
    '',
    '# Dolphins v Roosters - NRL Finals',
    '~ Rugby\tNRL\thttps://img.test/b.jpg\t2026-09-25',
    'Server #1\tiframe\thttps://ok.ru/videoembed/15880151042772',
    'Server #2\tiframe\thttps://bysesukior.com/e/rk823kwq75tt',
    'broken line without tabs',
    'Bad\tiframe\tnot-a-url',
    '',
    '# No sources',
    '~ Football\tX\t\t2026-09-25',
    'Bad\tiframe\tftp://nope',
    '',
    'not a block',
  ].join('\n');

  test('turns blocks into finished replay matches tagged replayzone', async () => {
    const p = makeProvider();
    p.proxyFetch = async () => res({ body: FEED });
    const matches = await p.getMatches();

    expect(matches).toHaveLength(2);
    const [napoli, nrl] = matches;
    expect(napoli.title).toBe('Napoli vs Frosinone');
    expect(napoli.category).toBe('football');
    expect(napoli.league).toBe('Serie A');
    expect(napoli.status).toBe('finished');
    expect(napoli.thumbnail_url).toBe('https://img.test/a.png');
    expect(napoli.sources).toEqual([
      { source: 'replayzone', id: 'https://soccerfull.net/play/16364', name: 'Full Match', url: 'https://soccerfull.net/play/16364', type: 'iframe' },
    ]);
    expect(nrl.sources.map(s => s.name)).toEqual(['Server #1', 'Server #2']);
    expect(napoli.id).not.toBe(nrl.id);
  });

  test('returns an empty list when the feed is unreachable', async () => {
    const p = makeProvider();
    p.proxyFetch = async () => res({ status: 503 });
    expect(await p.getMatches()).toEqual([]);
  });
});

describe('ReplayZoneProvider - Byse Support', () => {
  let provider;
  beforeEach(() => { provider = makeProvider(); });

  test('identifies Byse URLs correctly', () => {
    expect(provider._isByseUrl('https://bysefujedu.com/d/v4kc5zppy3vy')).toBe(true);
    expect(provider._isByseUrl('https://bysesukior.com/e/7zkihbvbnidj')).toBe(true);
    expect(provider._isByseUrl('https://bysecloud.net/e/123')).toBe(true);
    expect(provider._isByseUrl('https://ok.ru/videoembed/123')).toBe(false);
    expect(provider._isByseUrl('https://soccerfull.net/play/15734')).toBe(false);
  });

  function playbackFor(data) {
    const partA = crypto.randomBytes(16);
    const partB = crypto.randomBytes(16);
    const keyParts = [];
    for (let i = 0; i < 30; i++) {
      if (i === 6) keyParts.push(partA.toString('base64'));
      else if (i === 23) keyParts.push(partB.toString('base64'));
      else keyParts.push(crypto.randomBytes(16).toString('base64'));
    }
    return byse(keyParts, partA, partB, data);
  }

  test('decrypts Byse AES-256-GCM playback payload correctly', () => {
    const decrypted = provider._decryptBysePlayback(playbackFor({
      sources: [{ label: '1080p', url: 'https://cdn.example.com/hls/master.m3u8', height: 1080 }],
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    }));
    expect(decrypted.sources).toHaveLength(1);
    expect(decrypted.sources[0].url).toBe('https://cdn.example.com/hls/master.m3u8');
  });

  test('returns null for a tampered payload or malformed playback', () => {
    const playback = playbackFor({ sources: [] });
    const bytes = Buffer.from(playback.payload, 'base64');
    bytes[0] ^= 0xff;
    expect(provider._decryptBysePlayback({ ...playback, payload: bytes.toString('base64') })).toBeNull();
    expect(provider._decryptBysePlayback(null)).toBeNull();
    expect(provider._decryptBysePlayback({ payload: 'x', iv: 'y' })).toBeNull();
  });

  test('formats Byse streams with zero-bandwidth direct headers', () => {
    const streams = provider._formatByseStreams([{ label: '1080p', url: 'https://cdn.example.com/master.m3u8', height: 1080 }], 'bysefujedu.com', 'Part 1');
    expect(streams).toHaveLength(1);
    expect(streams[0].name).toBe('ReplayZone');
    expect(streams[0].title).toBe('Part 1 (1080p)');
    expect(streams[0].resolution).toBe('1080p');
    expect(streams[0].behaviorHints.notWebReady).toBe(true);
    expect(streams[0].behaviorHints.proxyHeaders.request.Origin).toBe('https://bysefujedu.com');
    expect(streams[0].behaviorHints.proxyHeaders.request.Referer).toBe('https://bysefujedu.com/');
  });

  test('resolves a Byse embed through the API and caches the sources', async () => {
    const playback = playbackFor({ sources: [{ label: '720p', url: 'https://cdn.example.com/a.m3u8' }] });
    let calls = 0;
    provider.proxyFetch = async (url) => {
      calls++;
      expect(url).toBe('https://bysesukior.com/api/videos/rk823kwq75tt/');
      return res({ json: { playback } });
    };

    const first = await provider.resolveStream('https://bysesukior.com/e/rk823kwq75tt', 'rugby', 'x', { name: 'Server #2 (HD)' });
    const second = await provider.resolveStream('https://bysesukior.com/e/rk823kwq75tt', 'rugby', 'x', { name: 'Server #2 (HD)' });
    expect(first[0].title).toBe('Server #2 (720p)');
    expect(second).toHaveLength(1);
    expect(calls).toBe(1);
  });
});

describe('ReplayZoneProvider - Dailymotion Handling', () => {
  let provider;
  beforeEach(() => { provider = makeProvider(); });

  test('identifies Dailymotion URLs correctly', () => {
    expect(provider._isDailymotionUrl('https://geo.dailymotion.com/player.html?video=xb73252')).toBe(true);
    expect(provider._isDailymotionUrl('https://www.dailymotion.com/video/xba6mva')).toBe(true);
    expect(provider._isDailymotionUrl('https://dai.ly/xba6mva')).toBe(true);
    expect(provider._isDailymotionUrl('https://ok.ru/videoembed/123')).toBe(false);
  });

  test('extracts Dailymotion video IDs accurately', () => {
    expect(provider._extractDailymotionVideoId('https://geo.dailymotion.com/player.html?video=xb73252')).toBe('xb73252');
    expect(provider._extractDailymotionVideoId('https://www.dailymotion.com/video/xba6mva')).toBe('xba6mva');
    expect(provider._extractDailymotionVideoId('https://www.dailymotion.com/embed/video/xba6mva?autoplay=1')).toBe('xba6mva');
    expect(provider._extractDailymotionVideoId('https://dai.ly/xba6mva')).toBe('xba6mva');
    expect(provider._extractDailymotionVideoId('https://example.com/other')).toBeNull();
  });

  test('drops dead Dailymotion streams when metadata returns an error', async () => {
    provider.proxyFetch = async () => res({ json: { error: { title: 'Content rejected.', message: 'removed (Terms of Use)', code: 'DM005' } } });
    const streams = await provider.resolveStream('https://geo.dailymotion.com/player.html?video=xb73252', 'motorsport', 'Formula 1');
    expect(streams).toEqual([]);
    expect(provider._getCachedDm('xb73252')).toBe(false);
  });

  test('drops Dailymotion streams whose metadata has no qualities', async () => {
    provider.proxyFetch = async () => res({ json: { title: 'Empty Video' } });
    expect(await provider.resolveStream('https://geo.dailymotion.com/player.html?video=empty123', 'motorsport', 'F1')).toEqual([]);
    expect(provider._getCachedDm('empty123')).toBe(false);
  });

  test('serves an active Dailymotion video as a web embed', async () => {
    provider.proxyFetch = async () => res({ json: { qualities: { auto: [{ type: 'application/x-mpegURL', url: 'https://cdn/a.m3u8' }] } } });
    const streams = await provider.resolveStream('https://geo.dailymotion.com/player.html?video=live123', 'motorsport', 'F1', { name: 'Server 3 (DM)' });
    expect(streams).toHaveLength(1);
    expect(streams[0].name).toBe('RZ (External)');
    expect(streams[0].title).toBe('Server 3 (Browser)');
    expect(streams[0].externalUrl).toBe('https://geo.dailymotion.com/player.html?video=live123');
    expect(streams[0]._rzWeb).toBe(true);
    expect(provider._getCachedDm('live123')).toBe(true);
  });

  test('uses the cached verdict without querying the network again', async () => {
    provider._setCachedDm('cachedDead', false);
    provider.proxyFetch = async () => { throw new Error('network must not be touched'); };
    expect(await provider.resolveStream('https://geo.dailymotion.com/player.html?video=cachedDead', 'motorsport', 'F1')).toEqual([]);
  });
});

describe('ReplayZoneProvider - resolve routing', () => {
  let provider;
  beforeEach(() => { provider = makeProvider(); });

  test('serves ok.ru as a web embed, normalising /video/ to /videoembed/', async () => {
    const [s] = await provider.resolveStream('https://ok.ru/video/123456', 'football', 'x', { name: 'Server 1 (OK)' });
    expect(s.externalUrl).toBe('https://ok.ru/videoembed/123456');
    expect(s.title).toBe('Server 1 (ok.ru)');
    expect(s._rzWeb).toBe(true);
  });

  test('returns direct media URLs as notWebReady streams', async () => {
    const [s] = await provider.resolveStream('https://cdn.test/replay/master.m3u8?x=1', 'football', 'x', { name: 'Full Match' });
    expect(s.url).toBe('https://cdn.test/replay/master.m3u8?x=1');
    expect(s.title).toBe('Full Match (Direct)');
    expect(s.behaviorHints.notWebReady).toBe(true);
  });

  test('drops an external page that answers 404/410 but keeps one that merely errors', async () => {
    provider.proxyFetch = async () => res({ status: 404 });
    expect(await provider.resolveStream('https://gone.test/page', 'football', 'x')).toEqual([]);

    const p2 = makeProvider();
    p2.proxyFetch = async () => res({ status: 403 });
    const [s] = await p2.resolveStream('https://picky.test/page', 'football', 'x', { name: 'Server 2' });
    expect(s.externalUrl).toBe('https://picky.test/page');

    const p3 = makeProvider();
    p3.proxyFetch = async () => { throw new Error('timeout'); };
    expect(await p3.resolveStream('https://slow.test/page', 'football', 'x')).toHaveLength(1);
  });

  test('extracts soccerfull iframes into streams', async () => {
    provider.proxyFetch = async () => res({ body: '<html><iframe src="https://ok.ru/videoembed/1"></iframe><iframe src="https://cdn.test/a.m3u8"></iframe></html>' });
    const streams = await provider.resolveStream('https://soccerfull.net/play/1', 'football', 'x', { name: 'Full Match' });
    expect(streams.map(s => s.title)).toEqual(['Full Match (ok.ru)', 'Full Match (Direct)']);
  });

  test('returns nothing without a url', async () => {
    expect(await provider.resolveStream('', 'football', 'x')).toEqual([]);
  });
});
