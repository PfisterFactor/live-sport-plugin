const BaseProvider = require('./BaseProvider');
const { DEFAULT_UA } = BaseProvider;
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const { runProviderScript } = require('./runner');
const path = require('path');

/**
 * streamcorner.st. The site's SPA loads its catalog from a pool of
 * Cloudflare Worker endpoints that speak an obfuscated request/response
 * codec; the codec ships in the site's own provider-data service worker,
 * vendored here as streamcorner_worker.js and executed out-of-process.
 */
class StreamCornerProvider extends BaseProvider {
  constructor(opts) {
    super(opts);
    this.name = 'StreamCorner';
    this.refererOrigin = 'https://streamcorner.st';
    this.listEndpoints = ['alpha', 'beta', 'extra003', 'extra004', 'skygo'];

    this.fetchData = this.circuitBreaker.wrap(`${this.name}_fetchData`, async (providerId, id) => {
      const hosts = StreamCornerProvider.WORKER_HOSTS.slice();
      for (let i = hosts.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [hosts[i], hosts[j]] = [hosts[j], hosts[i]];
      }
      const query = id ? `?p=${providerId}&id=${encodeURIComponent(id)}` : `?p=${providerId}`;
      const urls = hosts.slice(0, 5).map(h => `https://${h}/corner${query}`);

      const scriptPath = path.join(__dirname, 'run_streamcorner_native.js');
      const stdout = await runProviderScript(scriptPath, [providerId, JSON.stringify(urls)]);
      const marker = stdout.indexOf('SCDATA:');
      const end = stdout.indexOf(':SCEND', marker);
      if (marker < 0 || end < 0) throw new Error('worker produced no data');
      return JSON.parse(stdout.slice(marker + 7, end));
    });
  }

  async getMatches() {
    const matches = [];
    try {
      const results = await Promise.allSettled(
        this.listEndpoints.map(p => this.fetchData.fire(p))
      );

      for (const result of results) {
        if (result.status !== 'fulfilled' || !Array.isArray(result.value)) continue;
        const providerId = this.listEndpoints[results.indexOf(result)];

        for (const ev of result.value) {
          if (!ev || !ev.stream_id || !ev.event_name) continue;
          const startsMs = Number(ev.timestamp) > 0 ? Number(ev.timestamp) * 1000 : 0;

          matches.push(new MatchEntity({
            id: `sc_${providerId}_${ev.stream_id}`,
            title: ev.event_name,
            category: this.mapCategoryLabel(ev.category),
            status: startsMs && startsMs > Date.now() ? 'upcoming' : 'live',
            date: startsMs ? String(startsMs) : '',
            popular: '0',
            poster: ev.poster || '',
            league: ev.league || ev.category,
            team1: ev.home_team ? { name: ev.home_team, logo: ev.home_team_logo || null } : null,
            team2: ev.away_team ? { name: ev.away_team, logo: ev.away_team_logo || null } : null,
            thumbnail_url: ev.home_team_logo || ev.away_team_logo || '',
            sources: [{ source: 'streamcorner', id: `${providerId}/${ev.stream_id}` }],
          }));
        }
      }
    } catch (err) {
      console.error(`[${this.name}] Failed to get matches:`, err.message);
    }
    return matches;
  }

  async resolveStream(sourceId, matchCategory, matchTitle) {
    const streams = [];
    try {
      const slash = String(sourceId).indexOf('/');
      const providerId = slash > 0 ? String(sourceId).slice(0, slash) : 'alpha';
      const streamId = slash > 0 ? String(sourceId).slice(slash + 1) : String(sourceId);

      const ev = await this.fetchData.fire(providerId, streamId);
      const sources = (ev && ev.streams) || [];

      for (const s of sources) {
        if (!s || !s.stream_url) continue;
        // Upstream serves CENC-encrypted DASH manifests that Stremio cannot
        // play; only HLS manifests are surfaced as direct streams.
        if (!/\.m3u8/i.test(s.stream_url)) continue;
        streams.push(new StreamEntity({
          name: this.name,
          title: s.source_name ? `${matchTitle} (${s.source_name})` : matchTitle,
          url: s.stream_url,
          behaviorHints: {
            notWebReady: true,
            proxyHeaders: {
              request: {
                'Origin': this.refererOrigin,
                'Referer': `${this.refererOrigin}/`,
                'User-Agent': DEFAULT_UA,
              },
            },
          },
          resolution: 'HD',
        }));
      }

      if (streams.length === 0 && sources.some(s => s && s.stream_url)) {
        streams.push(new StreamEntity({
          name: this.name,
          title: `${matchTitle} (Web Player)`,
          externalUrl: `${this.refererOrigin}/stream/${providerId}/${streamId}`,
        }));
      }
    } catch (err) {
      console.error(`[${this.name}] resolveStream failed for ${sourceId}:`, err.message);
    }
    return streams;
  }
}

StreamCornerProvider.WORKER_HOSTS = [
  'data.gigav.workers.dev',
  'data.yedmzoa.workers.dev',
  'data.ngagzipx.workers.dev',
  'data.miopks.workers.dev',
  'data.jccldjshj8sw.workers.dev',
  'data.l0o1afmju0.workers.dev',
  'data.nibflolsi9.workers.dev',
  'data.5j181.workers.dev',
  'data.rim1043.workers.dev',
  'data.kuig2.workers.dev',
  'data.senbon001.workers.dev',
  'data.senbon001-2.workers.dev',
  'data.senbon002.workers.dev',
  'data.senbon003.workers.dev',
  'data.kageyoshi001.workers.dev',
  'data.silentbyte125.workers.dev',
  'data.stealthwolf798-69b.workers.dev',
  'data.redjoy256.workers.dev',
  'data.anonfox144.workers.dev',
  'data.cripw4lk000.workers.dev',
  'data.phamviet444.workers.dev',
  'data.kanghaerin444.workers.dev',
  'data.minjikim444.workers.dev',
  'data.leehyein444.workers.dev',
  'data.daniellemarsh444.workers.dev',
];

module.exports = StreamCornerProvider;
