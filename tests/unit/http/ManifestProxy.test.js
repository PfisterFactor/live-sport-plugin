const { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, spyOn } = require('bun:test');

const impitClient = require('../../../src/impitClient');
const { parseSafeTargetUrl } = require('../../../src/routes/manifestProxy');
const app = require('../../../src/app');
const container = require('../../../src/container');
const renewal = require('../../../src/services/StreamRenewal');

let server;
let base;
let safeFetchSpy;
let calls;

const upstream = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: {},
  text: async () => body,
  json: async () => JSON.parse(body),
});

let uid = 0;
const freshUrl = () => `https://cdn.example.com/live/${++uid}/index.m3u8`;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => server.close());

beforeEach(() => {
  calls = [];
  safeFetchSpy = spyOn(impitClient, 'safeFetch').mockImplementation(async (url, opts) => {
    calls.push({ url, opts });
    return upstream('#EXTM3U\n#EXT-X-TARGETDURATION:6\nseg1.ts\n');
  });
});

afterEach(() => safeFetchSpy.mockRestore());

const proxy = (target, extra = '') =>
  fetch(`${base}/api/manifest?url=${encodeURIComponent(target)}${extra}`);

describe('parseSafeTargetUrl', () => {
  it('accepts public http(s) targets', () => {
    expect(parseSafeTargetUrl('https://cdn.example.com/a.m3u8').hostname).toBe('cdn.example.com');
    expect(parseSafeTargetUrl('http://8.8.8.8/a.m3u8').hostname).toBe('8.8.8.8');
  });

  it('rejects non-http schemes and internal hosts', () => {
    for (const bad of [
      'file:///etc/passwd',
      'gopher://cdn.example.com/',
      'http://localhost:7000/health',
      'http://app.localhost/health',
      'http://127.0.0.1/admin',
      'http://127.1.2.3/admin',
      'http://0.0.0.0/',
      'http://10.1.2.3/',
      'http://172.16.0.9/',
      'http://172.31.255.1/',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://100.100.100.200/',
      'http://[::1]/',
      'http://[fd00::1]/',
      'http://[fe80::1]/',
      'http://[::ffff:127.0.0.1]/',
      '',
      'not a url',
    ]) {
      expect(parseSafeTargetUrl(bad)).toBeNull();
    }
  });

  it('still allows public addresses adjacent to the private ranges', () => {
    expect(parseSafeTargetUrl('http://172.32.0.1/')).not.toBeNull();
    expect(parseSafeTargetUrl('http://172.15.0.1/')).not.toBeNull();
    expect(parseSafeTargetUrl('http://169.253.0.1/')).not.toBeNull();
  });

  it('resolves percent-encoded targets before validating them', () => {
    expect(parseSafeTargetUrl(encodeURIComponent('http://127.0.0.1/x'))).toBeNull();
  });
});

