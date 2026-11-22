const { request } = require('undici');
const { fetchRemoteConfigEntries } = require('../src/providers/SkTechProvider');

/** The SK Tech app backend host is published through Firebase Remote Config. */
async function skTechEventsUrl() {
  const { api_url: host } = await fetchRemoteConfigEntries();
  return `${host.replace(/\/$/, '')}/events.txt`;
}

const sources = [
  { name: 'StreamSports', url: 'https://api.cdnlivetv.is/matches' },
  { name: 'StreamSports99', url: 'https://api.cdnlivetv.is/api/v1/events/sports/?user=streamsports99&plan=vip' },
  { name: 'Streamic', url: 'https://streamic.st/api/J.php' },
  { name: 'StreamFree', url: 'https://streamfree.top/streams' },
  { name: 'SportyHunter', url: 'https://sportsindx.st/new' },
  { name: 'PPV / BinTv', url: 'https://api.ppv.st/api/streams' },
  { name: 'NTV', url: 'http://ntv.cx' },
  { name: 'CdnLive', url: 'https://api.cdnlivetv.tv/api/v1/events/sports/?user=cdnlivetv&plan=free' },
  { name: 'StreamCorner', url: 'https://streamcorner.cloud/' },
  { name: 'ZLive', url: 'https://iptv.zlive.st/channels.json' },
  { name: 'DaddyLive', url: 'https://thedaddy.li/' },
  { name: 'TimStreams', url: 'https://tim-streams.com/api/live-upcoming' },
  { name: 'PitSport', url: 'https://pitsport.st/api/v1/home' },
  { name: 'ScoreZone', url: 'https://scorezone-live.scorezone.workers.dev/api/iptv/channels' },
  { name: 'SK Tech (app backend)', url: skTechEventsUrl, headers: { 'User-Agent': 'okhttp/4.12.0' } },
  { name: 'SK Tech (Sony LIV feed)', url: 'https://nonyliv.saqlainhaider8198.workers.dev/nony2.m3u' },
  { name: 'Vavoo', url: 'https://www.vypn.net/' },
  { name: 'MLBLive', url: 'https://mlblive.net/world-series-replays' },
  { name: 'SportsBite', url: 'https://sportsbite.org/' },
];

async function checkSources() {
  console.log('Checking streaming sources...\n');
  
  const results = await Promise.allSettled(sources.map(async (source) => {
    try {
      const url = typeof source.url === 'function' ? await source.url() : source.url;
      const response = await request(url, { method: 'GET', headers: source.headers, headersTimeout: 10000, bodyTimeout: 10000 });
      await response.body.text().catch(() => {});
      if (response.statusCode >= 400) {
        return { ...source, status: 'FAILED', error: `HTTP ${response.statusCode}` };
      }
      return { ...source, url, status: 'OK', statusCode: response.statusCode };
    } catch (error) {
      return { ...source, status: 'FAILED', error: error.message };
    }
  }));

  results.forEach(result => {
    if (result.status === 'fulfilled') {
      const res = result.value;
      const shown = typeof res.url === 'string' ? res.url : '(resolved at runtime)';
      if (res.status === 'OK') {
        console.log(`[✓] ${res.name.padEnd(16)} | RUNNING | ${shown}`);
      } else {
        console.log(`[✗] ${res.name.padEnd(16)} | DOWN    | ${res.error} | ${shown}`);
      }
    } else {
      console.log(`[✗] Failed to process ${result.reason}`);
    }
  });
  
  console.log('\nFinished checking all sources.');
}

checkSources();
