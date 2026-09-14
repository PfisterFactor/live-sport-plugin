const { describe, it, expect, beforeEach, afterEach, setSystemTime } = require('bun:test');
const CdnLiveProvider = require('../../../src/providers/CdnLiveProvider');
const { makeCradle, res } = require('./fixtures/helpers');

const NOW = new Date('2026-03-01T12:00:00Z');
const hours = (h) => new Date(NOW.getTime() + h * 3600000).toISOString().slice(0, 19).replace('T', ' ');

function apiPayload() {
  return {
    'cdn-live-tv': {
      total_events: 99,
      total_events_soccer: 2,
      cached: true,
      Soccer: [
        {
          gameID: 'g1',
          homeTeam: 'Arsenal',
          awayTeam: 'Chelsea',
          homeTeamIMG: 'https://img/a.png',
          awayTeamIMG: 'https://img/c.png',
          tournament: 'Premier League',
          status: 'live',
          start: hours(-0.5),
          channels: [{ channel_name: 'EN HD', url: 'https://cdnlivetv.tv/player/1' }],
        },
        {
          homeTeam: 'Real Madrid',
          awayTeam: 'Barcelona',
          status: 'pre',
          start: hours(3),
          channels: [],
        },
      ],
      Basketball: [
        { gameID: 'b1', name: 'Lakers vs Celtics', status: 'pre', start: hours(5) },
      ],
      'NCAA Football': [
        { gameID: 'n1', name: 'Duke vs UNC', status: 'pre', start: hours(1) },
      ],
      Tennis: [
        { gameID: 'far', name: 'Late Open Final', status: 'pre', start: hours(72) },
        { gameID: 'old', name: 'Yesterday Match', status: 'pre', start: hours(-10) },
        { gameID: 'oldlive', name: 'Long Running Live', status: 'live', start: hours(-10) },
      ],
      Junk: 'not-an-array',
    },
  };
}

function makeProvider(variantKey, { payload = apiPayload(), player } = {}) {
  const p = new CdnLiveProvider(makeCradle(), CdnLiveProvider.VARIANTS[variantKey]);
  p.proxyFetch = async (url, opts) => {
    p._lastOpts = opts;
    if (url === p.apiUrl) return res({ json: payload });
    return player ? player(url, opts) : res({ status: 404, body: '' });
  };
  return p;
}

function b64(s) { return Buffer.from(s, 'utf8').toString('base64'); }

function playerHtml(parts, quote = "'") {
  const vars = parts.map((p, i) => `var v${i} = ${quote}${b64(p)}${quote};`).join('\n');
  const concat = parts.map((_, i) => `dcd(v${i})`).join('+');
  return `<html><script>\n${vars}\nfunction dcd(s) { return atob(s); }\nvar src = ${concat};\njwplayer().setup({file: src});\n</script></html>`;
}

describe('CdnLiveProvider (cdnlive variant)', () => {
  beforeEach(() => setSystemTime(NOW));
  afterEach(() => setSystemTime());

  it('only emits soccer fixtures, prefixed cdn_, all categorised as football', async () => {
    const matches = await makeProvider('cdnlive').getMatches();
    expect(matches.map((m) => m.id)).toEqual(['cdn_g1', 'cdn_real-madrid-vs-barcelona']);
    expect(matches.every((m) => m.category === 'football')).toBe(true);
    expect(matches[0].title).toBe('Arsenal vs Chelsea');
    expect(matches[0].sources).toEqual([{ source: 'cdnlive', id: 'g1' }]);
  });

  it('keeps far-future soccer fixtures because the variant has no time window', async () => {
    const payload = apiPayload();
    payload['cdn-live-tv'].Soccer.push({ gameID: 'later', homeTeam: 'A', awayTeam: 'B', status: 'pre', start: hours(200) });
    const matches = await makeProvider('cdnlive', { payload }).getMatches();
    expect(matches.some((m) => m.id === 'cdn_later')).toBe(true);
  });

  it('reads a naive upstream timestamp as UTC, not server-local time', async () => {
    const payload = { 'cdn-live-tv': { Soccer: [{ gameID: 'g', homeTeam: 'A', awayTeam: 'B', start: '2026-03-01 20:30:00' }] } };
    const [m] = await makeProvider('cdnlive', { payload }).getMatches();
    expect(m.date).toBe(String(Date.UTC(2026, 2, 1, 20, 30, 0)));
  });

  it('falls back to Football when the feed renames the Soccer bucket', async () => {
    const payload = { 'cdn-live-tv': { Football: [{ gameID: 'f1', homeTeam: 'A', awayTeam: 'B', start: hours(1) }] } };
    const matches = await makeProvider('cdnlive', { payload }).getMatches();
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe('cdn_f1');
  });

  it('returns [] when the upstream fetch fails instead of propagating', async () => {
    const p = makeProvider('cdnlive');
    p.proxyFetch = async () => res({ status: 502, body: '' });
    expect(await p.getMatches()).toEqual([]);
  });
});

