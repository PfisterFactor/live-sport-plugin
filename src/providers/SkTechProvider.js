const crypto = require('crypto');
const { request } = require('undici');
const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const { manifestProxyUrl, dashHlsUrl } = require('../proxyUrl');
const remoteConfig = require('../data/sktech_remote_config.json');
const { decryptPrimary } = require('../services/SkTechCrypto');
const { eventTiming, clearKeyDashStream, embedIndiaUrl, embedIndiaStreams } = require('../services/AppFeed');

/** DASH manifests; without a ClearKey they cannot be played, so the row is skipped. */
const DASH_RE = /\.mpd(\?|$)/i;

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

/** The app reads its backend host from Firebase Remote Config; it is re-read this often. */
const API_HOST_TTL_MS = 3 * 60 * 60 * 1000;
const API_HOST_FALLBACK_TTL_MS = 5 * 60 * 1000;
const BACKEND_TIMEOUT_MS = 8000;
const APP_UA = 'okhttp/4.12.0';
const APP_REFERER = 'https://sktech.live/';

/** Instance id the Remote Config API wants; any 22 characters will do. */
const APP_INSTANCE_ID = crypto.randomBytes(16).toString('base64url').slice(0, 22);

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
 * tvgName, url, headers, clearKey }. Headers come from #EXTVLCOPT lines and the
 * pipe-delimited suffix of the URL; `clearKey` ({kid, key} or null) from a
 * #KODIPROP license_key line ("<kid>:<key>").
 */
function parsePlaylist(text) {
  const rows = [];
  let meta = null;
  let opts = {};
  let clearKey = null;
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
    } else if (/^#KODIPROP:inputstream\.adaptive\.license_key=/i.test(line)) {
      const [kid, key] = line.slice(line.indexOf('=') + 1).trim().split(':');
      clearKey = key ? { kid: kid.trim(), key: key.trim() } : null;
    } else if (line.startsWith('http') && meta) {
      const { url, headers } = parseDelimited(line);
      if (url) rows.push({ ...meta, url, headers: { ...opts, ...headers }, clearKey });
      meta = null;
      opts = {};
      clearKey = null;
    }
  }
  return rows;
}

/**
 * Reads the app's Firebase Remote Config entries (`api_url`, ...).
 * @returns {Promise<Object<string, string>>}
 * @throws {Error} on a non-200 answer or an unparsable body
 */
