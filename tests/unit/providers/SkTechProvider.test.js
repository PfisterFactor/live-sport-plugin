const { describe, test, expect } = require('bun:test');
const fs = require('fs');
const path = require('path');
const SkTechProvider = require('../../../src/providers/SkTechProvider');
const { makeCradle } = require('./fixtures/helpers');

const m3u = fs.readFileSync(path.join(__dirname, 'fixtures/live/sktech_sonyliv.m3u'), 'utf8');

describe('SkTechProvider', () => {
  test('cleanEventTitle strips language prefix and date suffix', () => {
    expect(SkTechProvider.cleanEventTitle('ENG | India A vs Pakistan Shaheens - 22 Nov 2026')).toBe('India A vs Pakistan Shaheens');
  });

  test('parsePlaylist reads attributes and pipe headers', () => {
    const rows = SkTechProvider.parsePlaylist(m3u);
    expect(rows.length).toBe(5);
    expect(rows[0].url).toContain('/ENG/master.m3u8');
    expect(rows[0].headers.Referer).toBe('https://www.sonyliv.com/');
    expect(rows[1].lang).toBe('Hindi');
  });

  test('one match per fixture with a source per language', async () => {
    const p = new SkTechProvider(makeCradle());
    p.fetchFeed = { fire: async (url) => (url.includes('nony2') ? m3u : '#EXTM3U\n') };
    const matches = await p.getMatches();
    expect(matches.length).toBe(1);
    expect(matches[0].title).toBe('India A vs Pakistan Shaheens');
    expect(matches[0].category).toBe('cricket');
    expect(matches[0].sources.map((s) => s.lang)).toEqual(['English', 'Hindi', 'Tamil', 'Telugu', 'Kannada']);
  });

  test('keeps only 720p and 1080p rows from tagged feeds', () => {
    const p = new SkTechProvider(makeCradle());
    const text = ['240p', '720p', '1080p'].map((r) =>
      `#EXTINF:-1 tvg-id="9" tvg-name="A vs B" group-title="Cricket", NAM vs UGA | ${r} | ENG\nhttps://cdn.example/${r}.m3u8`).join('\n');
    const events = new Map();
    p._collect(SkTechProvider.parsePlaylist(text), { label: 'FanCode' }, events);
    const [event] = [...events.values()];
    expect(event.sources.map((s) => s.resolution)).toEqual(['720P', '1080P']);
  });

  test('resolveStream proxies the playlist URL with its referer', async () => {
    const p = new SkTechProvider(makeCradle());
    const [match] = await Object.assign(p, { fetchFeed: { fire: async () => m3u } }).getMatches();
    const [stream] = await p.resolveStream(match.sources[1].id, 'cricket', match.title, match.sources[1]);
    const q = new URL(stream.url).searchParams;
    expect(q.get('url')).toContain('/HIN/master.m3u8');
    expect(q.get('referer')).toBe('https://www.sonyliv.com/');
    expect(stream.title).toContain('Hindi');
  });
});
