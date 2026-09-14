const { describe, it, expect, afterEach } = require('bun:test');
const { BASE_URL, getLocalIp, getRequestBaseUrl } = require('../../../src/config');

const req = (headers = {}, extra = {}) => ({ headers, ...extra });

describe('getRequestBaseUrl', () => {
  afterEach(() => { delete process.env.ADDON_URL; });

  it('returns the module BASE_URL when no request is supplied', () => {
    expect(getRequestBaseUrl(null)).toBe(BASE_URL);
    expect(getRequestBaseUrl(undefined)).toBe(BASE_URL);
  });

  it('lets ADDON_URL override the request headers and strips a trailing slash', () => {
    process.env.ADDON_URL = 'https://addon.example.com/';
    expect(getRequestBaseUrl(req({ host: 'ignored.local' }))).toBe('https://addon.example.com');
  });

  it('builds the URL from the forwarded proto and host', () => {
    expect(getRequestBaseUrl(req({ 'x-forwarded-proto': 'https', host: 'sports.example.com' })))
      .toBe('https://sports.example.com');
  });

  it('takes only the first entry of a comma separated proto and host chain', () => {
    const r = req({ 'x-forwarded-proto': 'https, http', 'x-forwarded-host': 'edge.example.com, origin.local' });
    expect(getRequestBaseUrl(r)).toBe('https://edge.example.com');
  });

  it('prefers x-forwarded-host over the Host header', () => {
    const r = req({ 'x-forwarded-host': 'public.example.com', host: 'internal.local' });
    expect(getRequestBaseUrl(r)).toBe('http://public.example.com');
  });

  it('upgrades to https when x-forwarded-ssl is on', () => {
    const r = req({ 'x-forwarded-proto': 'http', 'x-forwarded-ssl': 'on', host: 'a.example.com' });
    expect(getRequestBaseUrl(r)).toBe('https://a.example.com');
  });

  it('uses the Cloudflare cf-visitor scheme when present', () => {
    const r = req({ 'cf-visitor': '{"scheme":"https"}', 'x-forwarded-proto': 'http', host: 'cf.example.com' });
    expect(getRequestBaseUrl(r)).toBe('https://cf.example.com');
  });

  it('ignores a malformed cf-visitor header and keeps the forwarded proto', () => {
    const r = req({ 'cf-visitor': '{not json', 'x-forwarded-proto': 'https', host: 'cf.example.com' });
    expect(getRequestBaseUrl(r)).toBe('https://cf.example.com');
  });

  it('falls back to req.protocol when no proto header is present', () => {
    const r = req({ host: 'p.example.com' }, { protocol: 'https' });
    expect(getRequestBaseUrl(r)).toBe('https://p.example.com');
  });

  it('resolves the host via req.get when no host headers are set', () => {
    const r = req({}, { get: (name) => (name === 'host' ? 'getter.example.com' : undefined) });
    expect(getRequestBaseUrl(r)).toBe('http://getter.example.com');
  });

  it('falls back to BASE_URL when the request carries no host at all', () => {
    expect(getRequestBaseUrl(req({ 'x-forwarded-proto': 'https' }))).toBe(BASE_URL);
  });
});

describe('BASE_URL', () => {
  it('is an absolute http(s) URL without a trailing slash', () => {
    expect(BASE_URL).toMatch(/^https?:\/\/[^\s]+[^/]$/);
  });
});

describe('getLocalIp', () => {
  it('returns a dotted IPv4 address', () => {
    expect(getLocalIp()).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/);
  });
});
