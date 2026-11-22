const { describe, test, expect } = require('bun:test');
const fs = require('fs');
const path = require('path');
const ScoreZoneProvider = require('../../../src/providers/ScoreZoneProvider');
const { makeCradle, res } = require('./fixtures/helpers');

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/live', name), 'utf8'));

function provider() {
  const p = new ScoreZoneProvider(makeCradle());
  p.proxyFetch = async (url) => {
    if (url.includes('/api/livescore/soccer/')) return res({ json: fixture('scorezone_soccer.json') });
    if (url.includes('/api/livescore/')) return res({ json: { Stages: [] } });
    if (url.includes('/api/iptv/channels')) return res({ json: fixture('scorezone_iptv.json') });
    if (url.includes('/api/matches/channels')) return res({ json: fixture('scorezone_channels.json') });
    if (url.includes('/api/matches/playback')) return res({ json: fixture('scorezone_playback.json') });
    return res({ status: 404 });
  };
  return p;
}

describe('ScoreZoneProvider', () => {
  test('lists listed-league fixtures that are not finished, plus sports IPTV channels', async () => {
    const matches = await provider().getMatches();
    const fixtures = matches.filter((m) => m.category !== 'networks');
    expect(fixtures.map((m) => m.title).sort()).toEqual(['Getafe vs Atletico Madrid', 'Osasuna vs Malaga']);
    expect(fixtures.every((m) => m.category === 'football' && m.sources[0].source === 'scorezone')).toBe(true);
    expect(fixtures.some((m) => m.status === 'live')).toBe(true);
    const channels = matches.filter((m) => m.category === 'networks');
    expect(channels.length).toBe(3);
    expect(channels[0].id).toStartWith('scorezone_ch_');
  });

  test('mints a renewable proxied manifest per unlocked channel', async () => {
    const p = provider();
    const [match] = (await p.getMatches()).filter((m) => m.category === 'football');
    const streams = await p.resolveStream(match.sources[0].id, 'football', match.title, match.sources[0]);
    expect(streams.length).toBeGreaterThan(0);
    const q = new URL(streams[0].url).searchParams;
    expect(q.get('url')).toContain('/index.m3u8');
    expect(q.get('renew')).toBe('scorezone');
    expect(new URL(q.get('embed')).searchParams.get('eventId')).toBe(match.sources[0].id);
  });

  test('extractM3u8 re-mints from the renewal embed', async () => {
    const p = provider();
    const [match] = (await p.getMatches()).filter((m) => m.category === 'football');
    const [stream] = await p.resolveStream(match.sources[0].id, 'football', match.title, match.sources[0]);
    const embed = new URL(stream.url).searchParams.get('embed');
    const out = await p.extractM3u8(embed);
    expect(out.m3u8).toContain('/index.m3u8');
    expect(out.referer).toBe('https://scorezonetv.live/');
  });

  test('IPTV channels resolve to a direct URL with headers', async () => {
    const p = provider();
    const ch = (await p.getMatches()).find((m) => m.category === 'networks');
    const [stream] = await p.resolveStream(ch.sources[0].id, 'networks', ch.title, ch.sources[0]);
    expect(stream.url).toStartWith('https://scorezone-live.scorezone.workers.dev/live/');
    expect(stream.behaviorHints.proxyHeaders.request.Referer).toBe('https://scorezonetv.live/');
  });
});
