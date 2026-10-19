const { describe, it, expect } = require('bun:test');
const StreamEastProvider = require('../../../src/providers/StreamEastProvider');
const { makeCradle, res } = require('./fixtures/helpers');

const HOME = `
<div class="m-card m-card--live m-card--hot" data-mac-id="47135" data-cat-id="8" data-hot-game="1" data-time="1792330200" data-team-names="Houston Texans|Jacksonville Jaguars" data-mark-home="/images/houston-texans.svg" data-mark-away="/images/jacksonville-jaguars.svg"><a class="m-card__link" href="/nfl/houston-texans-vs-jacksonville-jaguars/" aria-label="Houston Texans vs Jacksonville Jaguars"></a><span class="m-card__name">Texans</span></div>
<a class="m-card m-card--hot m-card--event" href="/nfl/nfl-redzone-28/" data-mac-id="47147" data-cat-id="8" data-time="1792342740"><div class="m-card__body m-card__body--event"><span class="m-card__title">NFL Redzone</span></div></a>
<div class="m-card" data-mac-id="47136" data-cat-id="8" data-time="1792342800" data-team-names="Chicago Bears|Atlanta Falcons"><a class="m-card__link" href="/nfl/chicago-bears-vs-atlanta-falcons/" aria-label="Chicago Bears vs Atlanta Falcons"></a></div>
<div class="m-card m-card--live" data-mac-id="47093" data-cat-id="20" data-pro-only="1" data-time="1792336500" data-team-names="Lorient|Monaco"><a class="m-card__link" href="/soccer/lorient-e273-vs-monaco/" aria-label="Lorient vs Monaco"></a></div>
<a class="m-card m-card--live m-card--event" href="/other-events/dutch-darts-1792321200/" data-mac-id="47113" data-cat-id="23" data-time="1792321200" data-sport-tag="darts"><span class="m-card__title">Dutch Darts &amp; More</span></a>
`;

const EVENT = `
<div class="stream-alt-content">
  <a class="stream-alt-item active" href="/nfl/x-vs-y/1"><span class="stream-alt-name">Free Server 1</span></a>
  <a class="stream-alt-item" href="/nfl/x-vs-y/2"><span class="stream-alt-name">Free Server 2</span></a>
  <a class="stream-alt-item stream-alt-item-pro" href="/nfl/x-vs-y/5"><span class="stream-alt-hd-badge">HD</span><span class="stream-alt-name">NFL Network</span></a>
</div>
<iframe id="iframe" width="100%" src="https://streame.center/stream-east/ch30.php" referrerpolicy="origin"></iframe>
`;

function makeProvider(pages, extract) {
  const p = new StreamEastProvider(makeCradle({ dliveProvider: { extractM3u8: extract } }));
  p.proxyFetch = async (url) => (url in pages ? res({ body: pages[url] }) : res({ status: 404 }));
  return p;
}

describe('StreamEastProvider.parseCards', () => {
  const p = makeProvider({}, async () => null);
  const matches = p.parseCards(HOME);
  const byId = Object.fromEntries(matches.map((m) => [m.id, m]));

  it('skips premium-only cards', () => {
    expect(byId.se_47093).toBeUndefined();
  });

  it('takes an event card title from its own body, not the next card', () => {
    expect(byId.se_47147.title).toBe('NFL Redzone');
    expect(byId.se_47147.sources[0].id).toBe('/nfl/nfl-redzone-28/');
  });

  it('maps live state, kickoff, section and sport tag', () => {
    expect(byId.se_47135).toMatchObject({ status: 'live', category: 'american_football', date: '1792330200000', popular: '1' });
    expect(byId.se_47135.team1).toEqual({ name: 'Houston Texans', logo: 'https://v2.streameast.ga/images/houston-texans.svg' });
    expect(byId.se_47136.status).toBe('upcoming');
    expect(byId.se_47113).toMatchObject({ category: 'darts', title: 'Dutch Darts & More' });
  });
});

describe('StreamEastProvider.resolveStream', () => {
  it('resolves free servers only and falls back to the web player when a chain fails', async () => {
    const base = 'https://v2.streameast.ga';
    const pages = {
      [`${base}/nfl/x-vs-y/`]: EVENT,
      [`${base}/nfl/x-vs-y/2`]: '<iframe id="iframe" src="//flyembed.cfd/embed/24.php"></iframe>',
    };
    const extracted = [];
    const p = makeProvider(pages, async (embed) => {
      extracted.push(embed);
      return embed.includes('streame.center')
        ? { m3u8: 'https://edgestream7.pro/hls/a.m3u8?st=t&e=1', referer: 'https://streame.center/' }
        : null;
    });

    const streams = await p.resolveStream('/nfl/x-vs-y/', 'american_football', 'X vs Y');
    expect(extracted).toEqual(['https://streame.center/stream-east/ch30.php', 'https://flyembed.cfd/embed/24.php']);
    expect(streams).toHaveLength(2);

    const q = new URL(streams[0].url).searchParams;
    expect(streams[0].title).toBe('X vs Y (Server 1)');
    expect(q.get('url')).toBe('https://edgestream7.pro/hls/a.m3u8?st=t&e=1');
    expect(q.get('renew')).toBe('streameast');
    expect(q.get('embed')).toBe('https://streame.center/stream-east/ch30.php');

    expect(streams[1].title).toBe('X vs Y (Server 2) (Web Player)');
    expect(streams[1].externalUrl).toBe(`${base}/nfl/x-vs-y/2`);
  });
});
