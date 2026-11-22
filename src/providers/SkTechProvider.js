const { request } = require('undici');
const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const { manifestProxyUrl } = require('../proxyUrl');

const DEFAULT_UA = BaseProvider.DEFAULT_UA;

/** Community M3U playlists of live FanCode / Sony LIV events, one #EXTINF per language and quality. */
const EVENT_FEEDS = [
  { label: 'FanCode', url: 'https://raw.githubusercontent.com/doctor-8trange/zyphx8/refs/heads/main/data/fancode.m3u' },
  { label: 'FanCode', url: 'https://jabra-fan2.saqlainhaider8198.workers.dev/playlist.m3u' },
  { label: 'Sony LIV', url: 'https://nonyliv.saqlainhaider8198.workers.dev/nony2.m3u' },
];

/** Only 720p and 1080p variants are offered; a feed row without a tag is a master playlist. */
const OFFERED_RESOLUTIONS = new Set(['720P', '1080P']);

/** A fixture is dropped this long after the feed first listed it. */
const MAX_LISTED_MS = 8 * 60 * 60 * 1000;

/** The feed workers answer browser TLS fingerprints (impit) with a Telegram HTML page, so plain undici is used. */
const FEED_TIMEOUT_MS = 6000;

/** Stale fixtures some feeds never remove. */
const GHOST_FIXTURE_RE = /namibia\s*(?:vs?\.?|@|-)\s*uganda/i;
const TEST_ENTRY_RE = /^test\b|^demo\b|^placeholder\b|^sample\b/i;
const TEST_URL_RE = /test_pic|streamtest|livetest|\/test\.m3u8|\/test\//i;

/**
 * Strips language prefixes, emoji, quality tags, date suffixes and trailing
 * language tags from a playlist title so the same fixture from different feeds
 * and languages collapses to one name.
 */
function cleanEventTitle(rawTitle, tvgName = '') {
  let title = (tvgName && /\bvs\b/i.test(tvgName)) ? tvgName : (rawTitle || tvgName || '');
  title = title.replace(/^[A-Za-z]{2,8}\s*\|\s*/, '');
  title = title.replace(/^\[[A-Za-z\s]+\]\s*/, '');
  title = title.replace(/^[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]\s*/u, '');
  title = title.replace(/^\[[^\]]+\]\s*/, '');
  title = title.replace(/\s*([[(]?(?:4K|UHD|FHD|HD|1080p?|720p?|540p?|480p?|360p?|240p?|144p?)[\])]?)\s*$/i, '');
  title = title.replace(/\s*-\s*(?:MD\s*\d+\s*-\s*)?\d{1,2}\s+[A-Za-z]+\s+\d{4}.*$/, '');
  title = title.replace(/\s*\[LIVE\].*$/i, '');
  title = title.replace(/\s*[|\-(]\s*(?:Spanish|English|Hindi|Bengali|Tamil|Telugu|Marathi|Kannada|Malayalam|Arabic)[^)]*\)?\s*$/i, '');
  title = title.replace(/\s+\d+\s*\([^)]+\)$/, '');
  return title.replace(/\s+Vs\s+/i, ' vs ').trim();
}

/**
 * Splits a playlist stream line of the form `url|Header=value&Header=value`
 * into the URL and its request headers.
 */
function parseDelimited(line) {
  const [rawUrl, ...rest] = String(line).split('|');
  const headers = {};
  const names = { 'user-agent': 'User-Agent', referer: 'Referer', origin: 'Origin', cookie: 'Cookie' };
  for (const part of rest) {
    for (const pair of part.split('&')) {
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const name = names[pair.slice(0, eq).trim().toLowerCase()];
      if (name) headers[name] = pair.slice(eq + 1).trim();
    }
  }
  return { url: rawUrl.trim(), headers };
}

/**
 * Parses an M3U playlist into event rows: { tvgId, group, logo, lang, rawTitle,
 * tvgName, url, headers }. Headers come from #EXTVLCOPT lines and the
 * pipe-delimited suffix of the URL.
 */
function parsePlaylist(text) {
  const rows = [];
  let meta = null;
  let opts = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      const comma = line.indexOf(',');
      meta = { rawTitle: comma >= 0 ? line.slice(comma + 1).trim() : '', tvgId: '', tvgName: '', logo: '', lang: '', group: '' };
      opts = {};
      const attrs = comma >= 0 ? line.slice(0, comma) : line;
      for (const m of attrs.matchAll(/\b(tvg-id|tvg-name|tvg-logo|tvg-language|group-title)="([^"]*)"/gi)) {
        const key = m[1].toLowerCase();
        if (key === 'tvg-id') meta.tvgId = m[2];
        else if (key === 'tvg-name') meta.tvgName = m[2];
        else if (key === 'tvg-logo') meta.logo = m[2];
        else if (key === 'tvg-language') meta.lang = m[2];
        else meta.group = m[2];
      }
    } else if (line.startsWith('#EXTVLCOPT:')) {
      const opt = line.slice(11).trim();
      const eq = opt.indexOf('=');
      if (eq < 0) continue;
      const key = opt.slice(0, eq);
      const val = opt.slice(eq + 1);
      if (/referrer/i.test(key)) opts.Referer = val;
      else if (/user-agent/i.test(key)) opts['User-Agent'] = val;
    } else if (line.startsWith('http') && meta) {
      const { url, headers } = parseDelimited(line);
      if (url) rows.push({ ...meta, url, headers: { ...opts, ...headers } });
      meta = null;
      opts = {};
    }
  }
  return rows;
}

