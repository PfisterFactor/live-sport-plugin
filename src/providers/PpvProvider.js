const BaseProvider = require('./BaseProvider');
const { DEFAULT_UA } = BaseProvider;
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');

/**
 * ppv.st / sportsbite.org. Both sites are frontends over the same public
 * api.ppv.st catalog; their embeds live on embedindia.st, which the
 * EmbedIndiaProvider already resolves via the vendored WASM runner.
 */
class PpvProvider extends BaseProvider {
  constructor(opts) {
    super(opts);
    this.name = 'PPV';
    this.embedIndiaProvider = opts.embedIndiaProvider;
    this.apiUrl = 'https://api.ppv.st/api/streams';
    // Events more than this far past their end time are dropped from the catalog.
    this.endedGraceMs = 2 * 60 * 60 * 1000;

    this.fetchStreams = this.circuitBreaker.wrap(`${this.name}_fetchStreams`, async () => {
      const res = await this.proxyFetch(this.apiUrl, {
        headers: { 'User-Agent': DEFAULT_UA, 'Accept': 'application/json' },
        timeoutMs: 15000,
      });
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      return await res.json();
    });
  }

  _flatten(data) {
    const out = [];
    for (const group of data?.streams || []) {
      for (const item of group?.streams || []) {
        if (!item || !item.id || !item.name) continue;
        out.push(item);
      }
    }
    return out;
  }

  async getMatches() {
    const matches = [];
    try {
      const data = await this.fetchStreams.fire();
      const now = Date.now();

      for (const item of this._flatten(data)) {
        const startsMs = Number(item.starts_at) > 0 ? Number(item.starts_at) * 1000 : 0;
        const endsMs = Number(item.ends_at) > 0 ? Number(item.ends_at) * 1000 : 0;
        const isChannel = !!item.always_live;

        if (!isChannel && endsMs > 0 && endsMs + this.endedGraceMs < now) continue;
        const status = isChannel ? '' : (startsMs > 0 && startsMs > now ? 'upcoming' : 'live');

        matches.push(new MatchEntity({
          id: `ppv_${item.id}`,
          title: item.name,
          category: isChannel ? 'networks' : this.mapCategoryLabel(item.category_name || item.tag),
          status,
          date: isChannel ? '' : (startsMs ? String(startsMs) : ''),
          popular: isChannel || Number(item.viewers) > 100 ? '1' : '0',
          poster: item.poster || '',
          league: item.tag || '',
          sources: [{ source: 'ppv', id: String(item.id), uriName: item.uri_name, iframe: item.iframe }],
        }));
      }
    } catch (err) {
      console.error(`[${this.name}] Failed to get matches:`, err.message);
    }
    return matches;
  }

  async resolveStream(sourceId, matchCategory, matchTitle, src = {}) {
    const streams = [];
    try {
      const data = await this.fetchStreams.fire();
      const item = this._flatten(data).find(s => String(s.id) === String(sourceId));
      if (!item) return streams;

      const embeds = [];
      if (item.iframe) embeds.push({ url: item.iframe, label: item.source_tag || item.name });
      for (const sub of item.substreams || []) {
        if (sub && sub.iframe) embeds.push({ url: sub.iframe, label: sub.source_tag || sub.name || 'Alt' });
      }

      for (const embed of embeds) {
        if (this.embedIndiaProvider) {
          const resolved = await this.embedIndiaProvider.resolveStream(
            embed.url,
            matchCategory,
            embed.label === item.name ? `${matchTitle}` : `${matchTitle} (${embed.label})`,
            { embedUrl: embed.url }
          );
          if (Array.isArray(resolved)) streams.push(...resolved);
        } else {
          streams.push(new StreamEntity({
            name: this.name,
            title: `${matchTitle} (${embed.label}) (Web Player)`,
            externalUrl: `https://ppv.st/live/${encodeURIComponent(item.uri_name || '')}`,
          }));
        }
      }
    } catch (err) {
      console.error(`[${this.name}] resolveStream failed for ${sourceId}:`, err.message);
    }
    return streams;
  }
}

module.exports = PpvProvider;