describe('CdnLiveProvider (streamsports99 variant)', () => {
  beforeEach(() => setSystemTime(NOW));
  afterEach(() => setSystemTime());

  it('emits every category with ss99_ ids and normalised categories', async () => {
    const matches = await makeProvider('streamsports99').getMatches();
    const byId = Object.fromEntries(matches.map((m) => [m.id, m]));
    expect(byId['ss99_g1'].category).toBe('football');
    expect(byId['ss99_b1'].category).toBe('basketball');
    expect(byId['ss99_n1'].category).toBe('college');
    expect(byId['ss99_g1'].sources).toEqual([{ source: 'streamsports99', id: 'g1' }]);
    expect(byId['ss99_g1'].team1).toEqual({ name: 'Arsenal', logo: 'https://img/a.png' });
    expect(byId['ss99_g1'].league).toBe('Premier League');
    expect(byId['ss99_g1'].popular).toBe('1');
    expect(byId['ss99_b1'].popular).toBe('0');
  });

  it('drops fixtures outside the [-6h, +48h] window but keeps live-flagged stragglers', async () => {
    const matches = await makeProvider('streamsports99').getMatches();
    const ids = matches.map((m) => m.id);
    expect(ids).not.toContain('ss99_far');
    expect(ids).not.toContain('ss99_old');
    expect(ids).toContain('ss99_oldlive');
  });

  it('treats the window bounds as inclusive', async () => {
    const payload = { 'cdn-live-tv': { Tennis: [
      { gameID: 'edgePast', name: 'Edge Past', status: 'pre', start: hours(-6) },
      { gameID: 'edgeFuture', name: 'Edge Future', status: 'pre', start: hours(48) },
      { gameID: 'justOver', name: 'Just Over', status: 'pre', start: hours(48.5) },
    ] } };
    const ids = (await makeProvider('streamsports99', { payload }).getMatches()).map((m) => m.id);
    expect(ids).toEqual(['ss99_edgePast', 'ss99_edgeFuture']);
  });

  it('reads naive upstream timestamps as UTC in the all-categories variant too', async () => {
    const payload = { 'cdn-live-tv': { Tennis: [{ gameID: 't', name: 'A vs B', status: 'live', start: '2026-03-01 13:00:00' }] } };
    const [m] = await makeProvider('streamsports99', { payload }).getMatches();
    expect(m.date).toBe(String(Date.UTC(2026, 2, 1, 13, 0, 0)));
  });

  it('skips entries with no usable title', async () => {
    const payload = { 'cdn-live-tv': { Soccer: [{ gameID: 'empty', status: 'live' }, { gameID: 'ok', name: 'Something', status: 'live' }] } };
    const ids = (await makeProvider('streamsports99', { payload }).getMatches()).map((m) => m.id);
    expect(ids).toEqual(['ss99_ok']);
  });

  it('derives slug ids for entries without a gameID', async () => {
    const payload = { 'cdn-live-tv': { Soccer: [{ name: 'Lakers vs Celtics (Game 7)', status: 'live' }] } };
    const [m] = await makeProvider('streamsports99', { payload }).getMatches();
    expect(m.id).toBe('ss99_lakers-vs-celtics--game-7-');
  });
});

describe('CdnLiveProvider.resolveStream', () => {
  beforeEach(() => setSystemTime(NOW));
  afterEach(() => setSystemTime());

  it('decodes the atob-concatenated m3u8 and sets playback headers', async () => {
    const p = makeProvider('cdnlive', {
      player: async () => res({ body: playerHtml(['https://edge.cdn.tv/live/', 'arsenal/index.m3u8']) }),
    });
    const streams = await p.resolveStream('g1', 'football', 'Arsenal vs Chelsea');
    expect(streams).toHaveLength(1);
    expect(streams[0].url).toBe('https://edge.cdn.tv/live/arsenal/index.m3u8');
    expect(streams[0].title).toBe('EN HD');
    expect(streams[0].behaviorHints.proxyHeaders.request.Referer).toBe('https://cdnlivetv.tv/');
    expect(p._lastOpts.headers.Referer).toBe('https://cdnlivetv.tv/');
  });

  it('decodes double-quoted base64 blobs too', async () => {
    const p = makeProvider('cdnlive', {
      player: async () => res({ body: playerHtml(['https://edge.cdn.tv/x.m3u8'], '"') }),
    });
    const [s] = await p.resolveStream('g1', 'football', 'Arsenal vs Chelsea');
    expect(s.url).toBe('https://edge.cdn.tv/x.m3u8');
  });

  it('falls back to the web player link when the page has no decodable stream', async () => {
    const p = makeProvider('cdnlive', { player: async () => res({ body: '<html>blocked</html>' }) });
    const [s] = await p.resolveStream('g1', 'football', 'Arsenal vs Chelsea');
    expect(s.url).toBeUndefined();
    expect(s.externalUrl).toBe('https://cdnlivetv.tv/player/1');
  });

  it('falls back to the web player link on a non-2xx player response', async () => {
    const p = makeProvider('cdnlive', { player: async () => res({ status: 403, body: '' }) });
    const [s] = await p.resolveStream('g1', 'football', 'Arsenal vs Chelsea');
    expect(s.externalUrl).toBe('https://cdnlivetv.tv/player/1');
  });

  it('returns [] for an unknown source id and for a match without channels', async () => {
    const p = makeProvider('cdnlive', { player: async () => res({ body: playerHtml(['https://a/b.m3u8']) }) });
    expect(await p.resolveStream('nope', 'football', 'x')).toEqual([]);
    expect(await p.resolveStream('cdn_real-madrid-vs-barcelona', 'football', 'x')).toEqual([]);
  });

  it('resolves the slug id form used for channel-less entries', async () => {
    const payload = apiPayload();
    payload['cdn-live-tv'].Soccer[1].channels = [{ url: 'https://cdnlivetv.tv/player/9' }];
    const p = makeProvider('cdnlive', { payload, player: async () => res({ status: 404, body: '' }) });
    const [s] = await p.resolveStream('real-madrid-vs-barcelona', 'football', 'x');
    expect(s.title).toBe('CDNLive Stream 1 (Web Player)');
  });
});
