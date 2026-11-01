const crypto = require('crypto');
const BaseProvider = require('./BaseProvider');
const { DEFAULT_UA } = BaseProvider;
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const { extractTeamsFromTitle } = require('../services/TeamNameExtractor');
const { manifestProxyUrl } = require('../proxyUrl');

const DEFAULT_REFERER = 'http://www.fawanews.sc/';
const DEFAULT_ORIGIN = 'http://www.fawanews.sc';
const CATALOG_CATEGORIES = new Set([
  'football', 'american_football', 'basketball', 'baseball', 'hockey', 'motorsport', 'mma',
  'golf', 'rugby', 'cricket', 'tennis', 'darts', 'college', 'other',
]);
const APP_UA = 'okhttp/4.9.2';

const PLAYLIST_FEEDS = [
  'https://fawasp.pages.dev/playlist.txt',
  'https://axsp.pages.dev/playlist.txt',
];

const BASE_URL_AK47 = 'https://hellobabu.xyz';
const EVENTS_URL = `${BASE_URL_AK47}/events.txt`;
const AK47_KEY = Buffer.from('az1sUE8zNnNUVXpN', 'ascii');
const AK47_IV = Buffer.from('dz00QVhsNmZZU0Fw', 'ascii');

const BLOCKED_HOST_RE = /embed\.st|embedindia\.st|strmd\.st|gasm|wasm/i;
const DASH_RE = /\.mpd(\?|$)|\/dash\/|cenc/i;
const FINISHED_GRACE_MS = 30 * 60 * 1000;
const UNKNOWN_END_MS = 4 * 3600e3;
const DAY_MS = 24 * 3600e3;

