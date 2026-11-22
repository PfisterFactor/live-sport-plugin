const os = require('os');
const { describe, it, expect, beforeEach, afterEach, setSystemTime, spyOn } = require('bun:test');
const DliveProvider = require('../../../src/providers/DliveProvider');
const IframeDomainRegistry = require('../../../src/services/IframeDomainRegistry');
const { BREAKER_TIMEOUT_MS } = require('../../../src/services/CircuitBreakerService');
const { makeCradle, res } = require('./fixtures/helpers');

function encodeEconfig(config) {
  const inner = Buffer.from(JSON.stringify(config), 'utf8').toString('base64');
  const order = [2, 0, 3, 1];
  const size = Math.ceil(inner.length / order.length);
  const slices = [];
  for (let i = 0, at = 0; i < order.length; i++, at += size) slices.push(inner.substr(at, size));
  return Buffer.from(
    order.map((pos) => {
      const b = Buffer.from(slices[pos], 'binary').toString('base64');
      return `${b.slice(0, 3)}X${b.slice(3)}`;
    }).join(''),
    'binary',
  ).toString('base64');
}

function event(time, title, channels) {
  const links = channels.map(([id, name]) => `<a target="_blank" href="/watch.php?id=${id}" title="${name}">${name}</a>`).join('');
  return `<div class="schedule__event">
    <div class="schedule__eventHeader"><span class="schedule__time" data-time="${time}">${time}</span><span class="schedule__eventTitle">${title}</span></div>
    <div class="schedule__channels">${links}</div>
  </div>`;
}

function day(title, category, events) {
  return `<div class="schedule__day"><div class="schedule__dayTitle">${title}</div>
    <div class="schedule__category is-expanded"><div class="schedule__catHeader"><div class="card__meta">${category}</div></div>
    <div class="schedule__categoryBody">${events.join('')}</div></div></div>`;
}

const SCHEDULE = `<section>
  ${day('Sunday 20th Sep 2026 - Schedule Time UK GMT', 'All Soccer Events ⚽', [
    event('11:00', '⚽ Scottish Premiership : Celtic vs Rangers', [['35', 'Sky Sports Football UK'], ['00', 'Placeholder'], ['1267', 'Event SD Stream']]),
    event('12:00', 'Only Event Streams', [['1268', 'Event Stream 2']]),
    event('01:00', 'Long Gone vs Finished', [['40', 'Some Channel']]),
  ])}
  ${day('Monday 21st Sep 2026 - Schedule Time UK GMT', 'NBA 🏀', [
    event('19:30', 'Lakers vs Warriors', [['50', 'NBA TV']]),
  ])}
</section>`;

const CHANNELS_HTML = `
  <a href="/watch.php?id=94"><div class="card__title">beIN Sports 4</div></a>
  <a href='watch.php?id=95'><div class="card__title">Sky Sports &amp; More</div></a>
  <a href="/watch.php?id=96"><div class="card__title">18+ Adult</div></a>
  <a href="/watch.php?id=94"><div class="card__title">beIN Sports 4</div></a>`;

function makeProvider(extra = {}) {
  const p = new DliveProvider(makeCradle(extra));
  p.fetchSchedule = { fire: async () => SCHEDULE };
  p.fetchChannels = { fire: async () => CHANNELS_HTML };
  return p;
}

