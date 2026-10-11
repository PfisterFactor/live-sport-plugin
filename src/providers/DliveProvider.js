const os = require('os');
const BaseProvider = require('./BaseProvider');
const { DEFAULT_UA } = BaseProvider;
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const IframeDomainRegistry = require('../services/IframeDomainRegistry');
const { getChannelLogo } = require('../services/ChannelLogoService');
const { BREAKER_TIMEOUT_MS } = require('../services/CircuitBreakerService');
const { parseTimezone } = require('../timezone');
const { manifestProxyUrl } = require('../proxyUrl');

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{FE0F}]/gu;

/** Longest a finished event may still be advertised, by category. */
const MAX_DURATION_MS = {
  cricket: 8 * 3600e3,
  mma: 6 * 3600e3,
  motorsport: 4 * 3600e3,
  american_football: 4 * 3600e3,
  baseball: 3.5 * 3600e3,
  basketball: 3 * 3600e3,
  tennis: 4 * 3600e3,
  golf: 6 * 3600e3,
  football: 2.5 * 3600e3,
  rugby: 2.5 * 3600e3,
  hockey: 3 * 3600e3,
  darts: 4 * 3600e3,
};
const DEFAULT_DURATION_MS = 3 * 3600e3;

/** Margin kept below the breaker's abort time so the inner timeout always fires first. */
const BREAKER_SAFETY_MARGIN_MS = 2000;

function decodeHtmlEntities(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .trim();
}

function stripEmoji(str) {
  return String(str || '').replace(EMOJI_RE, '').replace(/\s+/g, ' ').trim();
}

/** Streams cloaked as TikTok CDN video are a PNG with an .m3u8 name, not a feed. */
function isTikTokCloakedStream(url) {
  return typeof url === 'string' && /cowedd4855ws|tiktokcdn|tiktokx-origin/i.test(url);
}

/**
 * Unescape a manifest URL lifted out of inline JSON ("\\u0026" separators,
 * "\\/" slashes) so the signed query string survives intact.
 */
