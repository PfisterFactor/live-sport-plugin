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
    const answers = ['<html>maintenance</html>', SCHEDULE];
    const seen = [];
    p.proxyFetch = async (url) => { seen.push(url); return res({ body: answers.shift() }); };
    expect(await p.fetchSchedule.fire()).toBe(SCHEDULE);
    expect(seen).toEqual(['https://dlive.sx/index.php', 'https://dlstreams.st/index.php']);
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

  it('ignores TikTok-cloaked manifests', async () => {
    const html = '<script>var u="https://cowedd4855ws.tiktokcdn.com/x.m3u8"</script>';
    expect(await p._resolveFromHtml(html, 'https://x.example/e', 2)).toBeNull();
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

  it('probes the cast mirror first and the generic stream folder last, dlive.sx before dlstreams.st', () => {
    expect(p.folders).toEqual(['cast', 'casting', 'watch', 'player', 'plus', 'stream']);
    expect(p.baseDomains).toEqual(['https://dlive.sx', 'https://dlstreams.st']);
  });

  it('stops at the first folder that yields a manifest', async () => {
    const probed = [];
    p._playerEmbedUrl = async (id, base, folder) => { probed.push(`${base}/${folder}`); return folder === 'casting' ? 'https://emb.example/e/1' : null; };
    p.extractM3u8 = async () => ({ m3u8: 'https://cdn.example/a.m3u8', referer: 'https://emb.example/' });

    const r = await p._resolveChannel('91');
    expect(r).toEqual({ m3u8: 'https://cdn.example/a.m3u8', referer: 'https://emb.example/', embedUrl: 'https://emb.example/e/1' });
    expect(probed).toEqual(['https://dlive.sx/cast', 'https://dlive.sx/casting']);
  });

  it('moves on to the next folder when an embed has no manifest', async () => {
    p._playerEmbedUrl = async (id, base, folder) => `https://emb.example/${folder}`;
    p.extractM3u8 = async (embed) => (embed.endsWith('/watch') ? { m3u8: 'https://cdn.example/w.m3u8', referer: 'https://emb.example/' } : null);
    expect((await p._resolveChannel('91')).embedUrl).toBe('https://emb.example/watch');
  });

  it('skips the cloaked TikTok web player iframe', async () => {
    p.proxyFetch = async () => res({ body: '<iframe src="https://daddyliveplayer.st/embed/1"></iframe>' });
    expect(await p._playerEmbedUrl('1', 'https://dlive.sx', 'cast')).toBeNull();
  });

  it('resolves protocol-relative and root-relative iframes against the mirror', async () => {
    p.proxyFetch = async () => res({ body: '<iframe src="//emb.example/e/1"></iframe>' });
    expect(await p._playerEmbedUrl('1', 'https://dlive.sx', 'cast')).toBe('https://emb.example/e/1');
    p.proxyFetch = async () => res({ body: '<iframe src="/premium/1.php"></iframe>' });
    expect(await p._playerEmbedUrl('1', 'https://dlive.sx', 'cast')).toBe('https://dlive.sx/premium/1.php');
  });

  it('falls back to the web player when no folder yields a manifest', async () => {
    p._resolveChannel = async () => null;
    const [s] = await p.resolveStream('91', 'football', 'A vs B', { names: ['Sky'] });
    expect(s.externalUrl).toBe('https://dlive.sx/watch.php?id=91');
    expect(s.title).toBe('A vs B (Sky) (Web Player)');
  });
});