describe('GET /api/manifest', () => {
  it('requires a url', async () => {
    const res = await fetch(`${base}/api/manifest`);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('Missing url');
  });

  it('refuses to proxy internal or non-http targets without calling upstream', async () => {
    for (const bad of [
      'file:///etc/passwd',
      'http://127.0.0.1/admin',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/',
      'http://localhost:7000/health',
      'http://192.168.0.10/x.m3u8',
    ]) {
      const res = await proxy(bad);
      expect(res.status).toBe(400);
      expect(await res.text()).toBe('Invalid url');
    }
    expect(calls).toHaveLength(0);
  });

  it('rewrites media segment URIs to absolute and inherits manifest query params', async () => {
    const target = 'https://cdn.example.com/live/q/index.m3u8?token=abc';
    safeFetchSpy.mockImplementation(async () => upstream(
      '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg1.ts\n#EXTINF:6,\n/abs/seg2.ts?token=own\n#EXT-X-ENDLIST\n'
    ));
    const body = await (await proxy(target)).text();
    expect(body).toContain('https://cdn.example.com/live/q/seg1.ts?token=abc');
    expect(body).toContain('https://cdn.example.com/abs/seg2.ts?token=own');
  });

  it('routes master playlist variants back through the proxy with referer and origin', async () => {
    const target = 'https://cdn.example.com/live/m/master.m3u8';
    safeFetchSpy.mockImplementation(async () => upstream(
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1200000\n720/index.m3u8\n#EXT-X-ENDLIST\n'
    ));
    const body = await (await proxy(target, '&referer=https%3A%2F%2Fref.example%2F&origin=https%3A%2F%2Fref.example')).text();
    const line = body.split('\n').find((l) => l.startsWith('/api/manifest'));
    expect(line).toBeDefined();
    const q = new URL(`http://x${line}`).searchParams;
    expect(q.get('url')).toBe('https://cdn.example.com/live/m/720/index.m3u8');
    expect(q.get('referer')).toBe('https://ref.example/');
    expect(q.get('origin')).toBe('https://ref.example');
  });

  const segments = (n, dur) => Array.from({ length: n }, (_, i) => `#EXTINF:${dur},\nseg${i}.ts`).join('\n');
  const startTag = (body) => body.split('\n').filter((l) => l.startsWith('#EXT-X-START'));

  it('starts a wide live window 15s behind the edge', async () => {
    safeFetchSpy.mockImplementation(async () => upstream(`#EXTM3U\n#EXT-X-TARGETDURATION:4\n${segments(10, 4)}\n`));
    expect(startTag(await (await proxy(freshUrl())).text())).toEqual(['#EXT-X-START:TIME-OFFSET=-15']);
  });

  it('caps the start offset so three target durations of old segments remain', async () => {
    safeFetchSpy.mockImplementation(async () => upstream(`#EXTM3U\n#EXT-X-TARGETDURATION:2\n${segments(10, 2)}\n`));
    expect(startTag(await (await proxy(freshUrl())).text())).toEqual(['#EXT-X-START:TIME-OFFSET=-14']);
  });

  it('leaves the player default on short windows, master playlists, and VOD', async () => {
    safeFetchSpy.mockImplementation(async () => upstream(`#EXTM3U\n#EXT-X-TARGETDURATION:4\n${segments(6, 4)}\n`));
    expect(startTag(await (await proxy(freshUrl())).text())).toHaveLength(0);

    safeFetchSpy.mockImplementation(async () => upstream('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1200000\n720/index.m3u8\n'));
    expect(startTag(await (await proxy(freshUrl())).text())).toHaveLength(0);

    safeFetchSpy.mockImplementation(async () => upstream(`#EXTM3U\n#EXT-X-TARGETDURATION:4\n${segments(10, 4)}\n#EXT-X-ENDLIST\n`));
    expect(startTag(await (await proxy(freshUrl())).text())).toHaveLength(0);
  });

  it('marks every playlist response no-store', async () => {
    const target = freshUrl();
    expect((await proxy(target)).headers.get('cache-control')).toBe('no-store');
    expect((await proxy(target)).headers.get('cache-control')).toBe('no-store');
  });

  it('serves the second request from cache', async () => {
    const target = freshUrl();
    const first = await proxy(target);
    expect(first.headers.get('x-manifest-cache')).toBe('MISS');
    expect(first.headers.get('content-type')).toContain('mpegurl');
    const firstBody = await first.text();

    const second = await proxy(target);
    expect(second.headers.get('x-manifest-cache')).toBe('HIT');
    expect(await second.text()).toBe(firstBody);
    expect(calls).toHaveLength(1);
  });

  it('keys the cache on referer and origin as well as url', async () => {
    const target = freshUrl();
    await proxy(target, '&referer=https%3A%2F%2Fa.example%2F');
    const other = await proxy(target, '&referer=https%3A%2F%2Fb.example%2F');
    expect(other.headers.get('x-manifest-cache')).toBe('MISS');
    expect(calls).toHaveLength(2);
    expect(calls[0].opts.headers.Referer).toBe('https://a.example/');
    expect(calls[1].opts.headers.Referer).toBe('https://b.example/');
  });

  it('maps a non-m3u8 upstream body to 404 and caches it negatively', async () => {
    const target = freshUrl();
    safeFetchSpy.mockImplementation(async () => {
      calls.push({});
      return upstream('<html>blocked</html>');
    });
    const first = await proxy(target);
    expect(first.status).toBe(404);
    expect(await first.text()).toBe('Stream not found or expired');

    const second = await proxy(target);
    expect(second.status).toBe(404);
    expect(second.headers.get('x-manifest-cache')).toBe('NEGATIVE');
    expect(calls).toHaveLength(1);
  });

  it('maps an upstream error status to 502 and caches it negatively', async () => {
    const target = freshUrl();
    safeFetchSpy.mockImplementation(async () => {
      calls.push({});
      return upstream('nope', 500);
    });
    const first = await proxy(target);
    expect(first.status).toBe(502);
    expect(await first.text()).toContain('HTTP 500');

    const second = await proxy(target);
    expect(second.status).toBe(502);
    expect(second.headers.get('x-manifest-cache')).toBe('NEGATIVE');
    expect(calls).toHaveLength(1);
  });

  it('coalesces concurrent misses into one upstream fetch', async () => {
    const target = freshUrl();
    let release;
    const gate = new Promise((r) => { release = r; });
    safeFetchSpy.mockImplementation(async () => {
      calls.push({});
      await gate;
      return upstream('#EXTM3U\n#EXT-X-TARGETDURATION:6\nseg1.ts\n');
    });

    const pending = [proxy(target), proxy(target), proxy(target)];
    await new Promise((r) => setTimeout(r, 20));
    release();
    const bodies = await Promise.all((await Promise.all(pending)).map((r) => r.text()));

    expect(calls).toHaveLength(1);
    expect(new Set(bodies).size).toBe(1);
  });

  it('fetches upstream once with a 5s budget', async () => {
    await proxy(freshUrl());
    expect(calls[0].opts.timeoutMs).toBe(5000);
    expect(calls[0].opts.attempts).toBe(1);
  });
});

