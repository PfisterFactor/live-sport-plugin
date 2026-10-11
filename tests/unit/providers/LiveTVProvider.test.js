const { describe, test, expect, beforeEach } = require('bun:test');
const LiveTVProvider = require('../../../src/providers/LiveTVProvider');
const { makeCradle } = require('./fixtures/helpers');

const { parseArchive, normalizeCategory } = LiveTVProvider;

const ARCHIVE_HTML = `
<a class="main" href="/enx/videotourney/1/"><b>England: Premier League</b></a>
<table width=100% height=27><tr><td><b>Arsenal&ndash;Chelsea</b></td><td><font color="#949494"><b>2:1</b></font></td>
  <a class="small" href="/enx/showvideo/101_arsenal_chelsea/">Highlights</a>
  <table><tr><td>
    <a class="small" href="/enx/showvideo/102_arsenal_chelsea_goal1/">1:0 Saka 12'</a>
    <a class="small" href="/enx/showvideo/103_arsenal_chelsea_goal2/">1:1 Palmer 40'</a>
    <a class="small" href="/enx/showvideo/101_arsenal_chelsea/">Highlights</a>
  </td></tr></table>
</td></tr></table>
<a class="main" href="/enx/videotourney/2/"><b>NHL</b></a>
<table width=100% height=27><tr><td><b>Bruins&ndash;Rangers</b></td>
  <a class="small" href="/enx/showvideo/201_bruins_rangers/">Full Game</a>
</td></tr></table>
<table width=100% height=27><tr><td><b>No Videos&ndash;At All</b></td></tr></table>
`;

describe('LiveTV archive parsing', () => {
  const matches = parseArchive(ARCHIVE_HTML, '20261010');

  test('creates a finished replay per fixture block, tagged livetv', () => {
    expect(matches).toHaveLength(2);
    const [arsenal, bruins] = matches;
    expect(arsenal.title).toBe('Arsenal - Chelsea');
    expect(arsenal.league).toBe('England: Premier League');
    expect(arsenal.category).toBe('football');
    expect(arsenal.status).toBe('finished');
    expect(arsenal.score).toBe('2:1');
    expect(arsenal.team1).toEqual({ name: 'Arsenal' });
    expect(arsenal.team2).toEqual({ name: 'Chelsea' });
    expect(new Date(Number(arsenal.date)).toISOString().startsWith('2026-10-10')).toBe(true);
    expect(arsenal.id).toBe('livetv_arsenal---chelsea-20261010');
    expect(bruins.category).toBe('hockey');
  });

  test('collects every goal clip from nested popup tables once', () => {
    const sources = matches[0].sources;
    expect(sources.map(s => s.name)).toEqual(['Highlights', "1:0 Saka 12'", "1:1 Palmer 40'"]);
    expect(sources.every(s => s.source === 'livetv')).toBe(true);
    expect(sources[0].id).toBe('/enx/showvideo/101_arsenal_chelsea/');
    expect(sources[0].url).toBe('https://livetv.sx/enx/showvideo/101_arsenal_chelsea/');
  });
});

describe('LiveTV sport sections', () => {
  const html = `
<span class="whitetitle">Basketball</span>
<a class="main" href="/enx/videotourney/7/"><b>Euroleague</b></a>
<table width=100% height=27><tr><td><b>Real Madrid&ndash;Olympiacos</b></td>
  <a class="small" href="/enx/showvideo/301_rm_oly/">Highlights</a></td></tr></table>
<span class="whitetitle">Handball</span>
<a class="main" href="/enx/videotourney/8/"><b>Champions League</b></a>
<table width=100% height=27><tr><td><b>Szeged&ndash;Sporting</b></td>
  <a class="small" href="/enx/showvideo/401_sz_sp/">Highlights</a></td></tr></table>
`;

  test('takes the category from the sport section, not the competition name', () => {
    const [euroleague, handball] = parseArchive(html, '20261010');
    expect(euroleague.category).toBe('basketball');
    expect(handball.category).toBe('other');
  });
});

