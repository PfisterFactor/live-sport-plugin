const { describe, it, expect, beforeEach, afterEach, spyOn, afterAll, mock, setSystemTime } = require('bun:test');

let requestCalls = [];
let responder = () => { throw new Error('no responder'); };

spyOn(require('undici'), 'request').mockImplementation(async (url, opts) => {
  requestCalls.push({ url, opts });
  return responder(url, opts);
});

const imageService = require('../../../src/services/ImageService');
const { getImage, normalizeUrl, proxyUrl, placeholderUrl, svgPlaceholder } = imageService;

function body(chunks, { destroyed = { value: false } } = {}) {
  return {
    on() {},
    destroy() { destroyed.value = true; },
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; }
  };
}

const png = (bytes = 64) => Buffer.alloc(bytes, 1);
const ok = (buf = png()) => () => ({
  statusCode: 200,
  headers: { 'content-type': 'image/png; charset=binary' },
  body: body([buf])
});

const T0 = new Date('2026-02-01T00:00:00Z');
const at = (ms) => setSystemTime(new Date(T0.getTime() + ms));

let seq = 0;
const uniqueUrl = () => `https://cdn.test/${Date.now()}-${seq++}.png`;

beforeEach(() => { requestCalls = []; at(0); });
afterEach(() => setSystemTime());

describe('ImageService.normalizeUrl', () => {
  it('upgrades protocol-relative URLs to https and trims whitespace', () => {
    expect(normalizeUrl('  //cdn.test/a.png ')).toBe('https://cdn.test/a.png');
    expect(normalizeUrl('HTTP://cdn.test/a.png')).toBe('HTTP://cdn.test/a.png');
  });

  it('rejects anything that is not an http(s) URL', () => {
    for (const bad of ['', '   ', null, undefined, 42, 'data:image/png;base64,AAA', '/local/a.png', 'ftp://x/a.png']) {
      expect(normalizeUrl(bad)).toBeNull();
    }
  });
});

describe('ImageService.proxyUrl / placeholderUrl', () => {
  it('encodes the source url and text into the /img query', () => {
    const url = proxyUrl('https://host', '//cdn.test/a b.png', { text: 'A & B', color: 'ff0000' });
    expect(url).toBe('https://host/img?url=https%3A%2F%2Fcdn.test%2Fa%20b.png&text=A%20%26%20B&color=ff0000');
  });

  it('returns null when the source url is unusable, so callers fall back to a placeholder', () => {
    expect(proxyUrl('https://host', 'not-a-url', { text: 'x' })).toBeNull();
    expect(proxyUrl('https://host', null)).toBeNull();
  });

  it('builds a placeholder url with defaults when text and color are missing', () => {
    expect(placeholderUrl('https://host')).toBe('https://host/img/placeholder?text=&color=333333');
    expect(placeholderUrl('https://host', 'Real Madrid vs Barça', 'ff0000'))
      .toBe('https://host/img/placeholder?text=Real%20Madrid%20vs%20Bar%C3%A7a&color=ff0000');
  });
});

describe('ImageService.svgPlaceholder', () => {
  it('uses the category color when it is a bare hex triplet and a neutral default otherwise', () => {
    expect(svgPlaceholder('x', 'ff0000')).toContain('fill="#ff0000"');
    expect(svgPlaceholder('x', '#ff0000')).toContain('fill="#333333"');
    expect(svgPlaceholder('x', 'red')).toContain('fill="#333333"');
    expect(svgPlaceholder('x')).toContain('fill="#333333"');
  });

  it('escapes XML-significant characters in the title', () => {
    const svg = svgPlaceholder('A & B <"\'>', 'ff0000');
    expect(svg).toContain('A &amp; B &lt;&quot;&apos;&gt;');
    expect(svg).not.toContain('<"');
  });

  it('renders at most three lines and ellipsises long ones', () => {
    const svg = svgPlaceholder('one\ntwo\nthree\nfour');
    expect(svg.match(/<text /g)).toHaveLength(3);
    expect(svg).not.toContain('>four<');

    const long = svgPlaceholder('A'.repeat(40));
    expect(long).toContain('A'.repeat(25) + '…');
    expect(long).not.toContain('A'.repeat(26));
  });

  it('falls back to a default title for empty or whitespace-only text', () => {
    expect(svgPlaceholder('')).toContain('>Live Sports<');
    expect(svgPlaceholder('   \n  ')).toContain('>Live Sports<');
  });

  it('honours explicit dimensions', () => {
    const svg = svgPlaceholder('x', 'ff0000', 300, 450);
    expect(svg).toContain('width="300" height="450"');
    expect(svg).toContain('viewBox="0 0 300 450"');
  });
});