describe('GET /api/manifest token renewal', () => {
  const PLAYLIST = '#EXTM3U\n#EXT-X-TARGETDURATION:6\nseg1.ts\n';
  let embed;
  let dead;
  let fresh;
  let extractSpy;

  const renewable = (extra = '') =>
    proxy(dead, `&renew=timstreams&embed=${encodeURIComponent(embed)}${extra}`);

  beforeEach(() => {
    renewal.reset();
    uid++;
    embed = `https://embed.example.com/e${uid}`;
    dead = `https://cdn.example.com/secure/dead${uid}/1000/live.m3u8`;
    fresh = `https://cdn.example.com/secure/fresh${uid}/9999/live.m3u8`;
    extractSpy = spyOn(container.resolve('timStreamsProvider'), 'extractM3u8')
      .mockImplementation(async () => ({ m3u8: fresh, referer: 'https://embed.example.com' }));
    safeFetchSpy.mockImplementation(async (url, opts) => {
      calls.push({ url, opts });
      return url === fresh ? upstream(PLAYLIST) : upstream('Gone - Token expired', 410);
    });
  });

  afterEach(() => extractSpy.mockRestore());

  it('re-mints an expired token and serves the fresh manifest', async () => {
    const res = await renewable();
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`https://cdn.example.com/secure/fresh${uid}/9999/seg1.ts`);
    expect(extractSpy).toHaveBeenCalledTimes(1);
  });

  it('reuses the re-minted token instead of scraping the embed on every poll', async () => {
    await renewable();
    const second = await renewable('&origin=https%3A%2F%2Fother.example');
    expect(second.status).toBe(200);
    expect(extractSpy).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.url === dead)).toHaveLength(1);
  });

  it('fails without renewing when the stream is dead rather than the token', async () => {
    safeFetchSpy.mockImplementation(async (url) => {
      calls.push({ url });
      return upstream('upstream down', 500);
    });
    const res = await renewable();
    expect(res.status).toBe(502);
    expect(extractSpy).not.toHaveBeenCalled();
  });

  it('ignores a renewal descriptor naming an unknown source', async () => {
    const res = await proxy(dead, `&renew=nosuchsource&embed=${encodeURIComponent(embed)}`);
    expect(res.status).toBe(502);
    expect(extractSpy).not.toHaveBeenCalled();
  });

  it('passes the renewal descriptor down to variant playlists of a master', async () => {
    const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=8000000\nhigh/mono.m3u8\n';
    safeFetchSpy.mockImplementation(async (url) => {
      calls.push({ url });
      return url === fresh ? upstream(master) : upstream('Gone - Token expired', 410);
    });
    const body = await (await renewable()).text();
    const child = body.split('\n').find((l) => l.startsWith('/api/manifest'));
    const q = new URL(`http://x${child}`).searchParams;
    expect(q.get('renew')).toBe('timstreams');
    expect(q.get('embed')).toBe(embed);
    expect(q.get('base')).toBe(dead);
    expect(q.get('rel')).toBe('high/mono.m3u8');
  });

  it('rebuilds a dead variant playlist against the re-minted master', async () => {
    const freshVariant = new URL('high/mono.m3u8', fresh).toString();
    safeFetchSpy.mockImplementation(async (url) => {
      calls.push({ url });
      return url === freshVariant ? upstream(PLAYLIST) : upstream('Gone - Token expired', 410);
    });
    const deadVariant = new URL('high/mono.m3u8', dead).toString();
    const res = await proxy(deadVariant,
      `&renew=timstreams&embed=${encodeURIComponent(embed)}&base=${encodeURIComponent(dead)}&rel=${encodeURIComponent('high/mono.m3u8')}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(new URL('seg1.ts', freshVariant).toString());
    expect(extractSpy).toHaveBeenCalledTimes(1);
  });

  it('drops a re-minted url whose edge host stops answering and mints another', async () => {
    const second = `https://cdn.example.com/secure/second${uid}/9999/live.m3u8`;
    let minted = 0;
    extractSpy.mockImplementation(async () => ({ m3u8: ++minted === 1 ? fresh : second, referer: null }));
    safeFetchSpy.mockImplementation(async (url) => {
      calls.push({ url });
      if (url === second) return upstream(PLAYLIST);
      if (url === fresh) throw new Error('The operation timed out.');
      return upstream('Gone - Token expired', 410);
    });

    expect((await renewable()).status).toBe(502);
    await new Promise((r) => setTimeout(r, renewal.MIN_RENEW_INTERVAL_MS + 50));
    const healed = await renewable();
    expect(healed.status).toBe(200);
    expect(await healed.text()).toContain(`https://cdn.example.com/secure/second${uid}/9999/seg1.ts`);
    expect(minted).toBe(2);
  }, renewal.MIN_RENEW_INTERVAL_MS + 10000);
});
