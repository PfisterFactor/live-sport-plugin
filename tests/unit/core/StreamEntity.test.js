const { describe, it, expect } = require('bun:test');
const StreamEntity = require('../../../src/domain/StreamEntity');

describe('StreamEntity', () => {
  it('omits url and externalUrl keys entirely when not supplied', () => {
    const s = new StreamEntity({ name: 'A', title: 'B' });
    expect('url' in s).toBe(false);
    expect('externalUrl' in s).toBe(false);
  });

  it('omits an empty url rather than emitting an unplayable stream', () => {
    expect('url' in new StreamEntity({ url: '' })).toBe(false);
  });

  it('keeps url and externalUrl together when both are supplied', () => {
    const s = new StreamEntity({ url: 'https://a/x.m3u8', externalUrl: 'https://a/watch' });
    expect(s.url).toBe('https://a/x.m3u8');
    expect(s.externalUrl).toBe('https://a/watch');
  });

  it('omits behaviorHints when absent so Stremio defaults apply', () => {
    expect('behaviorHints' in new StreamEntity({ url: 'u' })).toBe(false);
    const hinted = new StreamEntity({ url: 'u', behaviorHints: { notWebReady: true } });
    expect(hinted.behaviorHints).toEqual({ notWebReady: true });
  });

  it('nulls out missing resolution and bitrate and zeroes a missing score', () => {
    const s = new StreamEntity({ url: 'u' });
    expect(s.resolution).toBeNull();
    expect(s.bitrate).toBeNull();
    expect(s.score).toBe(0);
  });

  it('preserves a real score and coerces a zero score to 0', () => {
    expect(new StreamEntity({ score: 87 }).score).toBe(87);
    expect(new StreamEntity({ score: 0 }).score).toBe(0);
  });

  it('labels unnamed streams instead of leaving them blank', () => {
    const s = new StreamEntity({});
    expect(s.name).toBe('Unknown Proxy');
    expect(s.title).toBe('Unknown Stream');
  });
});
