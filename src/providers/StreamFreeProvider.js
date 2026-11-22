const BaseProvider = require('./BaseProvider');
const { DEFAULT_UA } = BaseProvider;
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const { manifestProxyUrl } = require('../proxyUrl');

/** Reads the `_0x` variant -> {_t,_ta,_e,_s,_sa} token map out of a StreamFree embed page. */
function parseEmbedTokens(html) {
  if (!html) return null;
  const match = html.match(/const\s+_0x\s*=\s*(\{.*?\});/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch (_) {
    return null;
  }
}

/** Builds the signed query string from one embed token entry. */
function signedQuery(t) {
  return new URLSearchParams({ _t: t._t, _ta: t._ta, _e: t._e, _s: t._s, _sa: t._sa }).toString();
}

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
    this.sourcesFetcher = this.circuitBreaker.wrap(
      this.name + '_fetchSources',
      async (url) => {
        const res = await this.proxyFetch(url, { headers: { 'User-Agent': DEFAULT_UA } });
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        return await res.json();
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

  /**
   * Re-signs an expired StreamFree manifest URL. The path stays the same; the
   * token set is re-read from the embed page entry keyed by the variant name in
   * the dead URL.
   */
  async refreshSignedUrl(embedUrl, deadUrl) {
    const tokens = parseEmbedTokens(await this.embedFetcher.fire(embedUrl));
    if (!tokens) return null;

    let parsed;
    try {
      parsed = new URL(deadUrl);
    } catch (_) {
      return null;
    }

    const variant = parsed.pathname.split('/').filter(Boolean).slice(-2)[0] || '';
    const t = tokens[variant];
    if (!t || !t._t) return null;
    parsed.search = signedQuery(t);
    return { m3u8: parsed.toString(), referer: embedUrl };
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

  async resolveStream(sourceId) {
    try {
      let sources = [];
      try {
        const data = await this.sourcesFetcher.fire(`https://streamfree.top/api/v1/sources/${sourceId}`);
        sources = ((data && data.sources) || []).filter((s) => s && s.live && s.url);
      } catch (e) {
        console.warn(`[StreamFree] sources fetch failed for ${sourceId}:`, e.message);
      }
      if (sources.length === 0) return [];

      let streamKeyData = null;
      try {
        streamKeyData = await this.streamKeyFetcher.fire(`https://streamfree.top/get-stream-key/${sourceId}`);
      } catch (e) {
        console.warn(`[StreamFree] get-stream-key failed for ${sourceId}:`, e.message);
      }

      const streams = [];
      for (const src of sources) {
        try {
          const embedUrl = src.url;
          const variant = new URL(embedUrl).pathname.split('/').filter(Boolean).pop();
          const t = parseEmbedTokens(await this.embedFetcher.fire(embedUrl))?.[variant];
          if (!t || !t._t) continue;

          let targetUrl;
          let isOwnSigned = false;
          if (streamKeyData && streamKeyData.is_external && streamKeyData.external_url) {
            targetUrl = streamKeyData.external_url;
          } else {
            const server = (streamKeyData && streamKeyData.server_name) || 'origin';
            const prefix = server === 'externalcdn' ? 'live-externalcdn' : server !== 'origin' ? 'live-cdn' : 'live';
            targetUrl = `${new URL(embedUrl).origin}/${prefix}/${variant}/index.m3u8?${signedQuery(t)}`;
            isOwnSigned = true;
          }

          const quality = src.quality || variant;
          streams.push(new StreamEntity({
            name: 'StreamFree',
            title: `StreamFree (${quality})`,
            url: manifestProxyUrl({
              url: targetUrl,
              referer: embedUrl,
              origin: new URL(embedUrl).origin,
              renew: isOwnSigned ? 'streamfree' : null,
              embed: embedUrl,
            }),
            behaviorHints: { notWebReady: true },
            resolution: quality
          }));
        } catch (srcErr) {
          console.warn(`[StreamFree] Failed source ${src.url}:`, srcErr.message);
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
