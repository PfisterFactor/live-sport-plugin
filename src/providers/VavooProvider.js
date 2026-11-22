const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const { manifestProxyUrl } = require('../proxyUrl');

const CATALOG_PATH = path.join(__dirname, '..', 'data', 'vavoo_channels.json');
const PING_URL = 'https://www.vypn.net/api/app/ping';
const MIRRORS = ['https://vavoo.to', 'https://kool.to', 'https://vavoo.net', 'https://kool.ws'];
const MIRROR_HOSTS = ['vavoo.to', 'kool.to', 'vavoo.net', 'kool.ws', 'huhu.to', 'oha.to', 'voltop.net'];
const REFERER = 'https://vavoo.to/';
const API_USER_AGENT = 'MediaHubMX/2';

/** A token this close to its expiry is renewed before the next request. */
const TOKEN_REFRESH_MARGIN_MS = 3 * 60 * 1000;
const DEFAULT_TOKEN_TTL_MS = 20 * 60 * 1000;

/** Mirror responses that mean "try another mirror". */
const MIRROR_RETRY_STATUSES = new Set([451, 500, 502, 503, 504]);

/** Strips variant markers (.b/.c/.s server suffixes, quality, backup) so feeds of one channel share a key. */
function channelKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\s*\.[a-z]\b/g, ' ')
    .replace(/\b(?:4k|uhd|fhd|full\s*hd|hd|sd|hevc|h\.?265|raw)\b/g, ' ')
    .replace(/\(\s*(?:backup|bkp)(?:\s*\d+)?\s*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Display name of a channel without server suffixes or backup/codec markers. */
function channelLabel(name) {
  const label = String(name || '')
    .replace(/\s*\.[a-z]\b/gi, ' ')
    .replace(/\s*\[[^\]]*\]\s*/g, ' ')
    .replace(/\s*[[(]\s*(?:backup|bkp|alternate|alt)(?:\s*\d+)?\s*[\])]/gi, ' ')
    .replace(/\b(?:backup|bkp)(?:\s*\d+)?\b/gi, ' ')
    .replace(/\b(?:hevc|h\.?265|raw)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return label || String(name || '').trim();
}

/** Server/codec tag that tells apart the feeds of one channel in the stream list. */
function serverTag(name) {
  const n = String(name || '');
  if (/\bbackup\b|\(backup/i.test(n)) return 'Backup';
  if (/\b(?:hevc|h\.?265)\b/i.test(n)) return 'HEVC';
  if (/\braw\b/i.test(n)) return 'RAW';
  const server = n.match(/\.([bcs])\b/i);
  return server ? `Server ${server[1].toUpperCase()}` : '';
}

/** Reads the first stream URL out of the several shapes the resolve API answers with. */
function resolvedUrl(body) {
  if (Array.isArray(body) && body[0] && body[0].url) return String(body[0].url);
  if (body && body.url) return String(body.url);
  if (body && body.data && body.data.url) return String(body.data.url);
  return null;
}

/**
 * Vavoo 24/7 channels. A signed ping (the same one the Vavoo app sends) yields
 * a short-lived signature; the mediahubmx resolve endpoint turns a catalog play
 * URL into the live HLS URL. The catalog lists sports channels only. Opt-in:
 * set VAVOO_ENABLED=true.
 */
class VavooProvider extends BaseProvider {
  /**
   * @param {object} opts  provider cradle ({ circuitBreaker })
   */
  constructor(opts) {
    super(opts);
    this.name = 'Vavoo';
    this.sourceName = 'vavoo';
    this._sig = null;
    this._sigValidUntil = 0;
    this._sigPending = null;
    this._mirror = 0;
    this._catalog = null;
  }

  /** True when VAVOO_ENABLED=true. */
  isEnabled() {
    return process.env.VAVOO_ENABLED === 'true';
  }

  /** Channel catalog from src/data/vavoo_channels.json, read once. */
  _loadCatalog() {
    if (!this._catalog) {
      try {
        this._catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
      } catch (err) {
        console.error(`[${this.name}] Failed to read channel catalog:`, err.message);
        this._catalog = [];
      }
    }
    return this._catalog;
  }

  /** Requests a fresh signature from the app ping endpoint. */
  async _ping() {
    const now = Date.now();
    const res = await this.proxyFetch(PING_URL, {
      method: 'POST',
      headers: {
        'user-agent': 'okhttp/4.12.0',
        accept: 'application/json',
        'content-type': 'application/json; charset=utf-8',
        'Accept-Language': 'de',
      },
      body: JSON.stringify({
        token: '',
        reason: 'app-focus',
        locale: 'de',
        theme: 'dark',
        metadata: {
          device: { type: 'phone', uniqueId: crypto.randomBytes(8).toString('hex') },
          os: { name: 'android', version: '14', abis: ['arm64-v8a'], host: 'android' },
          app: { platform: 'android' },
          version: { package: 'net.vypn.app', binary: '1.4.1', js: '1.4.1' },
        },
        appFocusTime: 0,
        playerActive: false,
        playDuration: 0,
        devMode: false,
        hasAddon: true,
        castConnected: false,
        package: 'net.vypn.app',
        version: '1.4.1',
        process: 'app',
        firstAppStart: now - 86400000,
        lastAppStart: now,
        ipLocation: null,
        adblockEnabled: true,
        migrationApplied: false,
        migrationTargetInstalled: false,
        proxy: { supported: ['ss'], engine: 'Mu', ssVersion: '2022', enabled: false, autoServer: true, id: '' },
        iap: { supported: false, error: '' },
      }),
      timeoutMs: 8000,
    });
    if (!res.ok) throw new Error(`ping HTTP ${res.status}`);
    const json = await res.json();
    if (!json || !json.addonSig) throw new Error('ping response missing addonSig');

    let validUntil = now + DEFAULT_TOKEN_TTL_MS;
    try {
      const decoded = JSON.parse(Buffer.from(String(json.addonSig), 'base64').toString('utf8'));
      const data = typeof decoded.data === 'string' ? JSON.parse(decoded.data) : decoded.data;
      if (data && typeof data.validUntil === 'number') validUntil = data.validUntil;
    } catch (_) { /* keep the default lifetime */ }
    return { sig: json.addonSig, validUntil };
  }

  /** Current signature, renewed single-flight when missing or about to expire. */
  async _signature(force = false) {
    if (!force && this._sig && Date.now() < this._sigValidUntil - TOKEN_REFRESH_MARGIN_MS) return this._sig;
    if (!this._sigPending) {
      this._sigPending = this._ping()
        .then(({ sig, validUntil }) => {
          this._sig = sig;
          this._sigValidUntil = validUntil;
          return sig;
        })
        .finally(() => { this._sigPending = null; });
    }
    return await this._sigPending;
  }

  /**
   * Sports channels collapsed per country and name; empty unless VAVOO_ENABLED=true.
   * @returns {Promise<MatchEntity[]>}
   */
  async getMatches() {
    if (!this.isEnabled()) return [];

    const groups = new Map();
    for (const ch of this._loadCatalog()) {
      const key = `${ch.group || 'all'}:${channelKey(ch.name)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(ch);
    }

    const matches = [];
    for (const [key, channels] of groups) {
      const best = channels.find((c) => !serverTag(c.name)) || channels[0];
      const is4k = channels.some((c) => c.is4k || /\b(?:4k|uhd)\b/i.test(c.name));
      const label = channelLabel(best.name);
      matches.push(new MatchEntity({
        id: `vavoo_ch_${key.replace(/[^a-z0-9]+/gi, '_')}`,
        title: `${is4k && !/4k|uhd/i.test(label) ? `${label} 4K` : label} - ${best.group || 'Live TV'}`,
        category: 'networks',
        date: '0',
        popular: is4k ? '1' : '0',
        league: best.group || 'Live TV',
        sources: channels.map((c) => ({
          source: this.sourceName,
          id: c.vavooUrl,
          channelName: c.name,
          group: c.group,
          language: c.language,
          is4k: !!c.is4k,
        })),
      }));
    }
    return matches;
  }

  /** POSTs a JSON body to a mirror's mediahubmx endpoint. */
  _mediahub(base, endpoint, sig, body, timeoutMs = 8000) {
    return this.proxyFetch(`${base}/${endpoint}`, {
      method: 'POST',
      headers: {
        'user-agent': API_USER_AGENT,
        accept: 'application/json',
        'content-type': 'application/json; charset=utf-8',
        'mediahubmx-signature': sig,
        origin: base,
        referer: `${base}/`,
      },
      body: JSON.stringify({ language: 'de', region: 'AT', clientVersion: '3.1.0', ...body }),
      timeoutMs,
    });
  }

  /**
   * Looks the channel up by name in the live catalog when its stored play id is
   * gone, then resolves the match's play URL.
   */
  async _resolveByName(base, sig, src, matchTitle) {
    const search = channelLabel(src.channelName || matchTitle)
      .replace(/\s*[-–—].*$/, '')
      .replace(/\([^)]*\)/g, '')
      .replace(/\b(?:4k|uhd|fhd|1080p|720p|hd|sd)\b/gi, '')
      .trim();
    if (!search) return null;

    const res = await this._mediahub(base, 'mediahubmx-catalog.json', sig, {
      catalogId: 'iptv', id: 'iptv', adult: false, search, sort: 'name', cursor: 0,
      filter: src.group ? { group: src.group } : {},
    }, 6000);
    if (!res.ok) return null;
    const items = (await res.json()).items || [];
    const candidates = items.filter((it) => !/\.s\b|live during events only/i.test(it.name || ''));
    const pick = (candidates.length ? candidates : items).find((it) => it.url);
    if (!pick) return null;

    const fresh = await this._mediahub(base, 'mediahubmx-resolve.json', sig, { url: pick.url }, 6000);
    return fresh.ok ? resolvedUrl(await fresh.json()) : null;
  }

  /** Resolves a play URL through the mirrors, rotating on gateway errors. */
  async _resolveUrl(playUrl, src, matchTitle) {
    let sig = await this._signature();
    let lastError = null;
    for (let i = 0; i < MIRRORS.length; i++) {
      const index = (this._mirror + i) % MIRRORS.length;
      const base = MIRRORS[index];
      try {
        const res = await this._mediahub(base, 'mediahubmx-resolve.json', sig, { url: playUrl });
        if (MIRROR_RETRY_STATUSES.has(res.status)) {
          lastError = new Error(`HTTP ${res.status} on ${base}`);
          continue;
        }
        if (res.status === 401 || res.status === 403) {
          lastError = new Error(`signature rejected on ${base}`);
          sig = await this._signature(true);
          continue;
        }
        let body = null;
        try { body = await res.json(); } catch (_) { /* non-JSON error page */ }
        let url = res.ok ? resolvedUrl(body) : null;
        const gone = res.status === 404 || res.status === 410 || (body && typeof body.error === 'string' && /not found|no resolver/i.test(body.error));
        if (!url && gone) url = await this._resolveByName(base, sig, src, matchTitle);
        if (url) {
          this._mirror = index;
          return url;
        }
        lastError = new Error(`no stream URL from ${base} (HTTP ${res.status})`);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error('no mirror answered');
  }

  /**
   * Resolves a channel play URL through the mediahubmx mirrors into a proxied HLS stream.
   * @returns {Promise<StreamEntity[]>}
   */
  async resolveStream(sourceId, matchCategory, matchTitle, src = {}) {
    if (!this.isEnabled()) return [];
    const raw = src.id || sourceId;
    let playUrl;
    try {
      const parsed = new URL(raw);
      const host = parsed.hostname.toLowerCase();
      if (parsed.protocol !== 'https:' || !MIRROR_HOSTS.some((d) => host === d || host.endsWith(`.${d}`))) return [];
      const play = parsed.searchParams.get('live') || (parsed.pathname.match(/\/play\/([^/?#]+)/) || [])[1];
      playUrl = play ? `https://vavoo.to/vavoo-iptv/play/${play}` : raw;
    } catch (_) {
      return [];
    }

    try {
      const url = await this._resolveUrl(playUrl, src, matchTitle);
      const is4k = !!src.is4k || /4k|uhd/i.test(matchTitle);
      const tag = serverTag(src.channelName);
      const label = channelLabel(src.channelName || matchTitle);
      return [new StreamEntity({
        name: this.name,
        title: `Vavoo (${label}${src.group ? ` - ${src.group}` : ''})${tag ? ` [${tag}]` : ''}`,
        url: manifestProxyUrl({ url, referer: REFERER, origin: 'https://vavoo.to' }),
        behaviorHints: { notWebReady: true },
        resolution: is4k ? '4K' : '1080p',
      })];
    } catch (err) {
      console.warn(`[${this.name}] Stream resolution failed for "${matchTitle}":`, err.message);
      return [];
    }
  }
}

module.exports = VavooProvider;
module.exports.channelKey = channelKey;
module.exports.channelLabel = channelLabel;
module.exports.serverTag = serverTag;
