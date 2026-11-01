const { describe, it, expect } = require('bun:test');
const fs = require('fs');
const path = require('path');
const SportyHunterProvider = require('../../../src/providers/SportyHunterProvider');
const { makeCradle, res } = require('./fixtures/helpers');

const fx = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'sportyhunter', name), 'utf8');
const SCHEDULE = fx('schedule.html');
const MATCH_PAGE = fx('match-vikings-lions.html');
const SLUG = 'minnesota-vikings-at-detroit-lions';
const TAIFOOD = 'https://taifood-blog.asia/embed/nfl/2026-11-01/min-det';

const PAGES = {
  'https://sportsindx.st/new': SCHEDULE,
  [`https://sportsindx.st/match/${SLUG}`]: MATCH_PAGE,
  'https://topembed.online/kero?token=d595e06d7c': fx('topembed-wrapper.html'),
  'https://espn.playerpromax.xyz/embed.php?token=e83e499bbf': fx('playerpromax-wrapper.html'),
  'https://rockyembed.st/source/fetch.php?full=31073': fx('rockyembed-wrapper.html'),
};

function makeProvider(pages = PAGES, extra = {}) {
  const p = new SportyHunterProvider(makeCradle(extra));
  p.requested = [];
  p.proxyFetch = async (url, opts) => {
    p.requested.push({ url, headers: opts && opts.headers });
    const body = pages[url];
    return body === undefined ? res({ status: 404, body: '' }) : res({ body });
  };
  return p;
}

function fakeEmbedIndia() {
  const calls = [];
  return {
    calls,
    resolveStream: async (embedUrl, cat, title, src) => {
      calls.push({ embedUrl, cat, title, src });
      return [{ name: 'EmbedIndia', title, url: `http://x/api/manifest?embed=${encodeURIComponent(embedUrl)}` }];
    },
  };
}

describe('SportyHunterProvider.getMatches', () => {
  it('lists every distinct event from the sportsindx.st schedule page', async () => {
    const matches = await makeProvider().getMatches();
    expect(matches).toHaveLength(80);
    expect(new Set(matches.map((m) => m.id)).size).toBe(80);
  });

  it('returns the live Vikings at Lions game as american_football with its kickoff', async () => {
    const matches = await makeProvider().getMatches();
    const m = matches.find((x) => x.id === `sporty_${SLUG}`);
    expect(m.title).toBe('Minnesota Vikings at Detroit Lions');
    expect(m.category).toBe('american_football');
    expect(m.date).toBe('1793556000000');
    expect(new Date(Number(m.date)).toISOString()).toBe('2026-11-01T18:00:00.000Z');
    expect(m.status).toBe('live');
    expect(m.popular).toBe('1');
    expect(m.sources).toEqual([{ source: 'sportyhunter', id: SLUG }]);
  });

  it('keeps the real sport category rather than the "popular" duplicate', async () => {
    const matches = await makeProvider().getMatches();
    const byCategory = {};
    for (const m of matches) byCategory[m.category] = (byCategory[m.category] || 0) + 1;
    expect(byCategory.american_football).toBe(15);
    expect(byCategory.football).toBe(39);
    expect(byCategory.basketball).toBe(7);
    expect(byCategory.networks).toBe(7);
    expect(byCategory.hockey).toBe(6);
    expect(byCategory.popular).toBeUndefined();
  });

  it('returns [] when the site is unreachable or the page has no schedule', async () => {
    expect(await makeProvider({}).getMatches()).toEqual([]);
    expect(await makeProvider({ 'https://sportsindx.st/new': '<html></html>' }).getMatches()).toEqual([]);
  });
});

describe('SportyHunterProvider.resolveStream', () => {
  it('unwraps nested embeds down to the embedindia-family page and resolves it once', async () => {
    const embedIndia = fakeEmbedIndia();
    const p = makeProvider(PAGES, { embedIndiaProvider: embedIndia });
    const streams = await p.resolveStream(SLUG, 'american_football', 'Minnesota Vikings at Detroit Lions');

    const resolved = embedIndia.calls.map((c) => c.embedUrl);
    expect(resolved).toContain(TAIFOOD);
    expect(resolved).toContain(`${TAIFOOD}_540p`);
    expect(resolved.filter((u) => u === TAIFOOD)).toHaveLength(1);
    expect(streams.filter((s) => s.url).length).toBe(embedIndia.calls.length);
  });

  it('follows iframe src and atob() hops, sending the previous page as referer', async () => {
    const p = makeProvider(PAGES, { embedIndiaProvider: fakeEmbedIndia() });
    expect(await p._resolveEmbed('https://espn.playerpromax.xyz/embed.php?token=e83e499bbf')).toBe(TAIFOOD);
    const hop = p.requested.find((r) => r.url.startsWith('https://rockyembed.st/'));
    expect(hop.headers.Referer).toBe('https://espn.playerpromax.xyz/embed.php?token=e83e499bbf');
  });

  it('falls back to a /watch web player for embeds it cannot unwrap', async () => {
    const p = makeProvider(PAGES, { embedIndiaProvider: fakeEmbedIndia() });
    const streams = await p.resolveStream(SLUG, 'american_football', 'Minnesota Vikings at Detroit Lions');
    const web = streams.find((s) => s.externalUrl && s.externalUrl.includes(encodeURIComponent('https://ch.nexa.st/stream?id=35')));
    expect(web.externalUrl.startsWith('/watch?url=')).toBe(true);
    expect(web.url).toBeUndefined();
  });

  it('returns only web players when no embedindia provider is wired', async () => {
    const streams = await makeProvider().resolveStream(SLUG, 'american_football', 'Vikings');
    expect(streams.length).toBeGreaterThan(0);
    expect(streams.every((s) => s.externalUrl && !s.url)).toBe(true);
  });

  it('returns [] when the match page is missing or has no links', async () => {
    expect(await makeProvider({}).resolveStream('nope', 'x', 'y')).toEqual([]);
    const pages = { 'https://sportsindx.st/match/a': '<html>no links</html>' };
    expect(await makeProvider(pages).resolveStream('a', 'x', 'y')).toEqual([]);
  });
});
