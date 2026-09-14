const { describe, it, expect, beforeAll, afterAll, afterEach, spyOn } = require('bun:test');

const impitClient = require('../../../src/impitClient');

let echo;
let echoUrl;
let impitSpy;

beforeAll(() => {
  echo = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/status') {
        return new Response('upstream said no', { status: 503, headers: { 'X-Upstream': 'edge-7' } });
      }
      const body = await req.text();
      return new Response(JSON.stringify({ method: req.method, body, ct: req.headers.get('content-type') }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'X-Echo': 'yes' },
      });
    },
  });
  echoUrl = `http://127.0.0.1:${echo.port}`;
});

afterAll(() => echo.stop(true));

afterEach(() => {
  if (impitSpy) impitSpy.mockRestore();
  impitSpy = undefined;
});

const impit = () => impitClient.getImpit();

describe('safeFetch impit path', () => {
  it('is the client actually in use on this platform', () => {
    expect(impitClient.isImpitAvailable()).toBe(true);
    expect(impit()).not.toBeNull();
  });

  it('returns impit status, normalized headers and body without touching undici', async () => {
    impitSpy = spyOn(impit(), 'fetch').mockImplementation(async () => ({
      status: 204,
      headers: new Headers({ 'X-Cache': 'HIT', 'Content-Type': 'application/vnd.apple.mpegurl' }),
      text: async () => '#EXTM3U',
    }));

    const res = await impitClient.safeFetch('https://cdn.example.com/a.m3u8');
    expect(res.ok).toBe(true);
    expect(res.status).toBe(204);
    expect(res.headers['x-cache']).toBe('HIT');
    expect(res.headers['content-type']).toBe('application/vnd.apple.mpegurl');
    expect(await res.text()).toBe('#EXTM3U');
    expect(impitSpy).toHaveBeenCalledTimes(1);
  });

  it('reports a non-2xx impit response as not ok rather than throwing', async () => {
    impitSpy = spyOn(impit(), 'fetch').mockImplementation(async () => ({
      status: 403, headers: {}, text: async () => 'denied',
    }));
    const res = await impitClient.safeFetch('https://cdn.example.com/a.m3u8');
    expect(res.ok).toBe(false);
    expect(res.status).toBe(403);
  });

  it('forwards method, headers and body to impit', async () => {
    let seen;
    impitSpy = spyOn(impit(), 'fetch').mockImplementation(async (url, opts) => {
      seen = { url, opts };
      return { status: 200, headers: {}, text: async () => '{"a":1}' };
    });
    const res = await impitClient.safeFetch('https://cdn.example.com/p', {
      method: 'POST',
      headers: { 'X-Token': 't' },
      body: 'payload',
    });
    expect(seen.opts).toEqual({ method: 'POST', headers: { 'X-Token': 't' }, body: 'payload' });
    expect(await res.json()).toEqual({ a: 1 });
  });

  it('retries impit three times before giving up on it', async () => {
    impitSpy = spyOn(impit(), 'fetch').mockImplementation(async () => { throw new Error('napi boom'); });
    const res = await impitClient.safeFetch(`${echoUrl}/echo`);
    expect(impitSpy).toHaveBeenCalledTimes(3);
    expect(res.status).toBe(200);
  }, 15000);
});

describe('safeFetch undici fallback', () => {
  it('propagates status, headers and body from undici when impit is broken', async () => {
    impitSpy = spyOn(impit(), 'fetch').mockImplementation(async () => { throw new Error('napi boom'); });
    const res = await impitClient.safeFetch(`${echoUrl}/status`);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(503);
    expect(res.headers['x-upstream']).toBe('edge-7');
    expect(await res.text()).toBe('upstream said no');
  }, 15000);

  it('honours method and body on the fallback path', async () => {
    impitSpy = spyOn(impit(), 'fetch').mockImplementation(async () => { throw new Error('napi boom'); });
    const res = await impitClient.safeFetch(`${echoUrl}/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'hello-body',
    });
    expect(await res.json()).toEqual({ method: 'POST', body: 'hello-body', ct: 'text/plain' });
  }, 15000);

  it('abandons a hung impit call inside the deadline and still answers from undici', async () => {
    impitSpy = spyOn(impit(), 'fetch').mockImplementation(() => new Promise(() => {}));
    const started = Date.now();
    const res = await impitClient.safeFetch(`${echoUrl}/echo`, { timeoutMs: 1000 });
    const elapsed = Date.now() - started;
    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(1500);
    expect(impitSpy).toHaveBeenCalledTimes(1);
  }, 15000);

  it('does not spend more than timeoutMs in total when every path is dead', async () => {
    impitSpy = spyOn(impit(), 'fetch').mockImplementation(() => new Promise(() => {}));
    const started = Date.now();
    await expect(
      impitClient.safeFetch('http://127.0.0.1:1/echo', { timeoutMs: 1000 })
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1500);
  }, 15000);
});