describe('DliveProvider schedule', () => {
  beforeEach(() => setSystemTime(new Date('2026-09-20T10:30:00Z')));
  afterEach(() => setSystemTime());

  it('parses every day of the schedule, not just the first', async () => {
    const matches = await makeProvider().getMatches();
    const fixtures = matches.filter(m => m.category !== 'networks');
    expect(fixtures.map(m => m.title)).toEqual(['Celtic vs Rangers', 'Lakers vs Warriors']);
    expect(new Date(Number(fixtures[1].date)).toISOString()).toBe('2026-09-21T18:30:00.000Z');
    expect(fixtures[1].category).toBe('basketball');
  });

  it('moves the league into a property and extracts the teams', async () => {
    const [celtic] = await makeProvider().getMatches();
    expect(celtic.league).toBe('Scottish Premiership');
    expect(celtic.team1).toEqual({ name: 'Celtic' });
    expect(celtic.team2).toEqual({ name: 'Rangers' });
  });

  it('drops placeholder channels and events that only have placeholders', async () => {
    const matches = await makeProvider().getMatches();
    expect(matches.find(m => m.title === 'Only Event Streams')).toBeUndefined();
    expect(matches[0].sources[0].id).toBe('35');
    expect(matches[0].sources[0].names).toEqual(['Sky Sports Football UK']);
  });

  it('drops events that finished long ago', async () => {
    setSystemTime(new Date('2026-09-20T23:00:00Z'));
    const titles = (await makeProvider().getMatches()).map(m => m.title);
    expect(titles).not.toContain('Celtic vs Rangers');
    expect(titles).toContain('Lakers vs Warriors');
  });

  it('keeps the 24/7 channels as deduplicated networks without adult rows', async () => {
    const channels = (await makeProvider().getMatches()).filter(m => m.category === 'networks');
    expect(channels.map(m => m.title)).toEqual(['beIN Sports 4', 'Sky Sports & More']);
    expect(channels[0].id).toBe('dl_ch_94_bein-sports-4');
    expect(channels[0].sources).toEqual([{ source: 'dlive', id: '94', names: ['beIN Sports 4'] }]);
    expect(channels[0].date).toBe('');
  });
});

describe('DliveProvider schedule failure fallback', () => {
  it('starts with an unknown schedule health and a stable source name', () => {
    const p = new DliveProvider(makeCradle());
    expect(p.lastScheduleOk).toBeNull();
    expect(p.sourceName).toBe('dlive');
  });

  it('keeps the 24/7 channels and reports the schedule as broken when the schedule fails', async () => {
    const p = makeProvider();
    p.fetchSchedule = { fire: async () => null };
    const matches = await p.getMatches();
    expect(matches.length).toBe(2);
    expect(matches.every(m => m.category === 'networks')).toBe(true);
    expect(p.lastScheduleOk).toBe(false);
  });

  it('reports the schedule as healthy once it parses, and resets after a later failure', async () => {
    const p = makeProvider();
    await p.getMatches();
    expect(p.lastScheduleOk).toBe(true);
    p.fetchSchedule = { fire: async () => { throw new Error('boom'); } };
    await p.getMatches();
    expect(p.lastScheduleOk).toBe(false);
  });

  it('keeps fixtures when only the channel list fails', async () => {
    setSystemTime(new Date('2026-09-20T10:30:00Z'));
    const p = makeProvider();
    p.fetchChannels = { fire: async () => { throw new Error('boom'); } };
    const matches = await p.getMatches();
    setSystemTime();
    expect(matches.map(m => m.title)).toEqual(['Celtic vs Rangers', 'Lakers vs Warriors']);
    expect(p.lastScheduleOk).toBe(true);
  });

  it('only counts a schedule fetch as a success when it holds events', async () => {
    const p = new DliveProvider(makeCradle());
    const seen = [];
    p.proxyFetch = async (url) => { seen.push(url); return res({ body: '<html>maintenance</html>' }); };
    await expect(p.fetchSchedule.fire()).rejects.toThrow('schedule contained no events');
    p.proxyFetch = async (url) => { seen.push(url); return res({ body: SCHEDULE }); };
    expect(await p.fetchSchedule.fire()).toBe(SCHEDULE);
    expect(seen).toEqual(['https://thedaddy.li/index.php', 'https://thedaddy.li/index.php']);
  });
});