/**
 * SK Tech event feeds: live FanCode and Sony LIV fixtures (cricket and other
 * sports) published as M3U playlists. Each fixture offers one HLS stream per
 * language and per 720p/1080p quality. The original SK Tech backend
 * (events.txt / categories.txt on dk01-64n.pages.dev) answers 404 and its
 * 24/7 channel list is gone, so only the playlists remain.
 */
class SkTechProvider extends BaseProvider {
  /**
   * @param {object} opts  provider cradle ({ circuitBreaker })
   */
  constructor(opts) {
    super(opts);
    this.name = 'SkTech';
    this.sourceName = 'sktech';
    this._firstSeen = new Map();

    this.fetchFeed = this.circuitBreaker.wrap(`${this.name}_fetchFeed`, async (url) => {
      const res = await request(url, {
        headers: { 'User-Agent': DEFAULT_UA },
        headersTimeout: FEED_TIMEOUT_MS,
        bodyTimeout: FEED_TIMEOUT_MS,
      });
      if (res.statusCode >= 400) {
        await res.body.text().catch(() => {});
        throw new Error(`HTTP ${res.statusCode}`);
      }
      return await res.body.text();
    });
  }

  /**
   * Folds playlist rows from one feed into `events` (keyed by category+title),
   * keeping one source per feed, language and offered resolution.
   */
  _collect(rows, feed, events) {
    const feedKey = feed.label.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const row of rows) {
      const title = cleanEventTitle(row.rawTitle, row.tvgName);
      if (!title || GHOST_FIXTURE_RE.test(title) || TEST_ENTRY_RE.test(title) || TEST_URL_RE.test(row.url)) continue;

      const tag = (row.rawTitle.match(/\b(1080p|720p|540p|480p|360p|240p|144p)\b/i) || [])[1];
      const resolution = tag ? tag.toUpperCase() : 'HD';
      if (tag && !OFFERED_RESOLUTIONS.has(resolution)) continue;

      const category = this.mapCategoryLabel(row.group || title);
      const key = `${category}:${title.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
      const lang = (row.lang || 'English').trim();
      const source = {
        source: this.sourceName,
        id: `${feedKey}_${row.tvgId || title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24)}_${resolution}_${lang.toLowerCase()}`,
        feed: feed.label,
        lang,
        resolution,
        streamUrl: row.url,
        headers: { 'User-Agent': DEFAULT_UA, ...row.headers },
      };

      let event = events.get(key);
      if (!event) {
        event = { id: `sktech_${feedKey}_${row.tvgId || events.size}`, title, category, poster: row.logo, league: row.group || `${feed.label} Live`, sources: [] };
        events.set(key, event);
      }
      if (!event.sources.some((s) => s.feed === feed.label && s.lang === lang && s.resolution === resolution)) {
        event.sources.push(source);
      }
    }
  }

  /**
   * Live events merged across the playlist feeds, one match per fixture.
   * @returns {Promise<MatchEntity[]>}
   */
  async getMatches() {
    const events = new Map();
    const feeds = await Promise.allSettled(EVENT_FEEDS.map(async (feed) => ({ feed, text: await this.fetchFeed.fire(feed.url) })));
    for (const result of feeds) {
      if (result.status === 'fulfilled') this._collect(parsePlaylist(result.value.text), result.value.feed, events);
    }

    const now = Date.now();
    const matches = [];
    for (const event of events.values()) {
      if (!this._firstSeen.has(event.id)) this._firstSeen.set(event.id, now);
      const first = this._firstSeen.get(event.id);
      if (now - first > MAX_LISTED_MS) continue;

      const parts = event.title.split(/\s+(?:vs?\.?|@)\s+/i);
      matches.push(new MatchEntity({
        id: event.id,
        title: event.title,
        category: event.category,
        date: String(first),
        status: 'live',
        league: event.league,
        thumbnail_url: event.poster,
        poster: event.poster,
        team1: parts.length === 2 ? { name: parts[0].trim() } : null,
        team2: parts.length === 2 ? { name: parts[1].trim() } : null,
        sources: event.sources,
      }));
    }
    const listed = new Set([...events.values()].map((e) => e.id));
    for (const id of this._firstSeen.keys()) {
      if (!listed.has(id)) this._firstSeen.delete(id);
    }
    return matches;
  }

  /**
   * The proxied HLS stream of one language/quality source.
   * @returns {Promise<StreamEntity[]>}
   */
  async resolveStream(sourceId, matchCategory, matchTitle, src = {}) {
    if (!src.streamUrl) return [];
    const referer = (src.headers && src.headers.Referer) || 'https://sktech.live/';
    const language = src.lang && src.lang.toLowerCase() !== 'english' ? ` - ${src.lang}` : '';
    const stream = new StreamEntity({
      name: this.name,
      title: `${matchTitle} (${src.feed} ${src.resolution}${language})`,
      url: manifestProxyUrl({ url: src.streamUrl, referer }),
      behaviorHints: { notWebReady: true },
      resolution: src.resolution === 'HD' ? 'HD' : src.resolution.toLowerCase(),
    });
    stream.language = src.lang;
    return [stream];
  }
}

module.exports = SkTechProvider;
module.exports.cleanEventTitle = cleanEventTitle;
module.exports.parsePlaylist = parsePlaylist;
