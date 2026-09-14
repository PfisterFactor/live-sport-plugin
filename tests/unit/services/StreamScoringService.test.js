const { describe, it, expect } = require('bun:test');
const StreamScoringService = require('../../../src/services/StreamScoringService');

const svc = new StreamScoringService();
const s = (o) => ({ title: '', ...o });

describe('StreamScoringService', () => {
  it('prefers a direct stream over an external web-player entry from the same source', () => {
    const direct = svc.calculateScore(s({ url: 'http://a/x.m3u8' }), 'unknown');
    const external = svc.calculateScore(s({ externalUrl: 'http://a/watch' }), 'unknown');
    expect(direct).toBeGreaterThan(external);
    expect(direct).toBe(80);
    expect(external).toBe(30);
  });

  it('scores an entry with neither url nor externalUrl at the base score', () => {
    expect(svc.calculateScore(s({}), 'unknown')).toBe(50);
  });

  it('orders resolutions 1080p > 720p > SD, from the title', () => {
    const score = (title) => svc.calculateScore(s({ title, url: 'u' }), 'unknown');
    expect(score('Stream 1080p')).toBeGreaterThan(score('Stream 720p'));
    expect(score('Stream 720p')).toBeGreaterThan(score('Stream'));
    expect(score('Stream')).toBeGreaterThan(score('Stream SD'));
  });

  it('reads the resolution from the resolution field when the title is unlabelled', () => {
    expect(svc.calculateScore(s({ url: 'u', resolution: '1920x1080' }), 'unknown'))
      .toBe(svc.calculateScore(s({ url: 'u', title: '1080p' }), 'unknown'));
    expect(svc.calculateScore(s({ url: 'u', resolution: '1280x720' }), 'unknown'))
      .toBe(svc.calculateScore(s({ url: 'u', title: '720p' }), 'unknown'));
  });

  it('ranks source reliability: known-reliable > streamfree > timstreams > unknown', () => {
    const score = (src) => svc.calculateScore(s({ url: 'u' }), src);
    expect(score('echo')).toBeGreaterThan(score('streamfree'));
    expect(score('streamfree')).toBeGreaterThan(score('timstreams'));
    expect(score('timstreams')).toBeGreaterThan(score('whatever'));
    expect(score('admin')).toBe(score('golf'));
  });

  it('keeps a direct low-quality stream ahead of the best external web-player entry', () => {
    const directSd = svc.calculateScore(s({ url: 'u', title: 'SD feed' }), 'whatever');
    const externalHd = svc.calculateScore(s({ externalUrl: 'u', title: '1080p feed' }), 'echo');
    expect(directSd).toBeGreaterThan(externalHd);
  });

  it('breaks a same-transport tie by source reliability when resolutions are one step apart', () => {
    const hiResWeakSource = svc.calculateScore(s({ url: 'u', title: '1080p feed' }), 'whatever');
    const loResStrongSource = svc.calculateScore(s({ url: 'u', title: '720p feed' }), 'echo');
    expect(loResStrongSource).toBeGreaterThan(hiResWeakSource);
  });

  it('scores a stream that has no title instead of throwing', () => {
    expect(svc.calculateScore({ url: 'http://a/x.m3u8' }, 'echo')).toBe(95);
    expect(svc.calculateScore({ url: 'u', resolution: '1920x1080' }, 'echo')).toBe(115);
  });
});
