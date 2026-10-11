const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const { manifestProxyUrl } = require('../proxyUrl');

const ORIGIN = 'https://damitv.st';
const STREAMS_URL = `${ORIGIN}/papi/api/streams`;
/** The main feed omits the 24/7 category; /papi/matches/all carries it with a different item shape. */
const MATCHES_ALL_URL = `${ORIGIN}/papi/matches/all`;
const EXTRACT_URL_BASE = `${ORIGIN}/papi/extract-url/`;
const MANUAL_SOURCES_URL = `${ORIGIN}/data/manual-sources.json`;

/**
 * Rolling-window channels (NFL Network, Sky Sports Golf, ...) republish a
 * starts_at of "roughly now" on every poll: within +-90 s of the feed
 * `timestamp` across consecutive fetches, while real fixtures keep a fixed
 * kickoff. Anything that close to the server clock is an always-on channel.
 */
const ROLLING_WINDOW_TOLERANCE_S = 90;

/** How long after kickoff a feed row without a status word still counts as live. */
const LIVE_WINDOW_MS = 12 * 3600 * 1000;

function absolutePoster(poster) {
  if (!poster) return '';
  return poster.startsWith('//') ? `https:${poster}` : poster;
}

/**
 * damitv.st. The JSON feed lists fixtures with per-server embed URLs; a
 * stream is resolved by asking the extract-url API for the signed HLS/SD
 * manifests, then the site's manual-sources list, then a web player.
 */
class DamiTvProvider extends BaseProvider {
  constructor(opts) {
    super(opts);
    this.name = 'DamiTV';
    this.sourceName = 'damitv';
    this.apiUrl = STREAMS_URL;

    this.fetchData = this.circuitBreaker.wrap(`${this.name}_fetch`, async () => {
      const res = await this.proxyFetch(this.apiUrl, { timeoutMs: 15000 });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    });

    // Non-fatal: a failure here only costs the 24/7 rows, not the schedule.
    this.fetchAllMatches = this.circuitBreaker.wrap(`${this.name}_fetchAll`, async () => {
      const res = await this.proxyFetch(MATCHES_ALL_URL, { timeoutMs: 15000 });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    });
  }

