const { describe, it, expect } = require('bun:test');
const { findEmbedIframe } = require('../../../src/providers/embedIframe');

const DOMAINS = ['embedindia.st', 'embedindia.com', 'embedsport.xyz'];

describe('findEmbedIframe', () => {
  it('returns the matching iframe src', () => {
    const html = '<div><iframe src="https://embedindia.st/embed/admin/ch12" allowfullscreen></iframe></div>';
    expect(findEmbedIframe(html, DOMAINS)).toBe('https://embedindia.st/embed/admin/ch12');
  });

  it('matches single-quoted attributes', () => {
    const html = "<iframe src='https://embedindia.com/embed/x9'></iframe>";
    expect(findEmbedIframe(html, DOMAINS)).toBe('https://embedindia.com/embed/x9');
  });

  it('normalises protocol-relative srcs to https so callers can parse them', () => {
    const html = '<iframe src="//embedsport.xyz/embed/7"></iframe>';
    const got = findEmbedIframe(html, DOMAINS);
    expect(got).toBe('https://embedsport.xyz/embed/7');
    expect(new URL(got).origin).toBe('https://embedsport.xyz');
  });

  it('unescapes HTML entities in the query string', () => {
    const html = '<iframe src="https://embedindia.st/embed?id=5&amp;tier=vip"></iframe>';
    expect(findEmbedIframe(html, DOMAINS)).toBe('https://embedindia.st/embed?id=5&tier=vip');
  });

  it('skips non-matching iframes and returns the first matching one', () => {
    const html = [
      '<script src="https://cdn.example.com/hls.js"></script>',
      '<iframe src="https://ads.example.com/banner"></iframe>',
      '<iframe src="https://embedindia.st/embed/first"></iframe>',
      '<iframe src="https://embedsport.xyz/embed/second"></iframe>',
    ].join('\n');
    expect(findEmbedIframe(html, DOMAINS)).toBe('https://embedindia.st/embed/first');
  });

  it('returns null when no iframe points at a known domain', () => {
    expect(findEmbedIframe('<iframe src="https://other.tv/e/1"></iframe>', DOMAINS)).toBeNull();
    expect(findEmbedIframe('<p>no iframes here</p>', DOMAINS)).toBeNull();
    expect(findEmbedIframe('', DOMAINS)).toBeNull();
  });

  it('does not match a subdomain of a listed domain', () => {
    expect(findEmbedIframe('<iframe src="https://evil.embedindia.st.attacker.net/x"></iframe>', DOMAINS)).toBeNull();
  });
});
