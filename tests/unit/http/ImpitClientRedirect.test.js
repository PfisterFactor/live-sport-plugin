const { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, spyOn } = require('bun:test');

const impitClient = require('../../../src/impitClient');

const PLAYLIST = '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:5.0,\nseg0.ts\n';
const FORBIDDEN = '<html><title>403 Forbidden</title></html>';

let server;
let base;
let hits;
let lastRequest;
let impitSpy;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      hits[url.pathname] = (hits[url.pathname] || 0) + 1;
      const body = await req.text();
      lastRequest = { method: req.method, body, headers: Object.fromEntries(req.headers) };
      switch (url.pathname) {
        case '/ok': return new Response(PLAYLIST, { status: 200 });
        case '/moved': return new Response('', { status: 301, headers: { Location: `${base}/ok` } });
        case '/relative': return new Response('', { status: 302, headers: { Location: '/ok' } });
        case '/nolocation': return new Response('', { status: 302 });
        case '/loop': return new Response('', { status: 302, headers: { Location: `${base}/loop` } });
        case '/post-moved': return new Response('', { status: 301, headers: { Location: `${base}/echo` } });
        case '/post-kept': return new Response('', { status: 307, headers: { Location: `${base}/echo` } });
        case '/echo': return new Response(JSON.stringify({ method: req.method, body }), { status: 200 });
        case '/to-metadata': return new Response('', { status: 302, headers: { Location: 'http://169.254.169.254/latest/meta-data/' } });
        default: return new Response('nope', { status: 404 });
      }
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

beforeEach(() => {
  hits = {};
  lastRequest = null;
});

afterEach(() => {
  if (impitSpy) impitSpy.mockRestore();
  impitSpy = undefined;
});

/** Forces the undici path: impit fails the way a missing native binary does. */
function breakImpit() {
  impitSpy = spyOn(impitClient.getImpit(), 'fetch').mockImplementation(async () => {
    throw new Error('simulated native addon failure');
  });
}

describe('safeFetch undici path follows redirects', () => {
  beforeEach(breakImpit);

  it('follows a 301 and resolves with the final response', async () => {
    const res = await impitClient.safeFetch(`${base}/moved`, { attempts: 1 });
    expect(res.ok).toBe(true);
    expect(await res.text()).toBe(PLAYLIST);
    expect(hits['/moved']).toBe(1);
    expect(hits['/ok']).toBe(1);
  });

  it('resolves a relative Location against the hop it came from', async () => {
    const res = await impitClient.safeFetch(`${base}/relative`, { attempts: 1 });
    expect(res.status).toBe(200);
    expect(hits['/ok']).toBe(1);
  });

  it('returns a redirect without a Location as-is', async () => {
    const res = await impitClient.safeFetch(`${base}/nolocation`, { attempts: 1 });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(302);
  });

  it('bounds the hop count so a redirect loop terminates', async () => {
    const res = await impitClient.safeFetch(`${base}/loop`, { attempts: 1, timeoutMs: 30000 });
    expect(res.status).toBe(302);
    expect(hits['/loop']).toBe(impitClient.MAX_REDIRECT_HOPS + 1);
  });

  it('turns a 301 on a POST into a bodyless GET and drops content-length', async () => {
    const res = await impitClient.safeFetch(`${base}/post-moved`, {
      method: 'POST',
      body: 'payload',
      headers: { 'content-length': '7', 'content-type': 'text/plain' },
      attempts: 1,
    });
    expect(await res.json()).toEqual({ method: 'GET', body: '' });
    expect(lastRequest.headers['content-type']).toBe('text/plain');
  });

  it('keeps method and body across a 307', async () => {
    const res = await impitClient.safeFetch(`${base}/post-kept`, { method: 'POST', body: 'payload', attempts: 1 });
    expect(await res.json()).toEqual({ method: 'POST', body: 'payload' });
  });
});

describe('safeFetch validateUrl hook', () => {
  const refuse169 = async (url) => {
    if (new URL(url).hostname === '169.254.169.254') throw Object.assign(new Error('blocked'), { blocked: true });
  };

  it('vets every redirect hop on the undici path and never contacts a refused host', async () => {
    breakImpit();
    await expect(impitClient.safeFetch(`${base}/to-metadata`, { attempts: 1, validateUrl: refuse169 }))
      .rejects.toMatchObject({ blocked: true });
    expect(hits['/to-metadata']).toBe(1);
  });

  it('vets every redirect hop on the impit path without falling back', async () => {
    impitSpy = spyOn(impitClient.getImpit(), 'fetch').mockImplementation(async (url, init) => {
      expect(init.redirect).toBe('manual');
      return { status: 302, headers: new Headers({ location: 'http://169.254.169.254/' }), text: async () => '' };
    });
    await expect(impitClient.safeFetch(`${base}/x`, { attempts: 3, validateUrl: refuse169 }))
      .rejects.toMatchObject({ blocked: true });
    expect(impitSpy).toHaveBeenCalledTimes(1);
  });

  it('does not force manual redirects when no validator is given', async () => {
    impitSpy = spyOn(impitClient.getImpit(), 'fetch').mockImplementation(async (url, init) => {
      expect(init.redirect).toBeUndefined();
      return { status: 200, headers: new Headers(), text: async () => PLAYLIST };
    });
    const res = await impitClient.safeFetch(`${base}/x`, { attempts: 1 });
    expect(res.ok).toBe(true);
  });
});

describe('safeFetch impit 403 falls back to undici once', () => {
  const impit403 = () => {
    impitSpy = spyOn(impitClient.getImpit(), 'fetch').mockImplementation(async () => (
      { status: 403, headers: new Headers(), text: async () => FORBIDDEN }
    ));
  };

  it('returns the undici answer when undici is accepted', async () => {
    impit403();
    const res = await impitClient.safeFetch(`${base}/ok`, { attempts: 3 });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(PLAYLIST);
    expect(impitSpy).toHaveBeenCalledTimes(1);
  });

  it('surfaces the original 403 when undici also fails', async () => {
    impit403();
    const res = await impitClient.safeFetch('http://127.0.0.1:1/unreachable', { attempts: 1, timeoutMs: 2000 });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe(FORBIDDEN);
  });

  it('returns other non-2xx statuses from impit as-is', async () => {
    impitSpy = spyOn(impitClient.getImpit(), 'fetch').mockImplementation(async () => (
      { status: 404, headers: new Headers(), text: async () => 'nope' }
    ));
    const res = await impitClient.safeFetch(`${base}/ok`, { attempts: 1 });
    expect(res.status).toBe(404);
    expect(hits['/ok']).toBeUndefined();
  });
});
