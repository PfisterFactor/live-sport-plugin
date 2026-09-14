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
});
