const { describe, it, expect } = require('bun:test');
const SportyHunterProvider = require('../../../src/providers/SportyHunterProvider');
const { makeCradle, res } = require('./fixtures/helpers');

const PAGE_MATCHES = [
  { id: 'sh1', title: 'Arsenal vs Chelsea', sport: 'Soccer', timestamp: 1772366400, url: 'https://sportyhunter.xyz/match/sh1' },
  { name: 'Lakers vs Celtics', sport: 'NBA', date: 1772370000 },
];

function page(scriptTag, payload = { props: { pageProps: { matches: PAGE_MATCHES } } }) {
  return `<!doctype html><body><div id="__next"></div>${scriptTag}${JSON.stringify(payload)}</script></body>`;
}

function makeProvider(html) {
  const p = new SportyHunterProvider(makeCradle());
  p.proxyFetch = async () => (typeof html === 'string' ? res({ body: html }) : html);
  return p;
}

describe('SportyHunterProvider.getMatches', () => {
  it('parses the __NEXT_DATA__ blob into matches', async () => {
    const matches = await makeProvider(page('<script id="__NEXT_DATA__" type="application/json">')).getMatches();
    expect(matches.map((m) => m.id)).toEqual(['sporty_sh1', 'sporty_1']);
    expect(matches[0].title).toBe('Arsenal vs Chelsea');
    expect(matches[0].category).toBe('football');
    expect(matches[0].date).toBe('1772366400000');
    expect(matches[0].sources).toEqual([{ source: 'sportyhunter', id: 'sh1', url: 'https://sportyhunter.xyz/match/sh1' }]);
    expect(matches[1].title).toBe('Lakers vs Celtics');
    expect(matches[1].category).toBe('basketball');
  });

  it('matches the script tag whatever attribute order or extras it carries', async () => {
    const tag = '<script type="application/json" nonce="abc123" id="__NEXT_DATA__" data-nscript="beforeInteractive">';
    const matches = await makeProvider(page(tag)).getMatches();
    expect(matches).toHaveLength(2);
  });

  it('returns [] for an app-router page with no __NEXT_DATA__', async () => {
    const html = '<!doctype html><body><script type="application/json">{"props":{}}</script></body>';
    expect(await makeProvider(html).getMatches()).toEqual([]);
  });

  it('returns [] when the blob is malformed or has no matches array', async () => {
    const broken = '<script id="__NEXT_DATA__">{"props":</script>';
    expect(await makeProvider(broken).getMatches()).toEqual([]);
    expect(await makeProvider(page('<script id="__NEXT_DATA__">', { props: { pageProps: {} } })).getMatches()).toEqual([]);
  });

  it('returns [] when the site is unreachable', async () => {
    expect(await makeProvider(res({ status: 522, body: '' })).getMatches()).toEqual([]);
    expect(await makeProvider('').getMatches()).toEqual([]);
  });
});

describe('SportyHunterProvider.resolveStream', () => {
  it('hands back the match page as an external player link', async () => {
    const [s] = await makeProvider('').resolveStream('sh1', 'football', 'Arsenal vs Chelsea');
    expect(s.externalUrl).toBe('https://sportyhunter.xyz/match/sh1');
    expect(s.url).toBeUndefined();
  });
});
