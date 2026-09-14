const { describe, it, expect, beforeEach, afterEach, afterAll } = require('bun:test');
const impitClient = require('../../../src/impitClient');
const BaseProvider = require('../../../src/providers/BaseProvider');
const { DEFAULT_UA } = BaseProvider;
const { makeCradle } = require('./fixtures/helpers');

const realSafeFetch = impitClient.safeFetch;
let calls = [];
let impl = async () => ({ ok: true, status: 200, text: async () => '', json: async () => ({}) });

impitClient.safeFetch = async (url, opts) => {
  calls.push({ url, opts });
  return impl(url, opts);
};

afterAll(() => { impitClient.safeFetch = realSafeFetch; });

describe('BaseProvider.normalizeCategory', () => {
  const p = new BaseProvider(makeCradle());
  const n = (c) => p.normalizeCategory(c);

  it('maps soccer aliases to football', () => {
    expect(n('Soccer')).toBe('football');
    expect(n('football')).toBe('football');
    expect(n('  FOOT-BALL ')).toBe('football');
  });

  it('maps american football aliases ahead of the football rule', () => {
    expect(n('American Football')).toBe('american_football');
    expect(n('NFL')).toBe('american_football');
    expect(n('gridiron')).toBe('american_football');
  });

  it('routes every ncaa/college feed to college before the sport rules', () => {
    expect(n('NCAAF')).toBe('college');
    expect(n('NCAAB')).toBe('college');
    expect(n('College Basketball')).toBe('college');
  });

  it('maps combat sports to mma', () => {
    expect(n('UFC')).toBe('mma');
    expect(n('Boxing')).toBe('mma');
    expect(n('MMA / Fighting')).toBe('mma');
  });

  it('maps motorsport aliases including series names', () => {
    expect(n('Motorsport')).toBe('motorsport');
    expect(n('F1')).toBe('motorsport');
    expect(n('Formula 1')).toBe('motorsport');
    expect(n('NASCAR')).toBe('motorsport');
  });

  it('maps league acronyms for the remaining sports', () => {
    expect(n('NHL')).toBe('hockey');
    expect(n('MLB')).toBe('baseball');
    expect(n('NBA')).toBe('basketball');
    expect(n('Tennis')).toBe('tennis');
    expect(n('Golf')).toBe('golf');
    expect(n('Darts')).toBe('darts');
    expect(n('Rugby League')).toBe('rugby');
    expect(n('Cricket')).toBe('cricket');
  });

  it('collapses placeholder categories to other and keeps unknown sports addressable', () => {
    expect(n('Uncategorized')).toBe('other');
    expect(n('Live Show')).toBe('other');
    expect(n('')).toBe('other');
    expect(n(null)).toBe('other');
    expect(n('Handball')).toBe('handball');
  });

  it('unwraps object categories', () => {
    expect(n({ name: 'Ice Hockey' })).toBe('hockey');
    expect(n({ title: 'Cricket' })).toBe('cricket');
    expect(n({})).toBe('other');
  });
});

describe('BaseProvider.normalizeStr', () => {
  const p = new BaseProvider(makeCradle());
  it('collapses punctuation into single spaces and trims', () => {
    expect(p.normalizeStr('  Real-Madrid   vs. Barça! ')).toBe('real madrid vs bar a');
    expect(p.normalizeStr(null)).toBe('');
  });
});

describe('BaseProvider.proxyFetch', () => {
  beforeEach(() => {
    calls = [];
    impl = async () => ({ ok: true, status: 200, text: async () => 'ok', json: async () => ({}) });
  });
  afterEach(() => { calls = []; });

  const p = new BaseProvider(makeCradle());

  it('supplies the browser User-Agent when the caller passes no headers', async () => {
    await p.proxyFetch('https://x.test/a');
    expect(calls[0].opts.headers['User-Agent']).toBe(DEFAULT_UA);
  });

  it('keeps a caller-supplied User-Agent regardless of header casing', async () => {
    await p.proxyFetch('https://x.test/a', { headers: { 'user-agent': 'custom/1', Referer: 'https://r.test/' } });
    expect(calls[0].opts.headers['user-agent']).toBe('custom/1');
    expect(calls[0].opts.headers['User-Agent']).toBeUndefined();
    expect(calls[0].opts.headers.Referer).toBe('https://r.test/');
  });

  it('does not mutate the caller header object', async () => {
    const headers = { Referer: 'https://r.test/' };
    await p.proxyFetch('https://x.test/a', { headers });
    expect(headers).toEqual({ Referer: 'https://r.test/' });
  });

  it('defaults timeoutMs to 15s and honours an override without leaking it into the fetch options twice', async () => {
    await p.proxyFetch('https://x.test/a');
    expect(calls[0].opts.timeoutMs).toBe(15000);
    await p.proxyFetch('https://x.test/a', { timeoutMs: 6000, method: 'POST', body: 'z' });
    expect(calls[1].opts.timeoutMs).toBe(6000);
    expect(calls[1].opts.method).toBe('POST');
    expect(calls[1].opts.body).toBe('z');
  });

  it('returns non-2xx responses to the caller instead of throwing', async () => {
    impl = async () => ({ ok: false, status: 503, text: async () => 'nope', json: async () => ({}) });
    const r = await p.proxyFetch('https://x.test/a');
    expect(r.ok).toBe(false);
    expect(r.status).toBe(503);
  });

  it('propagates transport errors', async () => {
    impl = async () => { throw new Error('socket hang up'); };
    await expect(p.proxyFetch('https://x.test/a')).rejects.toThrow('socket hang up');
  });
});

describe('BaseProvider defaults', () => {
  it('getMatches must be implemented by subclasses', async () => {
    const p = new BaseProvider(makeCradle());
    await expect(p.getMatches()).rejects.toThrow(/must be implemented/);
  });

  it('resolveStream yields nothing by default', async () => {
    const p = new BaseProvider(makeCradle());
    expect(await p.resolveStream('x', 'football', 'A vs B')).toEqual([]);
  });
});