describe('DliveProvider sync timeout', () => {
  const ENV_KEYS = ['DADDYLIVE_SYNC_TIMEOUT_MS', 'SYNC_TIMEOUT_BASE_MS', 'SYNC_TIMEOUT_MAX_MS'];
  let saved;
  let loadSpy;
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
    ENV_KEYS.forEach(k => delete process.env[k]);
  });
  afterEach(() => {
    ENV_KEYS.forEach(k => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k])));
    if (loadSpy) loadSpy.mockRestore();
  });

  const at = (load) => {
    loadSpy = spyOn(os, 'loadavg').mockReturnValue([load, load, load]);
    return DliveProvider.resolveSyncTimeoutMs();
  };

  it('uses a 12 s baseline on an idle box and adds headroom as load rises', () => {
    expect(at(0)).toBe(12000);
    expect(at(3)).toBe(18000);
  });

  it('never exceeds the circuit breaker abort time', () => {
    expect(at(1000)).toBe(BREAKER_TIMEOUT_MS - 2000);
    process.env.SYNC_TIMEOUT_MAX_MS = '60000';
    expect(at(1000)).toBeLessThan(BREAKER_TIMEOUT_MS);
  });

  it('respects explicit overrides within the ceiling', () => {
    process.env.SYNC_TIMEOUT_BASE_MS = '15000';
    expect(at(0)).toBe(15000);
    process.env.DADDYLIVE_SYNC_TIMEOUT_MS = '9999';
    expect(at(900)).toBe(9999);
    process.env.DADDYLIVE_SYNC_TIMEOUT_MS = '999999';
    expect(at(0)).toBe(BREAKER_TIMEOUT_MS - 2000);
  });
});

describe('DliveProvider embed resolution', () => {
  let p;
  beforeEach(() => {
    p = new DliveProvider(makeCradle({ iframeDomainRegistry: new IframeDomainRegistry() }));
  });

  const pageMap = (pages) => {
    const calls = [];
    p.proxyFetch = async (url) => {
      calls.push(url);
      if (!(url in pages)) return res({ status: 404 });
      return res({ body: pages[url] });
    };
    return calls;
  };

  it('decodes _econfig and prefers the non-p2p manifest', async () => {
    const config = { stream_url: 'https://c.7odxv0l067ka.net/hls/a.m3u8?p2p', stream_url_nop2p: 'https://c.7odxv0l067ka.net/hls/b.m3u8?s=1&e=2' };
    const html = `<script>window._econfig='${encodeEconfig(config)}';</script>`;
    const r = await p._resolveFromHtml(html, 'https://assetrage.net/e/x');
    expect(r).toEqual({ url: config.stream_url_nop2p, referer: 'https://assetrage.net/e/x', strategy: 'econfig' });
  });

  it('reads wideiptv style streamUrl config with escaped separators', async () => {
    const html = 'const config = { streamUrl: "https:\\/\\/ds1.bluetier.top\\/beINAR\\/index.m3u8?token=abc\\u0026x=1" };';
    const r = await p._resolveFromHtml(html, 'https://wideiptv.top/player/beINAR');
    expect(r.strategy).toBe('config');
    expect(r.url).toBe('https://ds1.bluetier.top/beINAR/index.m3u8?token=abc&x=1');
  });

  it('keeps the whole signed query of an inline JSON manifest', async () => {
    const html = '{"src":"https:\\/\\/hls.hockey.do\\/a.m3u8?e=1\\u0026sig=zz"}';
    const r = await p._resolveFromHtml(html, 'https://play.matchli.st/x');
    expect(r.url).toBe('https://hls.hockey.do/a.m3u8?e=1&sig=zz');
  });

  it('follows a JSON player hop using the id from loadPlayerChannel, not the template', async () => {
    const calls = pageMap({
      'https://vertex.st/api/player.php?id=91': JSON.stringify({ url: 'https://play.matchli.st/embed/91' }),
      'https://play.matchli.st/embed/91': 'window.PP={"file":"https:\\/\\/hls.hockey.do\\/live.m3u8?e=1\\u0026sig=q"}',
    });
    const html = 'fetch("api/player.php?id=" + safeId); loadPlayerChannel(91);';
    const r = await p._resolveFromHtml(html, 'https://vertex.st/player.html');
    expect(r.url).toBe('https://hls.hockey.do/live.m3u8?e=1&sig=q');
    expect(calls[0]).toBe('https://vertex.st/api/player.php?id=91');
    expect(p.domainRegistry.strategyFor('vertex.st')).toBe('json-hop');
  });

  it('follows nested iframes, trying registry-known hosts before unknown ones', async () => {
    const calls = pageMap({
      'https://unknown.example/frame': '<html>nothing</html>',
      'https://streame.center/embed/ch1.php': 'var s="https://edgestream5.pro/hls/a.m3u8?t=1";',
    });
    const html = '<iframe src="https://unknown.example/frame"></iframe><iframe src="//streame.center/embed/ch1.php"></iframe><iframe src="https://www.google.com/x"></iframe>';
    const r = await p._resolveFromHtml(html, 'https://wrapper.example/p');
    expect(r.url).toBe('https://edgestream5.pro/hls/a.m3u8?t=1');
    expect(calls[0]).toBe('https://streame.center/embed/ch1.php');
    expect(calls).not.toContain('https://www.google.com/x');
  });

  it('stops following wrappers after the maximum depth', async () => {
    const calls = pageMap({
      'https://a.example/1': '<iframe src="https://b.example/2"></iframe>',
      'https://b.example/2': '<iframe src="https://c.example/3"></iframe>',
      'https://c.example/3': '<iframe src="https://d.example/4"></iframe>',
      'https://d.example/4': 'var u="https://cdn.example/x.m3u8";',
    });
    expect(await p._resolveFromHtml('<iframe src="https://a.example/1"></iframe>', 'https://root.example/', 0)).toBeNull();
    expect(calls).toEqual(['https://a.example/1', 'https://b.example/2']);
  });

  it('uses the registry Referer for a known terminal manifest host, the page origin otherwise', async () => {
    const known = 'https://c2807p.7odxv0l067ka.net/hls/live/302.m3u8?token=1';
    pageMap({ 'https://tiestep.top/e/1': `var u="${known}";` });
    expect(await p.extractM3u8('https://tiestep.top/e/1')).toEqual({ m3u8: known, referer: 'https://assetrage.net/' });

    const unknown = 'https://cdn.nobody-knows.example/hls/302.m3u8?token=1';
    pageMap({ 'https://tiestep.top/e/2': `var u="${unknown}";` });
    expect(await p.extractM3u8('https://tiestep.top/e/2')).toEqual({ m3u8: unknown, referer: 'https://tiestep.top/' });
  });

  it('returns null when the embed page is unreachable or has no manifest', async () => {
    pageMap({ 'https://x.example/e': '<html>empty</html>' });
    expect(await p.extractM3u8('https://x.example/e')).toBeNull();
    expect(await p.extractM3u8('https://missing.example/e')).toBeNull();
  });
});