/** Parse "dd/mm/yyyy" + "hh:mm[:ss]" (UTC) into epoch ms, or 0. */
function parseEventTime(date, time) {
  if (!date || !time) return 0;
  const d = String(date).split('/').map(Number);
  const t = String(time).split(':').map(Number);
  if (d.length !== 3 || !d[0] || !d[1] || !d[2]) return 0;
  const ms = Date.UTC(d[2], d[1] - 1, d[0], t[0] || 0, t[1] || 0, t[2] || 0);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Kickoff in epoch ms. The feed reuses old entries and only bumps end_date,
 * leaving a start days before the end; a span over a day is read as the
 * start time on the end date.
 */
function eventStartMs(ev, endMs) {
  const startMs = parseEventTime(ev.date, ev.time);
  if (!startMs || !endMs || endMs - startMs <= DAY_MS) return startMs;
  const sameDay = parseEventTime(ev.end_date, ev.time);
  return sameDay > endMs ? sameDay - DAY_MS : sameDay;
}

/**
 * Apply a "k=v&k=v" suffix (from "url|Referer=...&User-Agent=..." links) onto
 * the header set.
 */
function applyHeaderPairs(suffix, headers) {
  for (const pair of suffix.split('&')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const k = pair.slice(0, eq).trim().toLowerCase();
    const v = pair.slice(eq + 1).trim();
    if (k === 'referer' || k === 'http-referrer') headers.referer = v;
    else if (k === 'origin' || k === 'http-origin') headers.origin = v;
    else if (k === 'user-agent' || k === 'http-user-agent') headers.userAgent = v;
  }
}

/**
 * AK47 / hellobabu app backend. Event lists and per-event link lists are
 * obfuscated: base64 -> swap adjacent byte pairs -> reverse -> base64 ->
 * AES-128-CBC -> JSON. Two public M3U feeds (fawasp / axsp) add extra direct
 * channels with #EXTVLCOPT headers. DASH/ClearKey and embed.st/WASM links are
 * dropped; only plain HLS survives.
 */
class Ak47LiveProvider extends BaseProvider {
  constructor(opts = {}) {
    super(opts);
    this.name = 'Ak47Live';
    this.sourceName = 'ak47live';
    this._cache = null;
    this._lastFetchTime = 0;
    this._cacheTtlMs = 180000;
  }

  /** Canonical category; league-name labels (e.g. "Norway Eliteserien") are football, anything else unknown is 'other'. */
  _category(cat) {
    if (!cat) return 'other';
    const label = String(cat);
    const mapped = this.mapCategoryLabel(label);
    if (mapped !== 'other' && CATALOG_CATEGORIES.has(mapped)) return mapped;
    if (/premier\s*league|la\s*liga|serie\s*[ab]|bundesliga|ligue\s*1|champions\s*league|europa|conference\s*league|fa\s*cup|copa|a-league|aleague|mls|eredivisie|scotland|liga|league|lig\b|superlig|division|eliteserien|allsvenskan|hnl|nb1|primeira|segunda|challenger/i.test(label)) {
      return 'football';
    }
    return 'other';
  }

  /** Decrypt an AK47 payload (events.txt, pro/*.txt); null when malformed. */
  _decryptAk47Payload(rawBase64) {
    if (!rawBase64 || typeof rawBase64 !== 'string') return null;
    try {
      const b1 = Buffer.from(rawBase64.trim(), 'base64');
      for (let i = 0; i < b1.length - 1; i += 2) {
        const tmp = b1[i];
        b1[i] = b1[i + 1];
        b1[i + 1] = tmp;
      }
      b1.reverse();
      const ciphertext = Buffer.from(b1.toString('ascii'), 'base64');
      const decipher = crypto.createDecipheriv('aes-128-cbc', AK47_KEY, AK47_IV);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return JSON.parse(decrypted.toString('utf8'));
    } catch (_) {
      return null;
    }
  }

  /** Parse an M3U playlist into HLS entries with their #EXTVLCOPT headers; DASH and non-http links are dropped. */
  _parseM3u(content) {
    if (!content || typeof content !== 'string') return [];
    const lines = content.split(/\r?\n/);
    const entries = [];
    let opts = {};

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      if (line.startsWith('#EXTVLCOPT:')) {
        const headers = {};
        applyHeaderPairs(line.slice(11).trim(), headers);
        opts = { ...opts, ...headers };
        continue;
      }
      if (!line.startsWith('#EXTINF:')) continue;

      const attr = (name) => (line.match(new RegExp(`${name}="([^"]*)"`, 'i')) || [])[1]?.trim() || '';
      const tvgName = attr('tvg-name');
      const commaIdx = line.lastIndexOf(',');
      const rawTitle = commaIdx !== -1 ? line.slice(commaIdx + 1).trim() : tvgName;

      let streamUrl = '';
      while (i + 1 < lines.length) {
        const next = lines[i + 1].trim();
        i++;
        if (next && !next.startsWith('#')) { streamUrl = next; break; }
      }
      const entryOpts = opts;
      opts = {};

      if (!streamUrl || DASH_RE.test(streamUrl) || !/^https?:\/\//i.test(streamUrl)) continue;

      entries.push({
        rawTitle: rawTitle || tvgName,
        groupTitle: attr('group-title') || 'Other',
        tvgLogo: attr('tvg-logo'),
        streamUrl,
        referer: entryOpts.referer || DEFAULT_REFERER,
        origin: entryOpts.origin || DEFAULT_ORIGIN,
        userAgent: entryOpts.userAgent || DEFAULT_UA,
      });
    }
    return entries;
  }

  /** Split "Boxing : A vs B --- CH 1" into title, channel label, teams and category. */
  _extractMatchInfo(rawTitle, groupTitle) {
    let title = rawTitle || '';
    let channelLabel = 'HD';
    const chMatch = title.match(/[-–—\s]+(CH\s*\d+|Server\s*\d+|HD\s*SERVER\s*\d+|PPV\s*\d*)/i);
    if (chMatch) {
      channelLabel = chMatch[1].trim();
      title = title.replace(chMatch[0], '').trim();
    }
    title = title.replace(/^[A-Za-z0-9 .&'-]{2,30}\s+:\s+/, '').trim();
    title = title.replace(/[-–—\s]+$/, '').trim();

    let team1 = null;
    let team2 = null;
    const derived = extractTeamsFromTitle(title);
    if (derived && derived.length === 2) {
      [team1, team2] = derived;
    } else {
      const vs = title.match(/^(.+?)\s+(?:vs\.?|v\.?|@)\s+(.+?)$/i);
      if (vs) { team1 = vs[1].trim(); team2 = vs[2].trim(); }
    }

    return { title: title || rawTitle, channelLabel, team1, team2, category: this._category(groupTitle) };
  }

  /** Decode events.txt into MatchEntity map; records finished/known events for the playlist merge. */
  _eventMatches(events, now, ctx) {
    for (const item of events) {
      let ev;
      try { ev = typeof item.event === 'string' ? JSON.parse(item.event) : item.event; } catch (_) { continue; }
      if (!ev || ev.visible === false || !ev.teamAName || !ev.teamBName) continue;

      const endMs = parseEventTime(ev.end_date, ev.end_time);
      const startMs = eventStartMs(ev, endMs);
      const t1 = ev.teamAName.trim();
      const t2 = ev.teamBName.trim();
      const isMatchup = Boolean(t1 && t2 && t1.toLowerCase() !== t2.toLowerCase());
      const title = isMatchup ? `${t1} vs ${t2}` : (ev.eventName ? ev.eventName.trim() : t1);
      const slug = this.normalizeStr(title) || 'match';
      const id = `ak47_${slug.replace(/\s+/g, '_')}`;
      const n1 = this.normalizeStr(t1);
      const n2 = this.normalizeStr(t2);

      const finished = endMs > 0
        ? now > endMs + FINISHED_GRACE_MS
        : (startMs > 0 && now > startMs + UNKNOWN_END_MS);
      if (finished) {
        ctx.finishedSlugs.add(slug);
        if (t1 && t2) { ctx.finishedPairs.add(`${n1}|${n2}`); ctx.finishedPairs.add(`${n2}|${n1}`); }
        continue;
      }

      const status = startMs > 0 && now < startMs ? 'upcoming' : 'live';
      const known = { matchDate: startMs > 0 ? String(startMs) : '', status };
      ctx.known.set(slug, known);
      if (t1 && t2) { ctx.known.set(`${n1}|${n2}`, known); ctx.known.set(`${n2}|${n1}`, known); }

      const linkNames = Array.isArray(ev.link_names) ? ev.link_names : [];
      const linksPath = ev.links || '';
      const sources = [];
      if (linkNames.length > 0 && linksPath) {
        linkNames.forEach((name, idx) => sources.push({
          source: this.sourceName, id: `${linksPath}#${idx}`, channelName: String(name).trim(), linksPath, streamIndex: idx, type: 'live',
        }));
      } else if (linksPath) {
        sources.push({ source: this.sourceName, id: linksPath, channelName: 'HD', linksPath, streamIndex: 0, type: 'live' });
      }

      const existing = ctx.matches.get(id);
      if (existing) {
        for (const s of sources) if (!existing.sources.some(e => e.id === s.id)) existing.sources.push(s);
        continue;
      }
      ctx.matches.set(id, new MatchEntity({
        id,
        title,
        category: this._category(ev.category || 'Football'),
        league: ev.eventName ? ev.eventName.trim() : '',
        date: known.matchDate,
        status,
        team1: isMatchup ? { name: t1 } : null,
        team2: isMatchup ? { name: t2 } : null,
        thumbnail_url: ev.eventLogo || ev.teamAFlag || '',
        sources,
      }));
    }
  }

  _playlistMatches(entries, ctx) {
    for (const entry of entries) {
      const { title, channelLabel, team1, team2, category } = this._extractMatchInfo(entry.rawTitle, entry.groupTitle);
      const slug = this.normalizeStr(title) || 'match';
      const id = `ak47_${slug.replace(/\s+/g, '_')}`;
      const pair1 = team1 && team2 ? `${this.normalizeStr(team1)}|${this.normalizeStr(team2)}` : null;
      const pair2 = team1 && team2 ? `${this.normalizeStr(team2)}|${this.normalizeStr(team1)}` : null;
      if (ctx.finishedSlugs.has(slug) || (pair1 && (ctx.finishedPairs.has(pair1) || ctx.finishedPairs.has(pair2)))) continue;

      const source = {
        source: this.sourceName,
        id: entry.streamUrl,
        channelName: channelLabel,
        referer: entry.referer,
        origin: entry.origin,
        userAgent: entry.userAgent,
        type: 'live',
      };

      const existing = ctx.matches.get(id);
      if (existing) {
        if (!existing.sources.some(s => s.id === entry.streamUrl)) existing.sources.push(source);
        continue;
      }
      const known = ctx.known.get(slug) || (pair1 && (ctx.known.get(pair1) || ctx.known.get(pair2)));
      ctx.matches.set(id, new MatchEntity({
        id,
        title,
        category,
        league: entry.groupTitle || '',
        date: known ? known.matchDate : '',
        status: known ? known.status : 'live',
        team1: team1 ? { name: team1 } : null,
        team2: team2 ? { name: team2 } : null,
        thumbnail_url: team1 && team2 ? '' : (entry.tvgLogo || ''),
        sources: [source],
      }));
    }
  }

  /** Merge the encrypted events feed with both M3U playlists; one card per fixture. */
  async getMatches() {
    const now = Date.now();
    if (this._cache && (now - this._lastFetchTime) < this._cacheTtlMs) return this._cache;

    const ctx = { matches: new Map(), finishedSlugs: new Set(), finishedPairs: new Set(), known: new Map() };

    try {
      const res = await this.proxyFetch(EVENTS_URL, { headers: { 'User-Agent': APP_UA }, timeoutMs: 8000 });
      if (res && res.status === 200) {
        const events = this._decryptAk47Payload(await res.text());
        if (Array.isArray(events)) this._eventMatches(events, now, ctx);
      }
    } catch (err) {
      console.warn(`[${this.name}] Events fetch failed: ${err.message}`);
    }

    const feeds = await Promise.all(PLAYLIST_FEEDS.map(async (feedUrl) => {
      try {
        const res = await this.proxyFetch(feedUrl, { headers: { 'User-Agent': APP_UA }, timeoutMs: 6000 });
        if (!res || res.status !== 200) return [];
        return this._parseM3u(await res.text());
      } catch (err) {
        console.warn(`[${this.name}] Feed fetch failed for ${feedUrl}: ${err.message}`);
        return [];
      }
    }));
    for (const entries of feeds) this._playlistMatches(entries, ctx);

    const matches = Array.from(ctx.matches.values());
    this._cache = matches;
    this._lastFetchTime = now;
    return matches;
  }

  /** Pull a playable m3u8 out of a tokenApi endpoint; updates headers when the page itself is the referer. */
  async _resolveTokenApi(selected, headers) {
    let tokenObj;
    try {
      tokenObj = typeof selected.tokenApi === 'string' ? JSON.parse(selected.tokenApi) : selected.tokenApi;
    } catch (_) { return ''; }
    if (!tokenObj || !tokenObj.api || BLOCKED_HOST_RE.test(tokenObj.api)) return '';

    const res = await this.proxyFetch(tokenObj.api, {
      headers: { 'User-Agent': DEFAULT_UA, 'Referer': `${BASE_URL_AK47}/` },
      timeoutMs: 5000,
    });
    if (!res || res.status !== 200) return '';
    const body = await res.text();
    try {
      const json = JSON.parse(body);
      return json.playback_url || json.url || '';
    } catch (_) {
      const hls = body.match(/hlsManifestUrl":"([^"]+)"/);
      if (hls) return hls[1];
      const src = body.match(/"src"\s*:\s*"(https?:\/\/[^"]+\.m3u8[^"]*)"/i)
        || body.match(/(?:source:\s*["']|playback_url["']:\s*["'])(https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
      if (!src) return '';
      headers.referer = tokenObj.api;
      try { headers.origin = new URL(tokenObj.api).origin; } catch (_) {}
      return src[1];
    }
  }

  /** Resolve one source (an encrypted pro/*.txt channel or a direct playlist URL) into a proxied HLS stream. */
  async resolveStream(sourceId, matchCategory, matchTitle, src = {}) {
    let streamUrl = src.id || sourceId;
    const headers = {
      referer: src.referer || DEFAULT_REFERER,
      origin: src.origin || DEFAULT_ORIGIN,
      userAgent: src.userAgent || DEFAULT_UA,
    };
    let channelLabel = src.channelName || 'HD';

    if (src.linksPath || (typeof streamUrl === 'string' && streamUrl.startsWith('pro/'))) {
      const linksPath = src.linksPath || streamUrl.split('#')[0];
      const idx = src.streamIndex !== undefined ? src.streamIndex : 0;
      try {
        const res = await this.proxyFetch(`${BASE_URL_AK47}/${linksPath}`, { headers: { 'User-Agent': APP_UA }, timeoutMs: 6000 });
        if (res && res.status === 200) {
          const streams = this._decryptAk47Payload(await res.text());
          const selected = Array.isArray(streams) && streams.length > 0
            ? (streams[idx] || streams.find(s => s.name && s.name.trim() === channelLabel) || streams[0])
            : null;
          if (selected) {
            channelLabel = selected.name ? selected.name.trim() : channelLabel;
            if (selected.drm_scheme || selected.key || selected.kid) return [];

            const tokenApiStr = typeof selected.tokenApi === 'string' ? selected.tokenApi : JSON.stringify(selected.tokenApi || '');
            if (BLOCKED_HOST_RE.test(selected.link || '') || BLOCKED_HOST_RE.test(tokenApiStr)) return [];

            if (selected.link) {
              const parts = selected.link.split('|');
              streamUrl = parts[0].trim();
              const hadReferer = parts.length > 1 && /(?:^|&)\s*(?:http-)?referr?er\s*=/i.test(parts.slice(1).join('|'));
              if (parts.length > 1) applyHeaderPairs(parts.slice(1).join('|'), headers);
              if (hadReferer && !/(?:^|&)\s*(?:http-)?origin\s*=/i.test(parts.slice(1).join('|'))) {
                try { headers.origin = new URL(headers.referer).origin; } catch (_) {}
              }
            } else if (selected.tokenApi) {
              streamUrl = (await this._resolveTokenApi(selected, headers)) || streamUrl;
            }
          }
        }
      } catch (err) {
        console.warn(`[${this.name}] Pro stream resolve failed for ${linksPath}: ${err.message}`);
      }
    }

    if (typeof streamUrl !== 'string' || !/^https?:\/\//i.test(streamUrl)) return [];
    if (DASH_RE.test(streamUrl) || BLOCKED_HOST_RE.test(streamUrl)) return [];

    return [new StreamEntity({
      name: this.name,
      title: `${matchTitle || 'Live Event'} (${channelLabel})`,
      url: manifestProxyUrl({ url: streamUrl, referer: headers.referer, origin: headers.origin }),
      behaviorHints: { notWebReady: true },
      resolution: 'HD',
    })];
  }
}

module.exports = Ak47LiveProvider;