  /**
   * The router matches /:type/:id as one path segment, so a "/" inside a
   * match id truncates the route. Collapse slashes for the catalog id; the
   * true id survives inside the source's embed URL, which resolveStream reads.
   */
  _sanitizeId(feedId) {
    return String(feedId).replace(/\//g, '_');
  }

  _isRollingChannel(item, feedTimestamp) {
    if (!item) return false;
    const awayName = item.teams && item.teams.away && item.teams.away.name;
    if (awayName && String(awayName).trim() !== '') return false;
    if (!item.starts_at || !feedTimestamp) return false;
    return Math.abs(item.starts_at - feedTimestamp) <= ROLLING_WINDOW_TOLERANCE_S;
  }

  /**
   * Source ids must be unique per catalog entry: the aggregator dedupes on
   * (id, source) and the feed's sources[].id is only a server label ("s1",
   * "sd"). ":" is reserved by the episode-id format.
   */
  _sourceId(feedItemId, label) {
    return `${this._sanitizeId(feedItemId)}_${String(label).replace(/[:/]/g, '_')}`;
  }

  /**
   * A source whose embed URL differs from another only by an sd=1 param hits
   * the same extract-url endpoint and mints the same HD+SD pair, so keep one
   * source per distinct `id` query param.
   */
  _dedupeSources(rawSources, primaryEmbedUrl) {
    const seenIds = new Set();
    const out = [];
    for (const st of rawSources) {
      let embedUrl = (st && st.embed) || primaryEmbedUrl || '';
      if (!embedUrl) continue;
      if (embedUrl.startsWith('/')) embedUrl = ORIGIN + embedUrl;

      let idParam = null;
      try {
        idParam = new URL(embedUrl).searchParams.get('id');
      } catch (_) { /* unusable embed url */ }
      if (idParam === null || seenIds.has(idParam)) continue;
      seenIds.add(idParam);

      out.push({
        source: this.sourceName,
        id: this._sourceId(idParam, (st && (st.id || st.name)) || 'Stream'),
        name: (st && st.name) || 'Stream',
        url: embedUrl,
      });
    }
    return out;
  }

  _channelMatch(id, title, poster, sources, logo = '') {
    return new MatchEntity({
      id: `dami_${this._sanitizeId(id)}`,
      title,
      category: 'networks',
      date: '0',
      popular: '1',
      status: '',
      league: 'Live TV',
      thumbnail_url: poster,
      poster,
      logo,
      sources,
    });
  }

  _fixtureMatches(data, seenIds) {
    const matches = [];
    const feedTimestamp = data.timestamp || 0;
    const now = Date.now();

    for (const group of data.streams) {
      for (const s of group.streams || []) {
        if (!s.id || !s.name) continue;

        const primaryEmbed = `${ORIGIN}/embed/?id=${encodeURIComponent(s.id)}`;
        const sources = this._dedupeSources(s.sources && s.sources.length ? s.sources : [{}], primaryEmbed);
        if (sources.length === 0) continue;

        const sanitized = this._sanitizeId(s.id);
        if (seenIds.has(sanitized)) continue;

        const poster = absolutePoster(s.poster);
        if (this._isRollingChannel(s, feedTimestamp)) {
          seenIds.add(sanitized);
          matches.push(this._channelMatch(s.id, s.name, poster, sources));
          continue;
        }

        if (s.status && s.status !== 'live' && s.status !== 'upcoming') continue;

        const dateMs = s.starts_at ? s.starts_at * 1000 : now;
        const isLive = s.status === 'live' || (!s.status && dateMs <= now && dateMs > now - LIVE_WINDOW_MS);
        const isUpcoming = s.status === 'upcoming' || (!s.status && dateMs > now);

        seenIds.add(sanitized);
        matches.push(new MatchEntity({
          id: `dami_${sanitized}`,
          title: s.name,
          category: this.normalizeCategory(group.category || 'other'),
          date: dateMs.toString(),
          status: isLive ? 'live' : (isUpcoming ? 'upcoming' : ''),
          popular: (isLive || (s.viewers || 0) > 1000) ? '1' : '0',
          sources,
          league: s.league || '',
          thumbnail_url: poster,
          poster,
          team1: s.teams && s.teams.home && s.teams.home.name ? { name: s.teams.home.name, logo: s.teams.home.badge || null } : null,
          team2: s.teams && s.teams.away && s.teams.away.name ? { name: s.teams.away.name, logo: s.teams.away.badge || null } : null,
        }));
      }
    }
    return matches;
  }

  _allChannelMatches(all, seenIds) {
    const matches = [];
    for (const item of all) {
      if (!item || !item.id || !item.title) continue;
      if (String(item.category || '') !== '24/7-streams' && !/^247-/.test(String(item.id))) continue;
      const sanitized = this._sanitizeId(item.id);
      if (seenIds.has(sanitized)) continue;

      const sources = [{
        source: this.sourceName,
        id: this._sourceId(item.id, 'ppv'),
        name: 'Server 1',
        url: `${ORIGIN}/embed/?id=${encodeURIComponent(item.id)}`,
      }];
      // Substreams are sibling channels (e.g. Willow 2), each a distinct id.
      for (const sub of Array.isArray(item.substreams) ? item.substreams : []) {
        if (!sub || !sub.id) continue;
        sources.push({
          source: this.sourceName,
          id: this._sourceId(sub.id, sub.name || 'sub'),
          name: sub.name || 'Server 2',
          url: sub.iframe || `${ORIGIN}/embed/?id=${encodeURIComponent(sub.id)}`,
        });
      }

      seenIds.add(sanitized);
      matches.push(this._channelMatch(
        item.id,
        item.title,
        absolutePoster(item.poster),
        sources,
        (item.teams && item.teams.home && item.teams.home.badge) || '',
      ));
    }
    return matches;
  }

  async getMatches() {
    const matches = [];
    const seenIds = new Set();

    try {
      const data = await this.fetchData.fire();
      if (data && data.success && Array.isArray(data.streams)) {
        matches.push(...this._fixtureMatches(data, seenIds));
      }
    } catch (error) {
      console.error(`[${this.name}] Error fetching matches:`, error.message);
    }

    try {
      const all = await this.fetchAllMatches.fire();
      if (Array.isArray(all)) matches.push(...this._allChannelMatches(all, seenIds));
    } catch (error) {
      console.warn(`[${this.name}] 24/7 channel fetch failed (non-fatal):`, error.message);
    }

    return matches;
  }

  async _extractUrls(matchId, embedUrl) {
    try {
      const res = await this.proxyFetch(`${EXTRACT_URL_BASE}${encodeURIComponent(matchId)}`, {
        headers: { 'Referer': embedUrl },
        timeoutMs: 8000,
      });
      if (res.ok) return await res.json();
    } catch (_) {
      console.warn(`[${this.name}] API extraction failed for ${matchId}, trying manual sources...`);
    }
    return null;
  }

  async _manualSourceUrls(matchId) {
    try {
      const res = await this.proxyFetch(`${MANUAL_SOURCES_URL}?t=${Date.now()}`, { timeoutMs: 5000 });
      if (!res.ok) return [];
      const data = await res.json();
      const list = data && Array.isArray(data[matchId]) ? data[matchId] : [];
      return list.map((st) => st && st.url).filter((u) => u && u.includes('.m3u8'));
    } catch (e) {
      console.warn(`[${this.name}] Manual sources fetch failed:`, e.message);
      return [];
    }
  }

  async resolveStream(sourceId, matchCategory, matchTitle, src = {}) {
    const embedUrl = src.url || src.embedUrl || sourceId;
    if (!embedUrl || !String(embedUrl).startsWith('http')) return [];

    let matchId;
    try {
      matchId = new URL(embedUrl).searchParams.get('id');
    } catch (err) {
      console.warn(`[${this.name}] resolveStream error for ${embedUrl}:`, err.message);
      return [];
    }
    if (!matchId) return [];

    const proxied = (upstream, resolution) => new StreamEntity({
      name: this.name,
      title: matchTitle,
      url: manifestProxyUrl({ url: upstream, referer: `${ORIGIN}/`, origin: ORIGIN }),
      behaviorHints: { notWebReady: true },
      resolution,
    });

    const streams = [];
    const extracted = await this._extractUrls(matchId, embedUrl);
    if (extracted && extracted.success) {
      if (extracted.hlsUrl) streams.push(proxied(extracted.hlsUrl, 'HD'));
      if (extracted.sdUrl) streams.push(proxied(extracted.sdUrl, 'SD'));
    }

    if (streams.length === 0) {
      for (const url of await this._manualSourceUrls(matchId)) streams.push(proxied(url, 'HD'));
    }

    if (streams.length === 0) {
      streams.push(new StreamEntity({
        name: this.name,
        title: matchTitle,
        externalUrl: `/watch?url=${encodeURIComponent(embedUrl)}&title=${encodeURIComponent(matchTitle || 'Live Event')}`,
      }));
    }
    return streams;
  }
}

module.exports = DamiTvProvider;
