const BaseProvider = require('./BaseProvider');
const { DEFAULT_UA } = BaseProvider;
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');

class StreamFreeProvider extends BaseProvider {
  constructor(opts) {
    super(opts);
    this.name = 'StreamFree';
    this.apiUrl = 'https://streamfree.top/streams';
    // Wrap the fetch with our circuit breaker
    this.fetchData = this.circuitBreaker.wrap(
      this.name + '_fetchMain',
      async () => {
        const headers = { 'User-Agent': DEFAULT_UA };
        // proxyFetch: undici done right (statusCode) + Impit fallback + redirect following
        const res = await this.proxyFetch(this.apiUrl, { headers });
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        return await res.json();
      }
    );
    this.embedFetcher = this.circuitBreaker.wrap(
      this.name + '_fetchEmbed',
      async (url) => {
        const headers = { 'User-Agent': DEFAULT_UA };
        // NOTE: deliberately no Referer - StreamFree blocks embed requests that carry one
        const res = await this.proxyFetch(url, { headers });
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        return await res.text();
      }
    );
    this.streamKeyFetcher = this.circuitBreaker.wrap(
      this.name + '_fetchStreamKey',
      async (url) => {
        const headers = { 'User-Agent': DEFAULT_UA };
        const res = await this.proxyFetch(url, { headers });
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        return await res.json();
      }
    );
  }

  normalizeCategory(cat) {
    let norm = String(cat).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (norm === 'football') return 'american_football';
    return super.normalizeCategory(cat);
  }

  async getMatches() {
    const matches = [];
    try {
      const data = await this.fetchData.fire();
      if (!data || !data.streams) return [];

      Object.entries(data.streams).forEach(([category, streams]) => {
        if (Array.isArray(streams)) {
          streams.forEach(s => {
            const id = s.stream_key || s.id;
            if (!id) return;
            matches.push(new MatchEntity({
              id: 'sf_' + id,
              title: s.name,
              category: this.normalizeCategory(category),
              date: s.match_timestamp ? (s.match_timestamp * 1000).toString() : null,
              popular: (s.viewers || 0) > 100 ? '1' : '0',
              league: s.league,
              team1: s.team1,
              team2: s.team2,
              thumbnail_url: s.thumbnail_url,
              sources: [{ source: 'streamfree', id: id, original_category: category }]
            }));
          });
        }
      });
    } catch (error) {
      console.error(`[${this.name}] Error fetching matches:`, error.message);
    }
    return matches;
  }

  async resolveStream(sourceId, matchCategory, matchTitle) {
    try {
      const { safeFetch } = require('../impitClient');
      const { BASE_URL } = require('../config');
      const resScore = (q) => { const m = String(q).match(/(\d+)/); return m ? parseInt(m[1], 10) : 0; };

      // ── Step 1: Find all available sources from stream-status ────────────────
      // Sources keyed "1".."5". Source 1 = main embed (suffix ''), 2..5 = backup (suffix '2'..'5').
      let availableSources = [];
      try {
        const statusRes = await safeFetch(`https://streamfree.top/api/stream-status/${sourceId}`, {
          headers: { 'User-Agent': DEFAULT_UA },
          timeoutMs: 8000
        });
        if (statusRes.status === 200) {
          const statusData = await statusRes.json();
          const sources = statusData.sources || {};
          for (const [num, s] of Object.entries(sources)) {
            if (s && s.available) {
              availableSources.push({
                srcNum: num,
                suffix: num === '1' ? '' : num,
                qualities: s.qualities || {}
              });
            }
          }
        }
      } catch (e) {
        console.warn(`[StreamFree] stream-status fetch failed for ${sourceId}:`, e.message);
      }

      // If stream-status gave us nothing, fall back to source 1 only
      if (availableSources.length === 0) {
        availableSources = [{ srcNum: '1', suffix: '', qualities: {} }];
      }

      // ── Step 2: Fetch stream-key once (same endpoint for all sources) ─────────
      let streamKeyData = null;
      try {
        streamKeyData = await this.streamKeyFetcher.fire(`https://streamfree.top/get-stream-key/${sourceId}`);
      } catch (e) {
        console.warn(`[StreamFree] get-stream-key failed for ${sourceId}:`, e.message);
      }

      // ── Step 3: For each available source, fetch its embed + build stream ────
      const streams = [];
      for (const src of availableSources) {
        try {
          // Each source has its own embed page with its own _0x token set
          const embedUrl = `https://streamfree.top/embed/${matchCategory}/${sourceId}${src.suffix}`;
          const html = await this.embedFetcher.fire(embedUrl);
          if (!html) continue;

          const tokenMatch = html.match(/const\s+_0x\s*=\s*(\{.*?\});/);
          if (!tokenMatch) {
            console.warn(`[StreamFree] No _0x tokens in embed for ${sourceId}${src.suffix}`);
            continue;
          }
          const tokens = JSON.parse(tokenMatch[1]);

          // Pick best quality: prefer stream-status confirmed ones, fallback to all sorted by res
          const tokenKeys = Object.keys(tokens).filter(k => tokens[k] && tokens[k]._t);
          const confirmed = tokenKeys.filter(q => src.qualities[q]);
          const ordered = (confirmed.length ? confirmed : tokenKeys).sort((a, b) => resScore(b) - resScore(a));
          const bestQuality = ordered[0] || null;
          const t = bestQuality ? tokens[bestQuality] : null;
          if (!bestQuality || !t) continue;

          // Build the .m3u8 URL — path uses key + quality + source suffix
          let targetUrl = '';
          if (streamKeyData && streamKeyData.is_external && streamKeyData.external_url) {
            targetUrl = streamKeyData.external_url;
          } else {
            const serverName = (streamKeyData && streamKeyData.server_name) ? streamKeyData.server_name : 'origin';
            const pathSegment = `${sourceId}${bestQuality}${src.suffix}`;
            const hlsPath = serverName !== 'origin'
              ? `https://streamfree.top/live-cdn/${pathSegment}/index.m3u8`
              : `https://streamfree.top/live-origin/${pathSegment}/index.m3u8`;
            targetUrl = `${hlsPath}?_t=${t._t}&_e=${t._e}&_n=${t._n}`;
          }

          const proxyUrl = `${BASE_URL}/api/manifest?url=${encodeURIComponent(targetUrl)}&referer=${encodeURIComponent(embedUrl)}&origin=https://streamfree.top`;
          const label = src.suffix ? `StreamFree S${src.srcNum} (${bestQuality})` : `StreamFree (${bestQuality})`;

          streams.push(new StreamEntity({
            name: 'StreamFree',
            title: label,
            url: proxyUrl,
            behaviorHints: { notWebReady: true },
            resolution: bestQuality
          }));
        } catch (srcErr) {
          console.warn(`[StreamFree] Failed source ${src.srcNum} for ${sourceId}:`, srcErr.message);
        }
      }

      return streams;
    } catch (error) {
      console.error(`[${this.name}] resolveStream failed for ${sourceId}:`, error.message);
      return [];
    }
  }
}

module.exports = StreamFreeProvider;
