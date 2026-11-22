const { describe, test, expect, beforeAll, afterAll, beforeEach, setSystemTime } = require('bun:test');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createApp } = require('../../../src/httpApp');
const DashToHlsService = require('../../../src/services/DashToHlsService');
const { createDashRoutes, LruCache, createLimiter, singleFlight } = require('../../../src/routes/dash');
const { signPayload, verifyPayload } = require('../../../src/services/DashPayload');
const { buildInit, buildSegment, sample, IV8, KEY_HEX, KID_HEX, OTHER_KID } = require('../services/fixtures/cenc-fixtures');

const secret = crypto.createHash('sha256').update('dash-route-unit-tests').digest('hex');
const NITRO_MPD_URL = 'https://otte.live.fly.ww.aiv-cdn.net/fra-nitro/out/v1/ab9d1f/cenc.mpd';
const payload = { mpdUrl: NITRO_MPD_URL, key: KEY_HEX, kid: KID_HEX, headers: {} };
const token = (p = payload, opts = {}) => signPayload(p, { secret, ...opts });

const nitroXml = fs.readFileSync(path.join(__dirname, '../services/fixtures/nitro-live.mpd'), 'utf8');

describe('GET /api/dash/* routes', () => {
  let server;
  let baseUrl;
  let repId;
  let calls;
  let initBuf;
  let segmentBuf;
  let plainSample;
  let routes;
  let wrongKidSegment;

  beforeAll(async () => {
    initBuf = buildInit();
    plainSample = sample(48, IV8(21), [{ clear: 4, cipher: 44 }]);
    segmentBuf = buildSegment([{ trackId: 1, runs: [[plainSample]] }]);
    wrongKidSegment = buildSegment([{ trackId: 1, sencKid: OTHER_KID, runs: [[plainSample]] }]);
    calls = [];

    const fetcher = async (url) => {
      calls.push(url);
      if (/\.mpd/.test(url)) return { ok: true, status: 200, url, text: async () => nitroXml };
      if (/init\.mp4/.test(url)) return { ok: true, status: 200, url, arrayBuffer: async () => Buffer.from(initBuf) };
      if (/_9999\.mp4/.test(url)) return { ok: true, status: 200, url, arrayBuffer: async () => Buffer.from(wrongKidSegment) };
      if (/_8570\.mp4/.test(url)) return { ok: false, status: 404, url, arrayBuffer: async () => new ArrayBuffer(0) };
      if (/\.mp4/.test(url)) return { ok: true, status: 200, url, arrayBuffer: async () => Buffer.from(segmentBuf) };
      return { ok: false, status: 404, url, text: async () => '' };
    };

    const service = new DashToHlsService({ fetcher });
    repId = service.parseMpd(nitroXml, NITRO_MPD_URL).videoReps[0].id;
    routes = createDashRoutes(service, { fetcher, secret });
    const app = createApp();
    routes.mount(app);
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(() => server.close());
  beforeEach(() => { calls.length = 0; });

  test('master playlist is served for a signed token', async () => {
    const res = await fetch(`${baseUrl}/api/dash/index.m3u8?d=${token()}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/vnd.apple.mpegurl');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.text();
    expect(body).toContain('#EXT-X-STREAM-INF:');
    expect(body).toMatch(/URI="https?:\/\/[^"]+\/api\/dash\/audio\.m3u8\?d=/);
  });

  test('child playlists carry a freshly signed, expiring token', async () => {
    const res = await fetch(`${baseUrl}/api/dash/video.m3u8?d=${token()}`);
    expect(res.status).toBe(200);
    const childToken = (await res.text()).match(/init\.mp4\?d=([^&]+)&/)[1];
    const verified = verifyPayload(childToken, { secret });

    expect(verified.ok).toBe(true);
    expect(verified.payload.e).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  test('init.mp4 returns the uncloaked moov with no protected boxes', async () => {
    const res = await fetch(`${baseUrl}/api/dash/init.mp4?d=${token()}&k=video&r=${repId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('immutable');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.includes(Buffer.from('encv', 'latin1'))).toBe(false);
    expect(body.includes(Buffer.from('sinf', 'latin1'))).toBe(false);
    expect(body.length).toBe(initBuf.length);
  });

  test('segment.mp4 returns decrypted plaintext, not ciphertext', async () => {
    const res = await fetch(`${baseUrl}/api/dash/segment.mp4?d=${token()}&k=video&r=${repId}&n=8550`);
    expect(res.status).toBe(200);
    const body = Buffer.from(await res.arrayBuffer());

    expect(body.length).toBe(segmentBuf.length);
    expect(body.subarray(body.length - 48).equals(plainSample.plain)).toBe(true);
    expect(body.includes(Buffer.from('senc', 'latin1'))).toBe(false);
  });

  test('serves a repeated segment from cache without touching the CDN again', async () => {
    const url = `${baseUrl}/api/dash/segment.mp4?d=${token()}&k=video&r=${repId}&n=8551`;
    expect((await fetch(url)).status).toBe(200);
    expect(calls.filter((c) => c.includes('_8551.mp4')).length).toBe(1);

    expect((await fetch(url)).status).toBe(200);
    expect(calls.filter((c) => c.includes('_8551.mp4')).length).toBe(1);
  });

  test('coalesces two concurrent requests for the same segment into one upstream fetch', async () => {
    const url = `${baseUrl}/api/dash/segment.mp4?d=${token()}&k=video&r=${repId}&n=8552`;
    const [a, b] = await Promise.all([fetch(url), fetch(url)]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(calls.filter((c) => c.includes('_8552.mp4')).length).toBe(1);
  });

  test('rejects an unsigned (plain base64) payload with 403 on every endpoint', async () => {
    const legacy = Buffer.from(JSON.stringify(payload)).toString('base64url');
    for (const p of ['index.m3u8', 'video.m3u8', 'audio.m3u8', 'init.mp4', 'segment.mp4']) {
      const res = await fetch(`${baseUrl}/api/dash/${p}?d=${legacy}&k=video&r=${repId}&n=8550`);
      expect(res.status).toBe(403);
    }
    expect(calls).toHaveLength(0);
  });

  test('rejects a tampered signature and an expired token with 403', async () => {
    const [body] = token().split('.');
    expect((await fetch(`${baseUrl}/api/dash/index.m3u8?d=${body}.${'A'.repeat(43)}`)).status).toBe(403);
    expect((await fetch(`${baseUrl}/api/dash/index.m3u8?d=${token(payload, { ttlSec: -60 })}`)).status).toBe(403);
  });

  test('rejects a token signed with another secret', async () => {
    const foreign = signPayload(payload, { secret: 'another-secret-another-secret' });
    expect((await fetch(`${baseUrl}/api/dash/index.m3u8?d=${foreign}`)).status).toBe(403);
  });

  test('rejects a missing token with 400 and a bad segment number with 400', async () => {
    expect((await fetch(`${baseUrl}/api/dash/index.m3u8`)).status).toBe(400);
    const res = await fetch(`${baseUrl}/api/dash/segment.mp4?d=${token()}&k=video&r=${repId}&n=abc`);
    expect(res.status).toBe(400);
  });

  test('a client-supplied u= parameter is ignored (no open proxy)', async () => {
    const res = await fetch(
      `${baseUrl}/api/dash/segment.mp4?d=${token()}&k=video&r=${repId}&n=8553&u=${encodeURIComponent('http://169.254.169.254/')}`
    );
    expect(res.status).toBe(200);
    expect(calls.some((c) => c.includes('169.254'))).toBe(false);
  });

  test('refuses an MPD on a private host even when the token is signed', async () => {
    const evil = token({ ...payload, mpdUrl: 'http://169.254.169.254/latest/meta-data/x.mpd' });
    const res = await fetch(`${baseUrl}/api/dash/index.m3u8?d=${evil}`);
    expect(res.status).toBe(403);
    expect(calls.some((c) => c.includes('169.254'))).toBe(false);
  });

  test('a segment whose KID has no key fails with 502 and never returns bytes', async () => {
    const res = await fetch(`${baseUrl}/api/dash/segment.mp4?d=${token()}&k=video&r=${repId}&n=9999`);
    expect(res.status).toBe(502);
    expect(await res.text()).toContain('KID_MISSING');
  });

  test('an upstream error status becomes 502', async () => {
    const res = await fetch(`${baseUrl}/api/dash/segment.mp4?d=${token()}&k=video&r=${repId}&n=8570`);
    expect(res.status).toBe(502);
  });

  test('an unknown representation is a 502, not a crash', async () => {
    const res = await fetch(`${baseUrl}/api/dash/video.m3u8?d=${token()}&r=nope`);
    expect(res.status).toBe(502);
  });

  test('the deprecated key.ts endpoint is gone', async () => {
    expect((await fetch(`${baseUrl}/api/dash/key.ts?k=${KEY_HEX}`)).status).toBe(404);
  });
});

describe('dash route primitives', () => {
  test('LruCache evicts the least recently used entry and expires by age', () => {
    const cache = new LruCache({ max: 2, ttlMs: 1000 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a');
    cache.set('c', 3);
    expect(cache.get('b')).toBeNull();
    expect(cache.get('a')).toBe(1);

    setSystemTime(Date.now() + 1500);
    try {
      expect(cache.get('a')).toBeNull();
    } finally {
      setSystemTime();
    }
  });

  test('createLimiter never runs more than max jobs at once', async () => {
    const limit = createLimiter(2);
    let active = 0;
    let peak = 0;
    const job = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
    };
    await Promise.all(Array.from({ length: 8 }, () => limit(job)));
    expect(peak).toBe(2);
  });

  test('singleFlight shares one promise per key and clears it afterwards', async () => {
    const map = new Map();
    let runs = 0;
    const fn = async () => { runs += 1; return runs; };
    const [a, b] = await Promise.all([singleFlight(map, 'k', fn), singleFlight(map, 'k', fn)]);
    expect([a, b]).toEqual([1, 1]);
    expect(map.size).toBe(0);
    expect(await singleFlight(map, 'k', fn)).toBe(2);
  });
});
