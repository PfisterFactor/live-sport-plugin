const { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, spyOn } = require('bun:test');

const container = require('../../../src/container');
const impitClient = require('../../../src/impitClient');
const app = require('../../../src/app');

let server;
const realFetch = globalThis.fetch.bind(globalThis);
let base;

const fakes = {};
let resolveSpy;
let safeFetchSpy;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  for (const k of Object.keys(fakes)) delete fakes[k];
  fakes.cronService = { ensureFresh() {}, start() {} };
  fakes.cacheService = { getMatches: () => [] };
  fakes.streamResolveCache = {
    stats: () => ({ entries: 3, hits: 1 }),
    get: () => null,
    getOrCreate: (_k, fn) => fn(),
    noteSuccess() {},
    noteFailure() {},
  };
  fakes.streamScorer = { calculateScore: () => 1 };
  fakes.m3u8Parser = { parseManifestText: () => null };
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

describe('CORS', () => {
  it('sets permissive CORS headers on normal GETs', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('GET');
  });

  it('answers preflight with 204 and echoes the requested headers', async () => {
    const res = await fetch(`${base}/manifest.json`, {
      method: 'OPTIONS',
      headers: { 'Access-Control-Request-Headers': 'x-custom, authorization' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-headers')).toBe('x-custom, authorization');
    expect(await res.text()).toBe('');
  });

  it('omits Allow-Headers on a preflight that requests none', async () => {
    const res = await fetch(`${base}/manifest.json`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-headers')).toBeNull();
  });
});

describe('/health', () => {
  it('reports the resolve cache stats', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'ok',
      service: 'nuvio-live-sports',
      streamResolveCache: { entries: 3, hits: 1 },
    });
  });

  it('still reports ok when the cache cannot be resolved', async () => {
    fakes.streamResolveCache = { stats() { throw new Error('boom'); } };
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', streamResolveCache: null });
  });
});

describe('response rewriter', () => {
  it('rewrites relative manifest asset URLs onto the request Host', async () => {
    const res = await fetch(`${base}/manifest.json`, { headers: { Host: 'addon.example.org' } });
    const body = await res.json();
    expect(body.logo).toBe('http://addon.example.org/logo.png');
  });

  it('prefers X-Forwarded-Proto and X-Forwarded-Host over the Host header', async () => {
    const res = await fetch(`${base}/manifest.json`, {
      headers: {
        Host: 'ignored.example.org',
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': 'cdn.example.net',
      },
    });
    const body = await res.json();
    expect(body.logo).toBe('https://cdn.example.net/logo.png');
  });

  it('uses the first entry of a comma-joined forwarded chain', async () => {
    const res = await fetch(`${base}/manifest.json`, {
      headers: {
        'X-Forwarded-Proto': 'https,http',
        'X-Forwarded-Host': 'first.example.net,second.example.net',
      },
    });
    const body = await res.json();
    expect(body.logo).toBe('https://first.example.net/logo.png');
  });

  it('rewrites stream and poster URLs in addon payloads, including large bodies', async () => {
    const sources = [{ source: 'embedst', id: 's1' }];
    fakes.cacheService = {
      getMatches: () => [{ id: 'm1', title: 'A vs B', category: 'football', sources }],
    };
    const filler = 'x'.repeat(80 * 1024);
    fakes.embedStProvider = {
      resolveStream: async () => [
        { url: '/watch?url=https%3A%2F%2Fe.st%2Fa', title: `Stream (${filler})` },
        { url: 'http://10.0.0.5:7000/api/manifest?url=https%3A%2F%2Fe.st%2Fb.m3u8', title: 'B' },
        { url: 'https://cdn.example.com/real.m3u8', title: 'C' },
      ],
    };

    const res = await fetch(`${base}/stream/tv/nuvio_sport_m1.json`, {
      headers: { Host: 'addon.example.org' },
    });
    const body = await res.json();
    const urls = body.streams.map((s) => s.url);
    expect(urls).toContain('http://addon.example.org/watch?url=https%3A%2F%2Fe.st%2Fa');
    expect(urls).toContain('http://addon.example.org/api/manifest?url=https%3A%2F%2Fe.st%2Fb.m3u8');
    expect(urls).toContain('https://cdn.example.com/real.m3u8');
    expect(res.headers.get('content-length')).toBe(String(Buffer.byteLength(JSON.stringify(body))));
  });

  it('rewrites catalog poster URLs', async () => {
    fakes.cacheService = {
      getMatches: () => [{ id: 'm1', title: 'A vs B', category: 'football', date: String(Date.now()) }],
    };
    const res = await fetch(`${base}/catalog/tv/nuvio_sports_football.json`, {
      headers: { Host: 'addon.example.org' },
    });
    const body = await res.json();
    expect(body.metas).toHaveLength(1);
    expect(body.metas[0].poster.startsWith('http://addon.example.org/img')).toBe(true);
  });

  it('leaves non-addon routes untouched', async () => {
    fakes.cacheService = { getMatches: () => [{ id: 'm1', poster: '/img?url=x' }] };
    const res = await fetch(`${base}/api/matches`, { headers: { Host: 'addon.example.org' } });
    const body = await res.json();
    expect(body[0].poster).toBe('/img?url=x');
  });

  it('leaves addon payloads with no proxy URLs byte-identical', async () => {
    fakes.cacheService = {
      getMatches: () => [{ id: 'm1', title: 'A vs B', category: 'football', sources: [{ source: 'embedst', id: 's1' }] }],
    };
    fakes.embedStProvider = {
      resolveStream: async () => [{ url: 'https://cdn.example.com/a.m3u8', title: 'A' }],
    };
    const res = await fetch(`${base}/stream/tv/nuvio_sport_m1.json`, {
      headers: { Host: 'addon.example.org' },
    });
    const text = await res.text();
    expect(text).not.toContain('addon.example.org');
    expect(JSON.parse(text).streams[0].url).toBe('https://cdn.example.com/a.m3u8');
  });
});

