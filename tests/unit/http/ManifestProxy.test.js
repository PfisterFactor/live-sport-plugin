const { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, spyOn } = require('bun:test');

const impitClient = require('../../../src/impitClient');
const { parseSafeTargetUrl } = require('../../../src/routes/manifestProxy');
const app = require('../../../src/app');

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

  it('injects a live edge offset only for playlists without ENDLIST', async () => {
    const live = freshUrl();
    safeFetchSpy.mockImplementation(async () => upstream('#EXTM3U\n#EXT-X-TARGETDURATION:6\nseg1.ts\n'));
    const liveBody = await (await proxy(live)).text();
    expect(liveBody.split('\n').filter((l) => l.startsWith('#EXT-X-START'))).toHaveLength(1);

    const vod = freshUrl();
    safeFetchSpy.mockImplementation(async () => upstream('#EXTM3U\n#EXT-X-TARGETDURATION:6\nseg1.ts\n#EXT-X-ENDLIST\n'));
    const vodBody = await (await proxy(vod)).text();
    expect(vodBody).not.toContain('#EXT-X-START');
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

  it('applies a 10s upstream timeout budget', async () => {
    await proxy(freshUrl());
    expect(calls[0].opts.timeoutMs).toBe(10000);
  });
});