describe('LiveTV category normalisation', () => {
  test('maps competition names to catalog categories', () => {
    expect(normalizeCategory('NHL')).toBe('hockey');
    expect(normalizeCategory('KHL')).toBe('hockey');
    expect(normalizeCategory('NBA')).toBe('basketball');
    expect(normalizeCategory('Euroleague ACB')).toBe('basketball');
    expect(normalizeCategory('ATP Tour')).toBe('tennis');
    expect(normalizeCategory('Formula 1')).toBe('motorsport');
    expect(normalizeCategory('UFC 300')).toBe('mma');
    expect(normalizeCategory('Spain: La Liga')).toBe('football');
    expect(normalizeCategory('Volleyball World Cup')).toBe('other');
    expect(normalizeCategory('Chess')).toBe('other');
  });

  test('short hockey codes do not swallow football leagues', () => {
    expect(normalizeCategory('Estonia: Meistriliiga')).toBe('football');
  });
});

describe('LiveTV stream resolution', () => {
  let provider;
  const pages = {};

  beforeEach(() => {
    provider = new LiveTVProvider(makeCradle());
    for (const k of Object.keys(pages)) delete pages[k];
    provider._getMirrored = async (path) => {
      if (!(path in pages)) throw new Error(`404 ${path}`);
      return pages[path];
    };
  });

  test('emits a YouTube stream for an og:video clip and dedupes identical siblings', async () => {
    pages['/enx/showvideo/1/'] = `
      <meta property="og:video" content="https://www.youtube.com/embed/AbCdEfGhIjK">
      <b>Other Videos:</b><a href="/enx/showvideo/2/">Goal 1</a><a href="/enx/showvideo/3/">Goal 2</a></table>`;
    pages['/enx/showvideo/2/'] = '<meta property="og:video" content="https://www.youtube.com/embed/AbCdEfGhIjK">';
    pages['/enx/showvideo/3/'] = '<iframe src="https://www.youtube.com/embed/ZZZZZZZZZZZ"></iframe>';

    const streams = await provider.resolveStream('/enx/showvideo/1/', 'football', 'x', { name: 'Highlights' });
    expect(streams.map(s => s.ytId)).toEqual(['AbCdEfGhIjK', 'ZZZZZZZZZZZ']);
    expect(streams[0].externalUrl).toBe('https://www.youtube.com/watch?v=AbCdEfGhIjK');
    expect(streams.every(s => s._livetvReplay)).toBe(true);
  });

  test('snipes a shortener redirect down to the YouTube id', async () => {
    pages['/enx/showvideo/9/'] = '<meta property="og:video" content="https://tinyurl.com/abc123">';
    provider._unshorten = async () => 'https://youtu.be/QwErTyUiOpA';

    const [s] = await provider.resolveStream('/enx/showvideo/9/', 'football', 'x', { name: 'Goal' });
    expect(s.ytId).toBe('QwErTyUiOpA');
  });

  test('plays a direct mp4 with the player headers', async () => {
    pages['/enx/showvideo/5/'] = '<meta property="og:video" content="https://emb.apl500.online/files/a.mp4">';
    const [s] = await provider.resolveStream('/enx/showvideo/5/', 'football', 'x', { name: 'Full' });
    expect(s.url).toBe('https://emb.apl613.online/files/a.mp4');
    expect(s.behaviorHints.proxyHeaders.request.Referer).toBe('https://emb.apl613.online/');
    expect(s.behaviorHints.notWebReady).toBe(true);
  });

  test('falls back to the clip page when no clip target exists, and caches the result', async () => {
    let fetches = 0;
    provider._getMirrored = async () => { fetches++; return '<html>nothing useful</html>'; };

    const first = await provider.resolveStream('/enx/showvideo/7/', 'football', 'x', { name: 'Odd' });
    const second = await provider.resolveStream('/enx/showvideo/7/', 'football', 'x', { name: 'Odd' });
    expect(first).toEqual([{ name: 'LiveTV (Web)', title: 'LiveTV | Odd', externalUrl: 'https://livetv.sx/enx/showvideo/7/', _livetvReplay: true }]);
    expect(second).toBe(first);
    expect(fetches).toBe(1);
  });

  test('returns an empty list when the clip page cannot be fetched', async () => {
    expect(await provider.resolveStream('/enx/showvideo/404/', 'football', 'x')).toEqual([]);
  });
});

describe('LiveTV retention', () => {
  test('requests a rolling 21-day archive by default', () => {
    const days = new LiveTVProvider(makeCradle())._recentYmd();
    expect(days).toHaveLength(21);
    expect(new Set(days).size).toBe(21);
  });
});
