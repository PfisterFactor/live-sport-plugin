const { describe, it, expect, beforeAll, afterAll } = require('bun:test');
const path = require('path');
const { createApp, serveStatic } = require('../../../src/httpApp');

let server;
let base;

beforeAll(async () => {
  const app = createApp();
  app.use(serveStatic(path.join(__dirname, '..', '..', '..', 'public')));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => server.close());

describe('serveStatic', () => {
  it('serves files under the root with their mime type', async () => {
    const res = await fetch(`${base}/configure.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
  });

  it('never serves files outside the root', async () => {
    for (const p of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/%2e%2e%2fpackage.json']) {
      const res = await fetch(`${base}${p}`);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain('"name"');
    }
  });

  it('answers a conditional request with 304 and no body', async () => {
    const first = await fetch(`${base}/configure.html`);
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();
    expect(first.headers.get('cache-control')).toContain('must-revalidate');

    const second = await fetch(`${base}/configure.html`, { headers: { 'If-None-Match': etag } });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe('');

    const byDate = await fetch(`${base}/configure.html`, {
      headers: { 'If-Modified-Since': first.headers.get('last-modified') },
    });
    expect(byDate.status).toBe(304);
  });

  it('serves the body again when the validator does not match', async () => {
    const res = await fetch(`${base}/configure.html`, { headers: { 'If-None-Match': 'W/"stale"' } });
    expect(res.status).toBe(200);
    expect((await res.text()).length).toBeGreaterThan(0);
  });
});