describe('ImageService.getImage', () => {
  it('rejects an unusable url without hitting the network', async () => {
    expect(await getImage('not-a-url')).toBeNull();
    expect(requestCalls).toHaveLength(0);
  });

  it('fetches once and serves the cached buffer until the TTL expires', async () => {
    const url = uniqueUrl();
    responder = ok(png(100));

    const first = await getImage(url);
    expect(first.contentType).toBe('image/png');
    expect(first.buffer).toHaveLength(100);

    at(9 * 60 * 1000);
    const second = await getImage(url);
    expect(second.buffer).toBe(first.buffer);
    expect(requestCalls).toHaveLength(1);

    at(10 * 60 * 1000 + 1);
    responder = ok(png(120));
    const third = await getImage(url);
    expect(third.buffer).toHaveLength(120);
    expect(requestCalls).toHaveLength(2);
  });

  it('coalesces concurrent fetches of the same url into one upstream request', async () => {
    const url = uniqueUrl();
    let release;
    const gate = new Promise((r) => { release = r; });
    responder = async () => {
      await gate;
      return { statusCode: 200, headers: { 'content-type': 'image/jpeg' }, body: body([png()]) };
    };

    const a = getImage(url);
    const b = getImage(url);
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(requestCalls).toHaveLength(1);
    expect(rb).toBe(ra);
    expect(ra.contentType).toBe('image/jpeg');
  });

  it('returns null for a non-image body and negative-caches the url for a minute', async () => {
    const url = uniqueUrl();
    responder = () => ({ statusCode: 200, headers: { 'content-type': 'text/html' }, body: body([Buffer.from('<html>')]) });

    expect(await getImage(url)).toBeNull();
    at(30 * 1000);
    expect(await getImage(url)).toBeNull();
    expect(requestCalls).toHaveLength(1);

    at(61 * 1000);
    responder = ok();
    expect(await getImage(url)).not.toBeNull();
    expect(requestCalls).toHaveLength(2);
  });

  it('returns null for a non-200 response', async () => {
    responder = () => ({ statusCode: 404, headers: { 'content-type': 'image/png' }, body: body([png()]) });
    expect(await getImage(uniqueUrl())).toBeNull();
  });

  it('returns null when the upstream request throws', async () => {
    responder = () => { throw new Error('ETIMEDOUT'); };
    expect(await getImage(uniqueUrl())).toBeNull();
  });

  it('rejects a suspiciously tiny body', async () => {
    responder = ok(Buffer.alloc(31, 1));
    expect(await getImage(uniqueUrl())).toBeNull();
  });

  it('aborts and rejects a body that exceeds the size cap', async () => {
    const destroyed = { value: false };
    responder = () => ({
      statusCode: 200,
      headers: { 'content-type': 'image/png' },
      body: body([Buffer.alloc(1024 * 1024, 1), Buffer.alloc(1024 * 1024, 1), Buffer.alloc(1024 * 1024, 1)], { destroyed })
    });
    expect(await getImage(uniqueUrl())).toBeNull();
    expect(destroyed.value).toBe(true);
  });

  it('sends a browser user-agent and bounds the request with timeouts', async () => {
    responder = ok();
    await getImage(uniqueUrl());
    const { opts } = requestCalls[0];
    expect(opts.headers['User-Agent']).toContain('Mozilla/5.0');
    expect(opts.headersTimeout).toBeGreaterThan(0);
    expect(opts.bodyTimeout).toBeGreaterThan(0);
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });
});

afterAll(() => mock.restore());