describe('config segment', () => {
  const encode = (obj) =>
    Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  it('filters manifest catalogs from a base64url config segment', async () => {
    const res = await fetch(`${base}/${encode({ sports: 'football,cricket' })}/manifest.json`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.catalogs.map((c) => c.id);
    expect(ids).toContain('nuvio_sports_football');
    expect(ids).toContain('nuvio_sports_cricket');
    expect(ids).not.toContain('nuvio_sports_tennis');
    expect(ids).not.toContain('nuvio_sports_teams');
  });

  it('keeps the teams catalog only when teams are configured', async () => {
    const withTeams = await (await fetch(`${base}/${encode({ teams: 'arsenal' })}/manifest.json`)).json();
    expect(withTeams.catalogs.map((c) => c.id)).toContain('nuvio_sports_teams');

    const withoutTeams = await (await fetch(`${base}/${encode({ teams: '  ' })}/manifest.json`)).json();
    expect(withoutTeams.catalogs.map((c) => c.id)).not.toContain('nuvio_sports_teams');
  });

  it('passes the decoded config through to the catalog handler', async () => {
    const seen = [];
    fakes.cacheService = {
      getMatches: () => [
        { id: 'm1', title: 'Arsenal vs Spurs', category: 'football', date: String(Date.now()) },
        { id: 'm2', title: 'Rain Delay', category: 'cricket', date: String(Date.now()) },
      ],
    };
    fakes.cronService = { ensureFresh() { seen.push('fresh'); }, start() {} };

    const cfg = encode({ sports: 'football' });
    const res = await fetch(`${base}/${cfg}/catalog/tv/nuvio_sports_catalog.json`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.metas.map((m) => m.name || m.id)).toHaveLength(1);
    expect(seen).toContain('fresh');
  });

  it('falls through to the unconfigured manifest on a malformed segment', async () => {
    const res = await fetch(`${base}/not%20a%20config/manifest.json`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.catalogs.map((c) => c.id)).toContain('nuvio_sports_live');
  });

  it('rejects a config segment that decodes to a JSON array', async () => {
    const seg = Buffer.from(JSON.stringify(['football'])).toString('base64url');
    const res = await fetch(`${base}/${seg}/manifest.json`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.catalogs.map((c) => c.id)).toContain('nuvio_sports_tennis');
  });
});

describe('/watch', () => {
  it('HTML-escapes the title in default mode', async () => {
    const title = '"><script>alert(1)</script>';
    const res = await fetch(`${base}/watch?url=${encodeURIComponent('https://e.st/a')}&title=${encodeURIComponent(title)}`);
    const html = await res.text();
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('percent-encodes URL-borne script breakouts before templating', async () => {
    const evil = 'https://e.st/a?x="></script><script>alert(1)</script>';
    const res = await fetch(`${base}/watch?url=${encodeURIComponent(evil)}`);
    const html = await res.text();
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('const targetUrl = "https://e.st/a?x=%22%3E%3C/script%3E');
  });

  it('renders the extract template with JSON-embedded embed and referer', async () => {
    const res = await fetch(
      `${base}/watch?mode=extract&embed=${encodeURIComponent('https://e.st/e')}&referer=${encodeURIComponent('https://ref.example/')}`
    );
    const html = await res.text();
    expect(html).toContain('Extracting Stream');
    expect(html).toContain('const embedUrl = "https://e.st/e"');
    expect(html).toContain('const referer  = "https://ref.example/"');
  });

  it('defaults the extract referer to the embed URL', async () => {
    const res = await fetch(`${base}/watch?mode=extract&embed=${encodeURIComponent('https://e.st/e')}`);
    const html = await res.text();
    expect(html).toContain('const referer  = "https://e.st/e"');
  });

  it('rejects missing and non-http(s) URLs', async () => {
    expect((await fetch(`${base}/watch`)).status).toBe(400);
    expect((await fetch(`${base}/watch?mode=extract`)).status).toBe(400);
    expect((await fetch(`${base}/watch?url=${encodeURIComponent('javascript:alert(1)')}`)).status).toBe(400);
    expect((await fetch(`${base}/watch?url=${encodeURIComponent('file:///etc/passwd')}`)).status).toBe(400);
    expect((await fetch(`${base}/watch?mode=extract&embed=${encodeURIComponent('file:///etc/passwd')}`)).status).toBe(400);
    expect((await fetch(`${base}/watch?url=notaurl`)).status).toBe(400);
  });
});

describe('/img', () => {
  it('serves a generated SVG placeholder carrying the requested text', async () => {
    const res = await fetch(`${base}/img/placeholder?text=${encodeURIComponent('Team A vs Team B')}&color=ff0000`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/svg+xml');
    const svg = await res.text();
    expect(svg).toContain('Team A');
    expect(svg).toContain('ff0000');
  });

  it('falls back to the placeholder when the upstream image cannot be fetched', async () => {
    const res = await fetch(`${base}/img?url=${encodeURIComponent('https://nope.invalid/x.png')}&text=Fallback`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/svg+xml');
    expect(res.headers.get('cache-control')).toContain('max-age=300');
    expect(await res.text()).toContain('Fallback');
  });

  it('does not escape the public directory via encoded traversal', async () => {
    const res = await fetch(`${base}/..%2f..%2fpackage.json`);
    expect(res.status).not.toBe(200);
    expect(await res.text()).not.toContain('nuvio-live-sports-plugin');
  });
});

describe('/api/proxy-embed', () => {
  let fetchSpy;

  afterEach(() => {
    if (fetchSpy) fetchSpy.mockRestore();
    fetchSpy = undefined;
  });

  it('requires a url', async () => {
    const res = await fetch(`${base}/api/proxy-embed`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Missing/);
  });

  it('rejects non-http(s) schemes', async () => {
    const res = await fetch(`${base}/api/proxy-embed?url=${encodeURIComponent('file:///etc/passwd')}`);
    expect(res.status).toBe(400);
  });

  it('blocks hosts outside the embed allowlist, including internal addresses', async () => {
    for (const target of [
      'http://127.0.0.1/admin',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]:80/',
      'http://localhost:7000/health',
      'https://evil.example.com/',
    ]) {
      const res = await fetch(`${base}/api/proxy-embed?url=${encodeURIComponent(target)}`);
      expect(res.status).toBe(403);
    }
  });

  it('forwards the referer and returns the upstream HTML', async () => {
    let seen;
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (url, opts) => {
      if (String(url).startsWith(base)) return realFetch(url, opts);
      seen = { url: String(url), opts };
      return new Response('<html>embed</html>', { status: 200 });
    });

    const res = await realFetch(
      `${base}/api/proxy-embed?url=${encodeURIComponent('https://embed.st/live/1')}&referer=${encodeURIComponent('https://watchfooty.st/')}`
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toBe('<html>embed</html>');
    expect(seen.url).toBe('https://embed.st/live/1');
    expect(seen.opts.headers.Referer).toBe('https://watchfooty.st/');
    expect(seen.opts.headers['User-Agent']).toContain('Chrome/');
  });

  it('omits the Referer header when none was supplied', async () => {
    let seen;
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (url, opts) => {
      if (String(url).startsWith(base)) return realFetch(url, opts);
      seen = { url: String(url), opts };
      return new Response('ok', { status: 200 });
    });
    await realFetch(`${base}/api/proxy-embed?url=${encodeURIComponent('https://embed.st/live/1')}`);
    expect(seen.opts.headers.Referer).toBeUndefined();
  });

  it('maps an upstream failure to 502 with the error detail', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (url, opts) => {
      if (String(url).startsWith(base)) return realFetch(url, opts);
      throw new Error('socket hang up');
    });
    const res = await realFetch(`${base}/api/proxy-embed?url=${encodeURIComponent('https://embed.st/live/1')}`);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Failed to fetch embed page', detail: 'socket hang up' });
  });
});
