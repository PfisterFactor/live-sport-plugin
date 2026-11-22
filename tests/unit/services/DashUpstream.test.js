const { describe, test, expect } = require('bun:test');
const { buildPolicy, assertAllowed, isBlockedHost, fetchGuarded, toBuffer } = require('../../../src/services/DashUpstream');

const MPD_URL = 'https://otte.live.fly.ww.aiv-cdn.net/fra-nitro/out/v1/ab9d1f/cenc.mpd';

describe('DashUpstream', () => {
  test('blocks private, loopback and metadata hosts', () => {
    for (const host of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.5', '169.254.169.254',
      '100.64.0.1', '::1', 'fd00::1', 'metadata.google.internal', 'printer.local', 'localhost']) {
      expect(isBlockedHost(host)).toBe(true);
    }
    expect(isBlockedHost('otte.live.fly.ww.aiv-cdn.net')).toBe(false);
  });

  test('rejects a host outside the stream allowlist, credentials, and a protocol downgrade', () => {
    const policy = buildPolicy(MPD_URL, ['https://otte.live.fly.ww.aiv-cdn.net/x/init.mp4']);
    expect(() => assertAllowed('https://evil.example.com/x.mp4', policy))
      .toThrow(expect.objectContaining({ code: 'SSRF_HOST_NOT_ALLOWED' }));
    expect(() => assertAllowed('https://user:pass@otte.live.fly.ww.aiv-cdn.net/x.mp4', policy))
      .toThrow(expect.objectContaining({ code: 'SSRF_CREDENTIALS' }));
    expect(() => assertAllowed('http://otte.live.fly.ww.aiv-cdn.net/x.mp4', policy))
      .toThrow(expect.objectContaining({ code: 'SSRF_PROTOCOL' }));
    expect(() => assertAllowed('https://otte.live.fly.ww.aiv-cdn.net:8443/x.mp4', policy))
      .toThrow(expect.objectContaining({ code: 'SSRF_PORT' }));
    expect(() => assertAllowed('https://otte.live.fly.ww.aiv-cdn.net/x.mp4', policy)).not.toThrow();
  });

  test('a private host is refused before any allowlist comparison', () => {
    expect(() => assertAllowed('http://169.254.169.254/latest/meta-data/'))
      .toThrow(expect.objectContaining({ code: 'SSRF_PRIVATE_HOST' }));
  });

  test('the policy never allowlists a private host an MPD points at', () => {
    const policy = buildPolicy(MPD_URL, ['https://10.0.0.1/seg.mp4', 'https://cdn2.example.net/seg.mp4']);
    expect([...policy.hosts].sort()).toEqual(['cdn2.example.net', 'otte.live.fly.ww.aiv-cdn.net']);
  });

  test('fetchGuarded vets every redirect hop through the allowlist', async () => {
    const policy = buildPolicy(MPD_URL);
    const hops = ['https://otte.live.fly.ww.aiv-cdn.net/x.mp4', 'http://169.254.169.254/latest/meta-data/'];
    const fetcher = async (url, opts) => {
      for (const hop of hops) await opts.validateUrl(hop);
      return { ok: true };
    };

    await expect(fetchGuarded(hops[0], { policy, fetcher, validateUrl: async () => {} }))
      .rejects.toThrow(expect.objectContaining({ code: 'SSRF_PRIVATE_HOST' }));
  });

  test('fetchGuarded refuses the first URL before calling the fetcher', async () => {
    let called = false;
    const fetcher = async () => { called = true; return { ok: true }; };
    await expect(fetchGuarded('https://evil.example.com/x.mp4', { policy: buildPolicy(MPD_URL), fetcher }))
      .rejects.toThrow(expect.objectContaining({ code: 'SSRF_HOST_NOT_ALLOWED' }));
    expect(called).toBe(false);
  });

  test('fetchGuarded passes the hop validator that also runs the outbound guard', async () => {
    const seen = [];
    const fetcher = async (url, opts) => {
      await opts.validateUrl(url);
      return { ok: true };
    };
    await fetchGuarded(MPD_URL, { policy: buildPolicy(MPD_URL), fetcher, validateUrl: async (hop) => { seen.push(hop); } });
    expect(seen).toEqual([MPD_URL]);
  });

  test('toBuffer refuses a body over the limit', async () => {
    const res = { arrayBuffer: async () => new Uint8Array(10).buffer };
    expect((await toBuffer(res, 10)).length).toBe(10);
    await expect(toBuffer(res, 9)).rejects.toThrow(expect.objectContaining({ code: 'BODY_TOO_LARGE' }));
  });
});
