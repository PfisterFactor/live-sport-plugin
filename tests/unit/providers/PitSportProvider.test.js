const { describe, test, expect } = require('bun:test');
const fs = require('fs');
const path = require('path');
const PitSportProvider = require('../../../src/providers/PitSportProvider');
const { makeCradle, res } = require('./fixtures/helpers');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures/live', name), 'utf8');

describe('PitSportProvider', () => {
  test('maps the home feed to live matches', async () => {
    const p = new PitSportProvider(makeCradle());
    p.proxyFetch = async () => res({ body: fixture('pitsport_home.json') });
    const matches = await p.getMatches();
    expect(matches.length).toBe(5);
    const bremen = matches.find((m) => m.title === 'Werder Bremen vs Hamburg SV');
    expect(bremen.id).toBe('pitsport_103475_werder-bremen-vs-hamburg-sv');
    expect(bremen.category).toBe('football');
    expect(bremen.status).toBe('live');
    expect(bremen.team1.name).toBe('Werder Bremen');
    expect(bremen.sources[0]).toEqual({ source: 'pitsport', id: '103475', programId: '103475' });
  });

  test('resolves the watch API into a renewable proxied manifest', async () => {
    const p = new PitSportProvider(makeCradle());
    const calls = [];
    p.proxyFetch = async (url, opts) => {
      calls.push(url);
      return url.endsWith('/watch') ? res({ body: fixture('pitsport_watch.json') }) : res({ body: fixture('pitsport_play.json') });
    };
    const streams = await p.resolveStream('103475', 'football', 'Werder Bremen vs Hamburg SV', { programId: '103475' });
    expect(streams.length).toBeGreaterThan(0);
    const url = new URL(streams[0].url);
    expect(url.searchParams.get('url')).toContain('.m3u8');
    expect(url.searchParams.get('referer')).toBe('https://embdlol.st/');
    expect(url.searchParams.get('renew')).toBe('pitsport');
    expect(url.searchParams.get('embed')).toContain('embdlol.st/embed/');
    expect(calls[0]).toContain('/programs/103475/play');
  });

  test('falls back to a web player when the watch API refuses', async () => {
    const p = new PitSportProvider(makeCradle());
    p.proxyFetch = async (url) => (url.endsWith('/watch') ? res({ status: 500 }) : res({ body: fixture('pitsport_play.json') }));
    const streams = await p.resolveStream('103475', 'football', 'Match', { programId: '103475' });
    expect(streams[0].externalUrl).toContain('/watch?url=');
  });
});