function cleanManifestUrl(url) {
  if (!url || typeof url !== 'string') return url;
  return url
    .replace(/\\u0026/gi, '&')
    .replace(/\\\//g, '/')
    .replace(/&amp;/gi, '&')
    .replace(/[\\"']+$/, '');
}

/**
 * Time budget (ms) for one schedule / channel-list fetch on the sync path.
 * A fixed 6 s aborts intermittently on a loaded host and drops every row from
 * the cache, so the budget scales with the 1-minute load average on top of a
 * 12 s baseline. It is always clamped below the circuit breaker's own abort
 * time: an inner timeout at or above it would be silently truncated and the
 * breaker, not this setting, would decide the real budget.
 *
 * Env: DADDYLIVE_SYNC_TIMEOUT_MS (fixed), SYNC_TIMEOUT_BASE_MS,
 * SYNC_TIMEOUT_MAX_MS (upper clamp, default 25000).
 */
function resolveSyncTimeoutMs() {
  const breakerCeiling = Math.max(1000, BREAKER_TIMEOUT_MS - BREAKER_SAFETY_MARGIN_MS);
  const fixed = parseInt(process.env.DADDYLIVE_SYNC_TIMEOUT_MS, 10);
  if (Number.isFinite(fixed) && fixed > 0) return Math.min(fixed, breakerCeiling);

  const baseMs = parseInt(process.env.SYNC_TIMEOUT_BASE_MS, 10) || 12000;
  const configured = parseInt(process.env.SYNC_TIMEOUT_MAX_MS, 10) || 25000;
  const maxMs = Math.min(configured, breakerCeiling);

  let load = 0;
  try {
    const la = os.loadavg();
    load = Array.isArray(la) && Number.isFinite(la[0]) ? la[0] : 0;
  } catch (_) { load = 0; }

  const scaled = Math.round(baseMs + Math.max(0, load) * 2000);
  return Math.min(Math.max(baseMs, scaled), maxMs);
}

/**
 * dlive.sx (DaddyLiveHD). The daily schedule is plain HTML; every event lists
 * channel links of the form /watch.php?id=<N>.
 *
 * Channel players are served from several mirror folders (/cast, /casting,
 * /watch, /player, /plus, /stream) on two domains, and each folder embeds a
 * different player host. A host's page is resolved by whichever strategy it
 * needs: the `window._econfig` envelope (base64 -> split into 4 equal chunks
 * -> drop the 4th character of each -> base64-decode each -> reassemble in the
 * order [2,0,3,1] -> base64 -> JSON), a plain manifest URL, a JSON player hop,
 * or one more nested iframe. IframeDomainRegistry remembers which host needs
 * which strategy and which Referer its segment CDN accepts.
 *
 * The signed manifest token is short-lived and bound to the requesting IP,
 * so streams are handed to the player through the manifest proxy with a
 * renewal descriptor (see services/StreamRenewal.js).
 */
class DliveProvider extends BaseProvider {
  constructor(opts) {
    super(opts);
    this.name = 'DaddyLive';
    this.sourceName = 'dlive';
    this.baseUrl = 'https://dlive.sx';
    this.baseDomains = ['https://dlive.sx', 'https://dlstreams.st'];
    this.folders = ['cast', 'casting', 'watch', 'player', 'plus', 'stream'];
    this.domainRegistry = (opts && opts.iframeDomainRegistry) || new IframeDomainRegistry();

    /**
     * Did the SCHEDULE parse on the last getMatches() run? null = never run.
     * Tri-state because 24/7 channel rows are returned even when the schedule
     * fails, so "returned something" says nothing about fixture health.
     */
    this.lastScheduleOk = null;

    this.fetchSchedule = this.circuitBreaker.wrap(`${this.name}_fetchSchedule`, async () => {
      const deadline = Date.now() + BREAKER_TIMEOUT_MS - BREAKER_SAFETY_MARGIN_MS;
      let lastErr = null;
      for (const base of this.baseDomains) {
        const timeoutMs = Math.min(resolveSyncTimeoutMs(), deadline - Date.now());
        if (timeoutMs < 1000) break;
        try {
          const res = await this.proxyFetch(`${base}/index.php`, {
            headers: { 'User-Agent': DEFAULT_UA, 'Referer': `${base}/` },
            timeoutMs,
          });
          if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
          const html = await res.text();
          if (this._parseSchedule(html).length > 0) return html;
          lastErr = new Error(`${base} schedule contained no events`);
        } catch (err) {
          lastErr = err;
        }
      }
      throw lastErr || new Error('All DaddyLive schedule endpoints failed');
    });

    this.fetchChannels = this.circuitBreaker.wrap(`${this.name}_fetchChannels`, async () => {
      const deadline = Date.now() + BREAKER_TIMEOUT_MS - BREAKER_SAFETY_MARGIN_MS;
      let lastErr = null;
      for (const base of this.baseDomains) {
        const timeoutMs = Math.min(resolveSyncTimeoutMs(), deadline - Date.now());
        if (timeoutMs < 1000) break;
        try {
          const res = await this.proxyFetch(`${base}/24-7-channels.php`, {
            headers: { 'User-Agent': DEFAULT_UA, 'Referer': `${base}/` },
            timeoutMs,
          });
          if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
          return await res.text();
        } catch (err) {
          lastErr = err;
        }
      }
      throw lastErr || new Error('All DaddyLive 24-7 channels endpoints failed');
    });
  }

  /**
   * Parse the schedule HTML: days contain categories contain events with a
   * HH:MM time (UK) and a list of /watch.php?id=N channel anchors.
   */
  _parseSchedule(html) {
    const events = [];

    const dayRe = /<div class="schedule__day">([\s\S]*?)(?=<div class="schedule__day">|<\/section>|$)/g;
    const catRe = /<div class="schedule__category[\s\S]*?<div class="card__meta">([\s\S]*?)<\/div>([\s\S]*?)(?=<div class="schedule__category[ "]|$)/g;
    const eventRe = /<div class="schedule__event">([\s\S]*?)(?=<div class="schedule__event">|<\/div>\s*<\/div>\s*<\/div>|$)/g;
    const timeRe = /data-time="(\d{2}:\d{2})"/;
    const titleRe = /<span class="schedule__eventTitle">([\s\S]*?)<\/span>/;
    const chanRe = /<a[^>]*href="\/watch\.php\?id=([^"]+)"[^>]*title="([^"]*)"/g;

    let day;
    while ((day = dayRe.exec(html)) !== null) {
      const dayTitle = (day[1].match(/<div class="schedule__dayTitle">([\s\S]*?)<\/div>/) || [])[1] || '';
      const dayDateMatch = dayTitle.match(/(\d{1,2})(?:st|nd|rd|th)\s+([A-Za-z]+)\s+(\d{4})/);
      const dayDate = dayDateMatch ? `${dayDateMatch[3]}-${this._monthNum(dayDateMatch[2])}-${dayDateMatch[1].padStart(2, '0')}` : '';

      let cat;
      while ((cat = catRe.exec(day[1])) !== null) {
        const categoryName = cat[1].trim();

        let ev;
        while ((ev = eventRe.exec(cat[2])) !== null) {
          const block = ev[1];
          const time = (block.match(timeRe) || [])[1];
          const title = ((block.match(titleRe) || [])[1] || '').trim();
          if (!time || !title) continue;

          const channels = [];
          let ch;
          while ((ch = chanRe.exec(block)) !== null) {
            channels.push({ id: ch[1], name: ch[2] });
          }
          if (channels.length === 0) continue;

          events.push({ dayDate: this._eventDate(title) || dayDate, time, categoryName, title, channels });
        }
      }
    }
    return events;
  }

  /**
   * "Upcoming Events" rows show far-future events under today's day header;
   * their true date is the last "d Month yyyy" group in the event title.
   */
  _eventDate(title) {
    const dates = [...title.matchAll(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,})\s+(\d{4})/g)];
    const last = dates[dates.length - 1];
    if (!last) return '';
    return `${last[3]}-${this._monthNum(last[2])}-${last[1].padStart(2, '0')}`;
  }

  _monthNum(name) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const idx = months.findIndex(m => name.toLowerCase().startsWith(m.toLowerCase()));
    return idx >= 0 ? String(idx + 1).padStart(2, '0') : '01';
  }


  /**
   * dlive category headers carry sport emoji; they are more reliable than
   * the league-name text (e.g. "England - Championship" + ⚽).
   */
  _mapCategory(name, title = '') {
    const c = String(name || '');
    const emoji = (s) => {
      if (/⚽/.test(s)) return 'football';
      if (/🏏/.test(s)) return 'cricket';
      if (/🏈/.test(s)) return 'american_football';
      if (/🏉/.test(s)) return 'rugby';
      if (/🎾/.test(s)) return 'tennis';
      if (/🏎|🏁|🏍/.test(s)) return 'motorsport';
      if (/🥊/.test(s)) return 'mma';
      if (/⛳/.test(s)) return 'golf';
      if (/🎯/.test(s)) return 'darts';
      if (/🏒/.test(s)) return 'hockey';
      if (/⚾/.test(s)) return 'baseball';
      if (/🏀/.test(s)) return 'basketball';
      if (/🚴/.test(s)) return 'motorsport';
      return '';
    };
    return emoji(c) || emoji(title) || this.mapCategoryLabel(c);
  }
  /** True for the placeholder "Event Stream" channels that never carry video. */
  static isEventStream(name) {
    const clean = String(name || '').trim();
    return /^event\s*[-_]?\s*(sd\s*[-_]?\s*)?stream/i.test(clean)
      || /^event\s*[-_]?\s*sd\b/i.test(clean)
      || /\bevent\s*(sd\s*)?stream\b/i.test(clean);
  }

  /**
   * Split "League : Home vs Away" so the league rides along as a property
   * instead of being baked into the catalog title.
   */
  _splitLeague(rawTitle) {
    const clean = stripEmoji(decodeHtmlEntities(rawTitle));
    const idx = clean.indexOf(' : ');
    if (idx === -1) return { league: '', title: clean };
    return { league: clean.slice(0, idx).trim(), title: clean.slice(idx + 3).trim() };
  }

  _teamsFromTitle(title) {
    const parts = title.split(/\s(?:vs?\.?|@|[-–—])\s/i);
    if (parts.length === 2 && parts[0].trim() && parts[1].trim()) {
      return { team1: { name: parts[0].trim() }, team2: { name: parts[1].trim() } };
    }
    return { team1: null, team2: null };
  }

  _fixtureMatches(html, now) {
    const matches = [];
    for (const ev of this._parseSchedule(html)) {
      const channels = ev.channels.filter(c => c.id !== '00' && !DliveProvider.isEventStream(c.name));
      if (channels.length === 0) continue;

      const { league, title } = this._splitLeague(ev.title);
      if (!title || /kings xi punjab/i.test(`${league} ${title}`)) continue;

      const kickoff = ev.dayDate && ev.time
        ? parseTimezone(`${ev.dayDate} ${ev.time}`, 'Europe/London')
        : null;
      const startsMs = typeof kickoff === 'number' ? kickoff : NaN;

      const category = this._mapCategory(ev.categoryName, ev.title);
      if (Number.isFinite(startsMs) && now > startsMs + (MAX_DURATION_MS[category] || DEFAULT_DURATION_MS)) continue;

      matches.push(new MatchEntity({
        id: `dl_${Buffer.from(`${ev.dayDate}|${ev.time}|${ev.title}`).toString('base64url').slice(0, 40)}`,
        title,
        category,
        status: Number.isFinite(startsMs) && startsMs > now ? 'upcoming' : 'live',
        date: Number.isFinite(startsMs) ? String(startsMs) : '',
        popular: '0',
        league: league || stripEmoji(decodeHtmlEntities(ev.categoryName)),
        ...this._teamsFromTitle(title),
        sources: [{
          source: this.sourceName,
          id: channels.map(c => c.id).join(','),
          names: channels.map(c => c.name),
        }],
      }));
    }
    return matches;
  }

  /** 24/7 channel cards: <a href="/watch.php?id=N"> ... <div class="card__title">Name</div>. */
  _channelMatches(html) {
    const matches = [];
    const seen = new Set();
    const re = /href=["']\/?watch\.php\?id=(\d+)["'][\s\S]*?<div class="card__title">([^<]+)<\/div>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const id = m[1];
      const name = decodeHtmlEntities(m[2]);
      if (!id || !name || seen.has(id) || name.includes('18+')) continue;
      seen.add(id);

      const logo = getChannelLogo(name);
      matches.push(new MatchEntity({
        id: `dl_ch_${id}_${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
        title: name,
        category: 'networks',
        date: '0',
        popular: '1',
        league: 'Live TV',
        logo: logo || '',
        thumbnail_url: logo || '',
        sources: [{ source: this.sourceName, id, names: [name] }],
      }));
    }
    return matches;
  }

  /**
   * Fixtures and 24/7 channels come from independent fetches: a schedule
   * failure keeps the channels, and `lastScheduleOk` tells the aggregator to
   * carry the previous fixtures forward.
   */
  async getMatches() {
    const matches = [];
    this.lastScheduleOk = false;

    try {
      const html = await this.fetchSchedule.fire();
      if (html) {
        matches.push(...this._fixtureMatches(html, Date.now()));
        this.lastScheduleOk = true;
      } else {
        console.warn(`[${this.name}] Schedule unavailable this sync; continuing to 24/7 channels.`);
      }
    } catch (err) {
      console.error(`[${this.name}] Failed to get matches:`, err.message);
    }

    try {
      const html = await this.fetchChannels.fire();
      if (html) matches.push(...this._channelMatches(html));
    } catch (err) {
      console.error(`[${this.name}] Failed to get 24-7 channels:`, err.message);
    }

    return matches;
  }

  /**
   * Player host iframe embedded in one mirror's channel page, or null when
   * the folder 404s, has no iframe, or only offers the cloaked TikTok player.
   */
  async _playerEmbedUrl(channelId, base = this.baseUrl, folder = 'stream', timeoutMs = 6000) {
    const playerUrl = `${base}/${folder}/stream-${encodeURIComponent(channelId)}.php`;
    const res = await this.proxyFetch(playerUrl, {
      headers: { 'User-Agent': DEFAULT_UA, 'Referer': `${base}/` },
      timeoutMs,
    });
    if (!res.ok) return null;
    const html = await res.text();
    const match = html.match(/<iframe[^>]+src=["']?([^"'\s>]+)["']?/i);
    if (!match) return null;

    let url = match[1];
    if (url.startsWith('//')) url = `https:${url}`;
    else if (url.startsWith('/')) url = new URL(url, playerUrl).toString();
    if (!/^https?:/i.test(url) || /daddyliveplayer\.st/i.test(url)) return null;
    return url;
  }

  /**
   * Decode the embed page's `window._econfig` payload. Throws on malformed
   * input so callers can fall back to the next strategy.
   */
  static decodeEmbedConfig(encoded) {
    const ORDER = [2, 0, 3, 1];
    const raw = Buffer.from(encoded, 'base64').toString('binary');
    const chunkLength = Math.ceil(raw.length / ORDER.length);

    const parts = [];
    for (let i = 0, at = 0; i < ORDER.length; i++, at += chunkLength) {
      const chunk = raw.substr(at, chunkLength);
      // The encoder inserts one junk character at index 3 of every chunk.
      parts[ORDER[i]] = Buffer.from(chunk.slice(0, 3) + chunk.slice(4), 'base64').toString('binary');
    }
    return JSON.parse(Buffer.from(parts.join(''), 'base64').toString('utf8'));
  }

  /** Fetch text for an embed-chain page; null on any failure. */
  async _fetchPage(url, referer, timeoutMs = 6000) {
    if (!/^https?:/i.test(url || '')) return null;
    try {
      const res = await this.proxyFetch(url, {
        headers: {
          'User-Agent': DEFAULT_UA,
          'Referer': referer,
          'Accept': 'text/html,application/xhtml+xml,application/json,*/*;q=0.8',
        },
        timeoutMs,
      });
      return res.ok ? await res.text() : null;
    } catch (_) {
      return null;
    }
  }

  _learn(urlOrHost, strategy, role) {
    try {
      const host = /^https?:\/\//i.test(urlOrHost) ? new URL(urlOrHost).hostname : urlOrHost;
      this.domainRegistry.learn(host, strategy, { role });
    } catch (_) { /* registry is advisory */ }
  }

  /**
   * Resolve a manifest from an embed page. Hosts differ, so strategies run in
   * cost order: _econfig, a direct/escaped manifest URL or `streamUrl` config
   * (wideiptv), a JSON player hop (vertex.st: api/player.php?id=N answers
   * {"url": ...}), then nested iframes (streame.center needs two hops), ranked
   * by the domain registry. Depth is bounded.
   *
   * @returns {{url: string, referer: string, strategy: string}|null}
   */
  async _resolveFromHtml(html, pageUrl, depth = 0) {
    if (!html || typeof html !== 'string') return null;
    const usable = (u) => u && !isTikTokCloakedStream(u);

    const econfig = html.match(/_econfig\s*=\s*['"]([A-Za-z0-9+/=]+)['"]/);
    if (econfig) {
      try {
        const config = DliveProvider.decodeEmbedConfig(econfig[1]);
        const url = config && (config.stream_url_nop2p || config.stream_url);
        if (usable(url)) return { url: cleanManifestUrl(url), referer: pageUrl, strategy: 'econfig' };
      } catch (err) {
        console.error(`[${this.name}] embed config decode failed for ${pageUrl}:`, err.message);
      }
    }

    // Backslashes stay allowed in the URL class: inline JSON escapes "&" as
    // "\u0026" and cutting there drops the signed query, which the CDN 403s.
    const candidates = [
      ['config', (html.match(/streamUrl:\s*["']([^"']+)["']/i) || [])[1]],
      ['direct', (html.match(/(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/i) || [])[1]],
      ['escaped', (html.match(/(https?:\\\/\\\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/i) || [])[1]],
    ];
    for (const [strategy, url] of candidates) {
      if (usable(url)) return { url: cleanManifestUrl(url), referer: pageUrl, strategy };
    }

    if (depth >= DliveProvider.MAX_EMBED_DEPTH) return null;

    const hopped = await this._jsonPlayerHop(html, pageUrl, depth);
    if (hopped) return hopped;

    const frames = [...html.matchAll(/<iframe[^>]+src=["']?([^"'\s>]+)["']?/gi)]
      .map((m) => {
        try { return new URL(m[1].startsWith('//') ? `https:${m[1]}` : m[1], pageUrl).toString(); } catch (_) { return ''; }
      })
      .filter((u) => /^https?:/i.test(u));
    for (const frame of this._rankFrames(frames).slice(0, 3)) {
      const nested = await this._resolveFromUrl(frame, pageUrl, depth + 1);
      if (nested) {
        this._learn(pageUrl, 'nested', 'wrapper');
        return nested;
      }
    }
    return null;
  }

  /** Known embed hosts first, platform noise dropped, unknown hosts last. */
  _rankFrames(urls) {
    const host = (u) => { try { return new URL(u).hostname; } catch (_) { return ''; } };
    const ranked = this.domainRegistry.rankCandidates(urls.map(host));
    const first = ranked.map((h) => urls.find((u) => host(u) === h)).filter(Boolean);
    const rest = urls.filter((u) => !first.includes(u) && !this.domainRegistry.isIgnored(host(u)));
    return [...first, ...rest];
  }

  /**
   * vertex.st style wrappers carry no iframe: the page calls
   * api/player.php?id=N, which answers {"url": "<real embed>"}. The page also
   * holds the TEMPLATE ("api/player.php?id=" + id), so the numeric id is
   * recovered from loadPlayerChannel(N) first.
   */
  async _jsonPlayerHop(html, pageUrl, depth) {
    const endpoint = html.match(/([^"']*player\.php)/i);
    const concrete = html.match(/([^"'\s]*player\.php\?[^"'\s]*[?&]id=\d+[^"'\s]*)/i);
    let channelId = (html.match(/loadPlayerChannel\(\s*(\d+)\s*\)/) || [])[1]
      || (html.match(/data-channel-id=["']?(\d+)/i) || [])[1];
    if (!channelId) {
      try { channelId = new URL(pageUrl).searchParams.get('id'); } catch (_) { /* no id */ }
    }

    let callUrl = null;
    try {
      if (concrete) callUrl = new URL(concrete[1], pageUrl).toString();
      else if (channelId && endpoint) callUrl = `${new URL(endpoint[1], pageUrl).toString()}?id=${channelId}`;
    } catch (_) { callUrl = null; }
    if (!callUrl) return null;

    const body = await this._fetchPage(callUrl, pageUrl);
    if (!body) return null;
    let target = null;
    try {
      const j = JSON.parse(body);
      target = j && (j.url || j.stream_url || j.stream_url_nop2p || j.embed || j.link);
    } catch (_) {
      target = (body.match(/(https?:\/\/[^\s"'<>\\]+)/i) || [])[1];
    }
    const nested = target ? await this._resolveFromUrl(target, pageUrl, depth + 1) : null;
    if (nested) this._learn(pageUrl, 'json-hop', 'wrapper');
    return nested;
  }

  async _resolveFromUrl(url, referer, depth) {
    const html = await this._fetchPage(url, referer);
    const result = await this._resolveFromHtml(html, url, depth);
    if (result && ['econfig', 'direct', 'config', 'escaped'].includes(result.strategy)) {
      this._learn(url, result.strategy, 'embed');
    }
    return result;
  }

  /**
   * Referer for a resolved manifest. The segment CDN allows the Referer of
   * its own terminal host family, not the iframe that happened to embed the
   * decoder, so a registry entry for the manifest host wins over the page.
   */
  _manifestReferer(manifestUrl, pageUrl) {
    try {
      const known = this.domainRegistry.terminalRefererFor(new URL(manifestUrl).hostname);
      if (known) return known;
    } catch (_) { /* fall through */ }
    return `${new URL(pageUrl).origin}/`;
  }

  /**
   * Re-mints the signed manifest for an embed page.
   * Shape matches the StreamRenewal renewer contract.
   */
  async extractM3u8(embedUrl) {
    const html = await this._fetchPage(embedUrl, `${this.baseUrl}/`, 15000);
    const resolved = await this._resolveFromHtml(html, embedUrl, 0);
    if (!resolved) return null;
    if (['econfig', 'direct', 'config', 'escaped'].includes(resolved.strategy)) {
      this._learn(embedUrl, resolved.strategy, 'embed');
    }
    return { m3u8: resolved.url, referer: this._manifestReferer(resolved.url, resolved.referer) };
  }

  /**
   * Probe mirror folders for one channel and stop at the first manifest: the
   * folders are alternatives for the same channel, not a matrix to exhaust.
   * Domains and folders are ordered by observed reliability.
   */
  async _resolveChannel(channelId) {
    const deadline = Date.now() + DliveProvider.CHANNEL_BUDGET_MS;
    for (const base of this.baseDomains) {
      for (const folder of this.folders) {
        const remaining = deadline - Date.now();
        if (remaining < 1000) return null;
        try {
          const embedUrl = await this._playerEmbedUrl(channelId, base, folder, Math.min(6000, remaining));
          if (!embedUrl) continue;
          const extracted = await this.extractM3u8(embedUrl);
          if (extracted) return { ...extracted, embedUrl };
        } catch (err) {
          console.error(`[${this.name}] ${base}/${folder} failed for channel ${channelId}:`, err.message);
        }
      }
    }
    return null;
  }

  async resolveStream(sourceId, matchCategory, matchTitle, src = {}) {
    const ids = String(sourceId).split(',').filter(Boolean).slice(0, DliveProvider.MAX_CHANNELS);
    const names = Array.isArray(src.names) ? src.names : [];

    return Promise.all(ids.map(async (id, idx) => {
      const label = names[idx] || `Source ${idx + 1}`;
      const resolved = await this._resolveChannel(id);
      if (resolved) {
        return new StreamEntity({
          name: this.name,
          title: `${matchTitle} (${label})`,
          url: manifestProxyUrl({
            url: resolved.m3u8,
            referer: resolved.referer,
            renew: this.sourceName,
            embed: resolved.embedUrl,
          }),
          behaviorHints: { notWebReady: true },
          resolution: 'HD',
        });
      }
      return new StreamEntity({
        name: this.name,
        title: `${matchTitle} (${label}) (Web Player)`,
        externalUrl: `${this.baseUrl}/watch.php?id=${encodeURIComponent(id)}`,
      });
    }));
  }
}

/** Channels resolved per event; events can list a dozen, each costing several fetches. */
DliveProvider.MAX_CHANNELS = 4;

DliveProvider.resolveSyncTimeoutMs = resolveSyncTimeoutMs;

/** Embed->embed hops followed before giving up (streame.center needs two). */
DliveProvider.MAX_EMBED_DEPTH = 2;

/** Wall-clock cap for probing every mirror of one channel. */
DliveProvider.CHANNEL_BUDGET_MS = 20000;

module.exports = DliveProvider;
