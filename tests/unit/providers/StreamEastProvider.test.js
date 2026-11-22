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

const BOOT = '{"t":"eyJwIjoiYzI2NjUiLCJoIjoidjIuc3RyZWFtZWFzdC5nYSIsInUiOiJkNzEzZGFkYmYzZDBjYTI1IiwiZSI6MTc5NTM3ODMzNiwiciI6IkFNbDg2cVNfIn0.sig","hs":"https://hs.embedse.com/v/hs"}';
const M3U8 = 'https://hs.embedse.com/q/lV-4n_brwwrnKobNX8pxhw/1795392793/c2665/index.m3u8';

const EVENT = `
<div class="stream-alt-content">
  <a class="stream-alt-item active" href="/nfl/x-vs-y/1"><span class="stream-alt-name">Free Server 1</span></a>
  <a class="stream-alt-item" href="/nfl/x-vs-y/2"><span class="stream-alt-name">Free Server 2</span></a>
  <a class="stream-alt-item stream-alt-item-pro" href="/nfl/x-vs-y/5"><span class="stream-alt-hd-badge">HD</span><span class="stream-alt-name">NFL Network</span></a>
</div>
<script>
    var _seEsBoot = ${BOOT};
    var _sePlayRef = "";
</script>
`;

function makeProvider(pages, handshake = async () => ({ ok: true, q: M3U8 })) {
  const p = new StreamEastProvider(makeCradle());
  p.posts = [];
  p.proxyFetch = async (url, opts = {}) => {
    if (opts.method === 'POST') {
      p.posts.push({ url, opts });
      return res({ json: await handshake(opts) });
    }
    return url in pages ? res({ body: pages[url] }) : res({ status: 404 });
  };
  return p;
}

describe('StreamEastProvider.parseCards', () => {
  const p = makeProvider({});
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

describe('StreamEastProvider.parseBoot', () => {
  it('reads the ticket and handshake host from the inline boot config', () => {
    expect(StreamEastProvider.parseBoot(EVENT)).toEqual({ t: JSON.parse(BOOT).t, hs: 'https://hs.embedse.com/v/hs' });
  });

  it('returns null for pages without a usable boot config', () => {
    expect(StreamEastProvider.parseBoot('<iframe id="iframe" src="https://x.test/p"></iframe>')).toBeNull();
    expect(StreamEastProvider.parseBoot('var _seEsBoot = null;')).toBeNull();
    expect(StreamEastProvider.parseBoot('var _seEsBoot = {"t":"a"};')).toBeNull();
    expect(StreamEastProvider.parseBoot(null)).toBeNull();
  });
});

describe('StreamEastProvider.resolveStream', () => {
  const base = 'https://v2.streameast.ga';

  it('resolves free servers through the handshake and falls back to the web player without a boot config', async () => {
    const pages = {
      [`${base}/nfl/x-vs-y/`]: EVENT,
      [`${base}/nfl/x-vs-y/2`]: '<html>no player</html>',
      [M3U8]: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv_fox\n',
    };
    const p = makeProvider(pages);

    const streams = await p.resolveStream('/nfl/x-vs-y/', 'american_football', 'X vs Y');
    expect(streams).toHaveLength(1 + 1);

    expect(p.posts).toHaveLength(1);
    expect(p.posts[0].url).toBe('https://hs.embedse.com/v/hs');
    expect(JSON.parse(p.posts[0].opts.body)).toEqual({ mt: JSON.parse(BOOT).t, q: 1 });
    expect(p.posts[0].opts.headers.Origin).toBe(base);

    const q = new URL(streams[0].url).searchParams;
    expect(streams[0].title).toBe('X vs Y (Server 1)');
    expect(q.get('url')).toBe(M3U8);
    expect(q.get('referer')).toBe(`${base}/`);
    expect(q.get('origin')).toBe(base);
    expect(q.get('renew')).toBe('streameast');
    expect(q.get('embed')).toBe(`${base}/nfl/x-vs-y/1`);

    expect(streams[1].title).toBe('X vs Y (Server 2) (Web Player)');
    expect(streams[1].externalUrl).toBe(`${base}/nfl/x-vs-y/2`);
  });

  it('falls back to the web player when the handshake is refused or the playlist is not HLS', async () => {
    const refused = makeProvider({ [`${base}/nfl/x-vs-y/`]: EVENT }, async () => ({ ok: false, e: 'ticket' }));
    expect((await refused.resolveStream('/nfl/x-vs-y/', 'american_football', 'X vs Y'))[0].externalUrl).toBe(`${base}/nfl/x-vs-y/1`);

    const notHls = makeProvider({ [`${base}/nfl/x-vs-y/`]: EVENT, [M3U8]: '<html>' });
    expect((await notHls.resolveStream('/nfl/x-vs-y/', 'american_football', 'X vs Y'))[0].externalUrl).toBe(`${base}/nfl/x-vs-y/1`);
  });
});

describe('StreamEastProvider.extractM3u8', () => {
  it('re-mints the playlist URL from the server page', async () => {
    const p = makeProvider({ 'https://v2.streameast.ga/nfl/x-vs-y/1': EVENT });
    expect(await p.extractM3u8('https://v2.streameast.ga/nfl/x-vs-y/1')).toEqual({ m3u8: M3U8, referer: 'https://v2.streameast.ga/' });
  });

  it('returns null when the page has no boot config', async () => {
    const p = makeProvider({ 'https://v2.streameast.ga/nfl/x-vs-y/1': '<html></html>' });
    expect(await p.extractM3u8('https://v2.streameast.ga/nfl/x-vs-y/1')).toBeNull();
  });
});