describe('DliveProvider channel probing', () => {
  let p;
  beforeEach(() => {
    p = new DliveProvider(makeCradle());
  });

  it('probes only the non-cloaked folders, player before cast, on thedaddy.li', () => {
    expect(p.folders).toEqual(['player', 'cast', 'plus', 'casting']);
    expect(p.baseDomains).toEqual(['https://thedaddy.li']);
    expect(DliveProvider.BASE_URL).toBe('https://thedaddy.li');
  });

  it('stops at the first folder that yields a playing manifest', async () => {
    const probed = [];
    p._playerEmbedUrl = async (id, base, folder) => { probed.push(`${base}/${folder}`); return folder === 'player' ? 'https://emb.example/e/1' : null; };
    p.extractM3u8 = async () => ({ m3u8: 'https://cdn.example/a.m3u8', referer: 'https://emb.example/' });
    p._manifestPlays = async () => true;

    const r = await p._resolveChannel('91');
    expect(r).toEqual({ m3u8: 'https://cdn.example/a.m3u8', referer: 'https://emb.example/', embedUrl: 'https://emb.example/e/1' });
    expect(probed).toEqual(['https://thedaddy.li/player']);
  });

  it('moves on to the next folder when an embed has no manifest', async () => {
    p._playerEmbedUrl = async (id, base, folder) => `https://emb.example/${folder}`;
    p.extractM3u8 = async (embed) => (embed.endsWith('/plus') ? { m3u8: 'https://cdn.example/w.m3u8', referer: 'https://emb.example/' } : null);
    p._manifestPlays = async () => true;
    expect((await p._resolveChannel('91')).embedUrl).toBe('https://emb.example/plus');
  });

  it('moves on when a manifest does not play and never retries the same embed on another mirror', async () => {
    const extracted = [];
    p._playerEmbedUrl = async (id, base, folder) => (folder === 'player' ? 'https://dead.example/e/1' : folder === 'casting' ? 'https://ok.example/e/1' : null);
    p.extractM3u8 = async (embed) => { extracted.push(embed); return { m3u8: `${embed}.m3u8`, referer: 'https://x/' }; };
    p._manifestPlays = async (m3u8) => m3u8.startsWith('https://ok.example');

    expect((await p._resolveChannel('91')).embedUrl).toBe('https://ok.example/e/1');
    expect(extracted).toEqual(['https://dead.example/e/1', 'https://ok.example/e/1']);
  });

  it('returns null when every manifest fails verification', async () => {
    p._playerEmbedUrl = async () => 'https://dead.example/e/1';
    p.extractM3u8 = async () => ({ m3u8: 'https://dead.example/a.m3u8', referer: 'https://dead.example/' });
    p._manifestPlays = async () => false;
    expect(await p._resolveChannel('91')).toBeNull();
  });

  describe('tsOffset', () => {
    const media = (offset, length = 1024) => {
      const b = Buffer.alloc(length, 0x11);
      for (let i = offset; i < length; i += 188) b[i] = 0x47;
      return b;
    };

    it('finds the TS run at offset 0, behind a 42-byte WEBP or 64-byte PNG header, and at the last allowed offset', () => {
      expect(DliveProvider.tsOffset(media(0))).toBe(0);
      expect(DliveProvider.tsOffset(media(42))).toBe(42);
      expect(DliveProvider.tsOffset(media(64))).toBe(64);
      expect(DliveProvider.tsOffset(media(187))).toBe(187);
    });

    it('rejects a run starting at 188 or later, pixel-packed bodies and short bodies', () => {
      expect(DliveProvider.tsOffset(media(188, 2048))).toBe(-1);
      expect(DliveProvider.tsOffset(Buffer.alloc(1024, 0x47).fill(0x80, 0, 1024))).toBe(-1);
      expect(DliveProvider.tsOffset(Buffer.from('#EXTM3U'))).toBe(-1);
      expect(DliveProvider.tsOffset(media(0, 300))).toBe(-1);
    });
  });

  describe('_segmentHead', () => {
    it('reads only the probe size from a server that ignores Range', async () => {
      const server = Bun.serve({ port: 0, fetch: () => new Response(Buffer.alloc(200000, 0x47)) });
      try {
        const head = await p._segmentHead(`http://127.0.0.1:${server.port}/s.ts`, { Referer: 'https://emb.example/' });
        expect(head.status).toBe(200);
        expect(head.bytes.length).toBe(DliveProvider.SEGMENT_PROBE_BYTES);
      } finally {
        server.stop(true);
      }
    });
  });

  describe('_manifestPlays', () => {
    const savedWarmup = DliveProvider.WARMUP_MS;
    const ts = Buffer.alloc(1024, 0x11);
    for (let i = 42; i < ts.length; i += 188) ts[i] = 0x47;
    const okSegment = async () => ({ status: 206, bytes: ts });
    beforeEach(() => { DliveProvider.WARMUP_MS = 0; p._segmentHead = okSegment; });
    afterEach(() => { DliveProvider.WARMUP_MS = savedWarmup; });

    it('re-probes a 404 playlist once and accepts it when the channel has started', async () => {
      let hits = 0;
      p.proxyFetch = async () => (hits++ === 0 ? res({ status: 404 }) : res({ body: '#EXTM3U\n#EXTINF:4,\nseg1.ts\n' }));
      expect(await p._manifestPlays('https://cdn.example/a.m3u8', 'https://emb.example/')).toBe(true);
      expect(hits).toBe(2);
    });

    it('does not re-probe a 403 token wall', async () => {
      let hits = 0;
      p.proxyFetch = async () => { hits++; return res({ status: 403, body: 'token required' }); };
      expect(await p._manifestPlays('https://edge.example/a.m3u8', 'https://emb.example/')).toBe(false);
      expect(hits).toBe(1);
    });

    it('accepts a playlist whose segment carries TS behind an image header and sends the referer', async () => {
      let seen;
      let segUrl;
      p.proxyFetch = async (url, opts) => { seen = opts.headers; return res({ body: '#EXTM3U\n#EXTINF:4,\nhttps://p16-common-sign.tiktokcdn.com/x~tplv-tiktokx-origin.image\n' }); };
      p._segmentHead = async (url, headers) => { segUrl = [url, headers]; return okSegment(); };
      expect(await p._manifestPlays('https://cdn.example/a.m3u8', 'https://emb.example/')).toBe(true);
      expect(seen.Referer).toBe('https://emb.example/');
      expect(segUrl[0]).toBe('https://p16-common-sign.tiktokcdn.com/x~tplv-tiktokx-origin.image');
      expect(segUrl[1].Referer).toBe('https://emb.example/');
    });

    it('follows a master playlist to its first variant and checks the first segment', async () => {
      const calls = [];
      p.proxyFetch = async (url) => {
        calls.push(url);
        return res({ body: url.endsWith('master.m3u8') ? '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv1/index.m3u8\n' : '#EXTM3U\n#EXTINF:4,\nseg1.ts\n' });
      };
      p._segmentHead = async (url) => { calls.push(url); return okSegment(); };
      expect(await p._manifestPlays('https://cdn.example/master.m3u8', 'https://emb.example/')).toBe(true);
      expect(calls).toEqual(['https://cdn.example/master.m3u8', 'https://cdn.example/v1/index.m3u8', 'https://cdn.example/v1/seg1.ts']);
    });

    it('rejects a playlist whose first segment 404s or that lists no segments', async () => {
      p.proxyFetch = async () => res({ body: '#EXTM3U\n#EXTINF:4,\nseg1.ts\n' });
      p._segmentHead = async () => ({ status: 404, bytes: Buffer.alloc(0) });
      expect(await p._manifestPlays('https://cdn.example/a.m3u8', 'https://emb.example/')).toBe(false);
      p.proxyFetch = async () => res({ body: '#EXTM3U\n#EXT-X-ENDLIST\n' });
      expect(await p._manifestPlays('https://cdn.example/a.m3u8', 'https://emb.example/')).toBe(false);
    });

    it('rejects 403 walls, non-playlists, pixel-packed segments, 403 segments and network errors', async () => {
      p.proxyFetch = async () => res({ status: 403, body: 'token required' });
      expect(await p._manifestPlays('https://edge.example/a.m3u8', 'https://emb.example/')).toBe(false);
      p.proxyFetch = async () => res({ body: '<html>nope</html>' });
      expect(await p._manifestPlays('https://cdn.example/a.m3u8', 'https://emb.example/')).toBe(false);
      p.proxyFetch = async () => res({ body: '#EXTM3U\n#EXTINF:6,\nseg1.ts\n' });
      p._segmentHead = async () => ({ status: 206, bytes: Buffer.alloc(1024, 0x80) });
      expect(await p._manifestPlays('https://cdn.example/a.m3u8', 'https://emb.example/')).toBe(false);
      p._segmentHead = async () => ({ status: 403, bytes: Buffer.alloc(0) });
      expect(await p._manifestPlays('https://cdn.example/a.m3u8', 'https://emb.example/')).toBe(false);
      p.proxyFetch = async () => { throw new Error('boom'); };
      expect(await p._manifestPlays('https://cdn.example/a.m3u8', 'https://emb.example/')).toBe(false);
    });
  });

  it('skips the cloaked TikTok web player iframe', async () => {
    p.proxyFetch = async () => res({ body: '<iframe src="https://daddyliveplayer.st/embed/1"></iframe>' });
    expect(await p._playerEmbedUrl('1', 'https://thedaddy.li', 'cast')).toBeNull();
  });

  it('resolves protocol-relative and root-relative iframes against the mirror', async () => {
    p.proxyFetch = async () => res({ body: '<iframe src="//emb.example/e/1"></iframe>' });
    expect(await p._playerEmbedUrl('1', 'https://thedaddy.li', 'cast')).toBe('https://emb.example/e/1');
    p.proxyFetch = async () => res({ body: '<iframe src="/premium/1.php"></iframe>' });
    expect(await p._playerEmbedUrl('1', 'https://thedaddy.li', 'cast')).toBe('https://thedaddy.li/premium/1.php');
  });

  it('falls back to the web player when no folder yields a manifest', async () => {
    p._resolveChannel = async () => null;
    const [s] = await p.resolveStream('91', 'football', 'A vs B', { names: ['Sky'] });
    expect(s.externalUrl).toBe('https://thedaddy.li/watch.php?id=91');
    expect(s.title).toBe('A vs B (Sky) (Web Player)');
  });
});