async function fetchRemoteConfigEntries() {
  const { projectNumber, apiKey, appId, packageName } = remoteConfig;
  const res = await request(
    `https://firebaseremoteconfig.googleapis.com/v1/projects/${projectNumber}/namespaces/firebase:fetch?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'X-Android-Package': packageName, 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId, appInstanceId: APP_INSTANCE_ID, sdkVersion: '22.0.0', packageName }),
      headersTimeout: BACKEND_TIMEOUT_MS,
      bodyTimeout: BACKEND_TIMEOUT_MS,
    }
  );
  const text = await res.body.text();
  if (res.statusCode !== 200) throw new Error(`Remote Config HTTP ${res.statusCode}`);
  return (JSON.parse(text).entries) || {};
}

/**
 * Unpacks a Clappr player page that hides its source in `[...].join(glue)`.
 * @param {string} html
 * @returns {string|null} the stream URL
 */
function extractClapprUrl(html) {
  const player = String(html).match(/player\.load\(\{[^}]*source:\s*([a-zA-Z0-9_]+)\(\)/i);
  if (!player) return null;
  const fn = String(html).match(new RegExp(`function\\s+${player[1]}\\s*\\(\\)\\s*\\{([\\s\\S]*?)\\}`, 'i'));
  const joined = fn && fn[1].match(/\[([\s\S]*?)\]\.join\(['"](.*?)['"]\)/);
  if (!joined) return null;
  const parts = joined[1].split(/["'],\s*["']/).map((p) => p.replace(/^["']|["']$/g, '').replace(/\\\//g, '/'));
  const url = parts.join(joined[2]).trim();
  return /^https?:\/\//.test(url) ? url : null;
}

/**
 * SK Tech event feeds: live FanCode and Sony LIV fixtures (cricket and other
 * sports) published as M3U playlists. Each fixture offers one HLS stream per
 * language and per 720p/1080p quality. The SK Tech app's own backend adds the
 * rest: its Firebase Remote Config names the host serving the encrypted
 * events.txt, whose events link to pro/*.txt lists of channels (direct HLS,
 * tokenApi embeds and ClearKey DASH through /api/dash).
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
    this.embedIndiaProvider = opts.embedIndiaProvider;
    this._apiHost = null;

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

    this.fetchRemoteConfig = this.circuitBreaker.wrap(`${this.name}_fetchRemoteConfig`, fetchRemoteConfigEntries);

    this.fetchBackend = this.circuitBreaker.wrap(`${this.name}_fetchBackend`, async (url) => {
      const res = await request(url, {
        headers: { 'User-Agent': APP_UA },
        headersTimeout: BACKEND_TIMEOUT_MS,
        bodyTimeout: BACKEND_TIMEOUT_MS,
      });
      const text = await res.body.text();
      if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
      return text;
    });
  }

  /**
   * Backend host (with trailing slash) from Remote Config, cached for hours;
   * the configured fallback host when Remote Config cannot be read.
   * @returns {Promise<string>}
   */
  async getApiHost() {
    const now = Date.now();
    if (this._apiHost && now < this._apiHost.expiresAt) return this._apiHost.url;
    let url = '';
    try {
      const entries = await this.fetchRemoteConfig.fire();
      url = /^https?:\/\//.test(entries.api_url) ? entries.api_url : '';
    } catch (err) {
      console.warn(`[${this.name}] Remote Config failed: ${err.message}`);
    }
    const resolved = url || remoteConfig.fallbackApiHost;
    this._apiHost = { url: resolved.endsWith('/') ? resolved : `${resolved}/`, expiresAt: now + (url ? API_HOST_TTL_MS : API_HOST_FALLBACK_TTL_MS) };
    return this._apiHost.url;
  }

  /**
   * Fetches and decrypts one backend file (events.txt, pro/*.txt) as JSON.
   * @param {string} path  relative to the backend host
   * @returns {Promise<*>}
   */
  async _backendJson(path) {
    return JSON.parse(decryptPrimary(await this.fetchBackend.fire(`${await this.getApiHost()}${path}`)));
  }

  /**
   * Folds the app backend's events.txt rows into `events`, sharing an event with
   * a playlist feed when category and title agree. One source per channel.
   * @param {object[]} rows  decoded `{event: <json>}` rows
   * @param {number} now
   * @param {Map<string, object>} events
   */
  _collectBackend(rows, now, events) {
    for (const row of rows) {
      let ev;
      try { ev = typeof row.event === 'string' ? JSON.parse(row.event) : row.event; } catch (_) { continue; }
      if (!ev || ev.visible === false || !ev.links) continue;

      const teamA = String(ev.teamAName || '').trim();
      const teamB = String(ev.teamBName || '').trim();
      const eventName = String(ev.eventName || '').trim();
      const title = teamA && teamB ? `${teamA} vs ${teamB}` : (eventName || teamA);
      if (!title || GHOST_FIXTURE_RE.test(title) || TEST_ENTRY_RE.test(title) || TEST_URL_RE.test(ev.links)) continue;

      const timing = eventTiming(ev, now);
      if (timing.finished) continue;

      const rawCategory = String(ev.category || '').trim();
      const mapped = this.mapCategoryLabel(rawCategory);
      const category = mapped === 'other' ? this.mapCategoryLabel(title) : mapped;
      const key = `${category}:${title.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
      const names = Array.isArray(ev.link_names) && ev.link_names.length ? ev.link_names : [''];

      let event = events.get(key);
      if (!event) {
        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        event = { id: `sktech_app_${slug}`, title, category, poster: ev.eventLogo || ev.teamAFlag || '', league: eventName || rawCategory, sources: [] };
        events.set(key, event);
      }
      event.startMs = timing.startMs;
      event.status = timing.status;
      if (teamA && teamB) event.teams = [{ name: teamA, logo: ev.teamAFlag || null }, { name: teamB, logo: ev.teamBFlag || null }];
      names.forEach((name, idx) => {
        const id = `${ev.links}#${idx}`;
        if (event.sources.some((s) => s.id === id)) return;
        event.sources.push({ source: this.sourceName, id, channelName: String(name).trim() || 'HD', linksPath: ev.links, streamIndex: idx });
      });
    }
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
      if (DASH_RE.test(row.url) && !row.clearKey) continue;

      const tag = (row.rawTitle.match(/\b(1080p|720p|540p|480p|360p|240p|144p)\b/i) || [])[1];
      const resolution = tag ? tag.toUpperCase() : 'HD';
      if (tag && !OFFERED_RESOLUTIONS.has(resolution)) continue;

      const category = this.mapCategoryLabel(row.group || title);
      const key = `${category}:${title.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
      const lang = (row.lang || 'English').trim();
      const source = {
        source: this.sourceName,
        id: `${feedKey}_${row.tvgId || title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24)}_${resolution}_${lang.toLowerCase()}${row.clearKey ? '_dash' : ''}`,
        feed: feed.label,
        lang,
        resolution,
        streamUrl: row.url,
        headers: { 'User-Agent': DEFAULT_UA, ...row.headers },
        clearKey: row.clearKey || undefined,
      };

      let event = events.get(key);
      if (!event) {
        event = { id: `sktech_${feedKey}_${row.tvgId || events.size}`, title, category, poster: row.logo, league: row.group || `${feed.label} Live`, sources: [] };
        events.set(key, event);
      }
      if (!event.sources.some((s) => s.feed === feed.label && s.lang === lang && s.resolution === resolution && Boolean(s.clearKey) === Boolean(source.clearKey))) {
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
    try {
      this._collectBackend(await this._backendJson('events.txt'), now, events);
    } catch (err) {
      console.warn(`[${this.name}] App backend events failed: ${err.message}`);
    }

    const matches = [];
    for (const event of events.values()) {
      if (!this._firstSeen.has(event.id)) this._firstSeen.set(event.id, now);
      const first = this._firstSeen.get(event.id);
      if (!event.startMs && now - first > MAX_LISTED_MS) continue;

      const parts = event.title.split(/\s+(?:vs?\.?|@)\s+/i);
      const teams = event.teams || (parts.length === 2 ? [{ name: parts[0].trim() }, { name: parts[1].trim() }] : [null, null]);
      matches.push(new MatchEntity({
        id: event.id,
        title: event.title,
        category: event.category,
        date: String(event.startMs || first),
        status: event.status || 'live',
        league: event.league,
        thumbnail_url: event.poster,
        poster: event.poster,
        team1: teams[0],
        team2: teams[1],
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
   * The proxied HLS stream of one language/quality source; a ClearKey DASH
   * source plays through /api/dash.
   * @returns {Promise<StreamEntity[]>}
   */
  async resolveStream(sourceId, matchCategory, matchTitle, src = {}) {
    if (src.linksPath) return this._resolveBackendStream(matchTitle, src);
    if (!src.streamUrl) return [];
    const referer = (src.headers && src.headers.Referer) || 'https://sktech.live/';
    const url = src.clearKey
      ? dashHlsUrl({ mpdUrl: src.streamUrl, key: src.clearKey.key, kid: src.clearKey.kid, headers: src.headers })
      : manifestProxyUrl({ url: src.streamUrl, referer });
    if (!url) return [];
    const language = src.lang && src.lang.toLowerCase() !== 'english' ? ` - ${src.lang}` : '';
    const stream = new StreamEntity({
      name: this.name,
      title: `${matchTitle} (${src.feed} ${src.resolution}${language})`,
      url,
      behaviorHints: { notWebReady: true },
      resolution: src.resolution === 'HD' ? 'HD' : src.resolution.toLowerCase(),
    });
    stream.language = src.lang;
    return [stream];
  }

  /**
   * Resolves one channel of an app-backend event: fetches its pro/*.txt list and
   * turns the selected row into a stream.
   * @returns {Promise<StreamEntity[]>}
   */
  async _resolveBackendStream(matchTitle, src) {
    let channels;
    try {
      channels = await this._backendJson(src.linksPath);
    } catch (err) {
      console.warn(`[${this.name}] Channel list failed for ${src.linksPath}: ${err.message}`);
      return [];
    }
    if (!Array.isArray(channels)) return [];
    const row = channels[src.streamIndex] || channels.find((c) => c && c.name && c.name.trim() === src.channelName);
    if (!row) return [];

    const label = row.name ? row.name.trim() : src.channelName;
    if (row.tokenApi) return this._resolveTokenApiRow(row.tokenApi, matchTitle, label);
    if (!row.link) return [];

    const dash = clearKeyDashStream(this.name, row, matchTitle, label);
    if (dash) return [dash];

    const { url, headers } = parseDelimited(row.link);
    if (!/^https?:\/\//i.test(url) || DASH_RE.test(url)) return [];
    if (/\.r2\.dev\//i.test(url)) {
      return [new StreamEntity({
        name: this.name,
        title: `${matchTitle} (${label})`,
        url,
        behaviorHints: { notWebReady: true, proxyHeaders: { request: { 'User-Agent': DEFAULT_UA, ...headers } } },
        resolution: 'HD',
      })];
    }
    return [new StreamEntity({
      name: this.name,
      title: `${matchTitle} (${label})`,
      url: manifestProxyUrl({ url, referer: headers.Referer || APP_REFERER, origin: headers.Origin }),
      behaviorHints: { notWebReady: true },
      resolution: 'HD',
    })];
  }

  /**
   * A `tokenApi` channel: an embedindia-family embed, or a page/API that answers
   * with a stream URL (JSON `link_key`, a Clappr player, or a bare .m3u8).
   * @returns {Promise<StreamEntity[]>}
   */
  async _resolveTokenApiRow(tokenApi, matchTitle, label) {
    const embedUrl = embedIndiaUrl(tokenApi, this.embedIndiaProvider);
    if (embedUrl) return embedIndiaStreams(this.name, this.embedIndiaProvider, embedUrl, matchTitle, label);

    let config;
    try {
      config = typeof tokenApi === 'string' ? JSON.parse(tokenApi) : tokenApi;
    } catch (_) { return []; }
    const api = config && (config.api || config.url);
    if (!/^https?:\/\//i.test(api || '')) return [];

    try {
      const res = await this.proxyFetch(api, {
        method: String(config.request_type || 'get').toUpperCase() === 'POST' ? 'POST' : 'GET',
        headers: { 'User-Agent': DEFAULT_UA, Referer: APP_REFERER },
        timeoutMs: 6000,
      });
      if (!res || !res.ok) return [];
      const text = await res.text();
      let url = '';
      try { url = JSON.parse(text)[config.link_key || 'playback_url'] || ''; } catch (_) { /* not JSON */ }
      url = url || extractClapprUrl(text) || (text.match(/https?:\/\/[^\s'"<>]+\.m3u8[^\s'"<>]*/i) || [''])[0];
      if (!/^https?:\/\//i.test(url)) return [];
      return [new StreamEntity({
        name: this.name,
        title: `${matchTitle} (${label})`,
        url: manifestProxyUrl({ url, referer: api }),
        behaviorHints: { notWebReady: true },
        resolution: 'HD',
      })];
    } catch (err) {
      console.warn(`[${this.name}] tokenApi failed for ${label}: ${err.message}`);
      return [];
    }
  }
}

module.exports = SkTechProvider;
module.exports.cleanEventTitle = cleanEventTitle;
module.exports.parsePlaylist = parsePlaylist;
module.exports.extractClapprUrl = extractClapprUrl;
module.exports.fetchRemoteConfigEntries = fetchRemoteConfigEntries;
