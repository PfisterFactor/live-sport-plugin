const crypto = require('crypto');
const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const { extractTeamsFromTitle } = require('../services/TeamNameExtractor');

const SITE = 'https://mlblive.net';
const LISTING_PAGES = [`${SITE}/2026-mlb-full-game-replays`, `${SITE}/world-series-replays`];
const OK_QUALITY = { full: '1080p', hd: '720p', sd: '480p', low: '360p', lowest: '240p', mobile: '144p' };
const STREAM_CACHE_TTL_MS = 30 * 60 * 1000;

const MONTHS = /(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}/i;

/** Decodes the few HTML entities that appear in link text. */
function textOf(html) {
  return String(html).replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

/** True for hosts of the Byse video player family (bysesukior.com, ...). */
function isByseHost(host) {
  return /(?:^|\.)byse[a-z0-9]*\.[a-z]+$/i.test(host);
}

/**
 * Decrypts a Byse playback payload (AES-256-GCM). The key is two base64 key
 * parts chosen by the payload version; returns the parsed JSON or null.
 */
function decryptByse(playback) {
  if (!playback || !playback.payload || !playback.iv || !Array.isArray(playback.key_parts)) return null;
  try {
    let parts = playback.key_parts;
    const version = parseInt(playback.version, 10);
    if (version >= 1 && version <= 20 && playback.key_parts[version - 1] && playback.key_parts[30 - version]) {
      parts = [playback.key_parts[version - 1], playback.key_parts[30 - version]];
    }
    const key = Buffer.concat(parts.map((p) => Buffer.from(p, 'base64')));
    if (key.length !== 32) return null;
    const payload = Buffer.from(playback.payload, 'base64');
    if (payload.length < 16) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(playback.iv, 'base64'));
    decipher.setAuthTag(payload.subarray(payload.length - 16));
    const plain = Buffer.concat([decipher.update(payload.subarray(0, payload.length - 16)), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
  } catch (_) {
    return null;
  }
}

/**
 * mlblive.net MLB full-game replays (regular season, playoffs, World Series).
 * A replay page links player embeds (OK.ru, Byse); each is resolved to direct
 * MP4/HLS URLs.
 */
class MlbLiveProvider extends BaseProvider {
  /**
   * @param {object} opts  provider cradle ({ circuitBreaker })
   */
  constructor(opts) {
    super(opts);
    this.name = 'MLBLive';
    this.sourceName = 'mlblive';
    this._streams = new Map();

    this.fetchPage = this.circuitBreaker.wrap(`${this.name}_fetchPage`, async (url, headers = {}) => {
      const res = await this.proxyFetch(url, { headers: { Referer: `${SITE}/`, ...headers }, timeoutMs: 10000 });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    });
  }

  /** Replay cards from a listing page. */
  _parseListing(html) {
    const out = [];
    const seen = new Set();
    for (const m of html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
      const href = m[1].trim();
      const title = textOf(m[2]);
      const lowerTitle = title.toLowerCase();
      const lowerUrl = href.toLowerCase();
      const isGame = lowerTitle.includes(' @ ') || lowerTitle.includes(' vs ') || lowerTitle.includes(' vs. ') || lowerUrl.includes('-vs-') ||
        lowerTitle.includes('all-star') || lowerTitle.includes('home run derby') || lowerTitle.includes('world series game');
      if (!isGame || title.length < 5 || seen.has(href) || /-replays$/.test(lowerUrl) || /-{2,}$/.test(href)) continue;
      seen.add(href);

      const url = href.startsWith('http') ? href : `${SITE}${href.startsWith('/') ? '' : '/'}${href}`;
      const dateText = (title.match(MONTHS) || [])[0];
      const parsed = dateText ? new Date(`${dateText} 12:00:00 UTC`) : null;
      let league = 'MLB';
      if (/world series/.test(lowerTitle)) league = 'MLB World Series';
      else if (/all-star/.test(lowerTitle)) league = 'MLB All-Star';
      else if (/nlcs|alcs|division series|wild card|playoff/.test(lowerTitle)) league = 'MLB Playoffs';

      const teams = extractTeamsFromTitle(title.replace(/\s+-\s+MLB.*$/i, '').replace(/\s+@\s+/, ' vs '));
      out.push(new MatchEntity({
        id: `mlb_${url.replace(/^https?:\/\/[^/]+\//, '').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80)}`,
        title,
        category: 'baseball',
        league,
        date: parsed && !isNaN(parsed) ? String(parsed.getTime()) : '',
        status: 'finished',
        team1: teams ? { name: teams[0] } : null,
        team2: teams ? { name: teams[1] } : null,
        sources: [{ source: this.sourceName, id: url, url }],
      }));
    }
    return out;
  }

  /**
   * Replay cards from the 2026 season and World Series listing pages.
   * @returns {Promise<MatchEntity[]>}
   */
  async getMatches() {
    const byId = new Map();
    for (const page of LISTING_PAGES) {
      try {
        for (const m of this._parseListing(await this.fetchPage.fire(page))) if (!byId.has(m.id)) byId.set(m.id, m);
      } catch (err) {
        console.warn(`[${this.name}] Failed to fetch ${page}:`, err.message);
      }
    }
    return [...byId.values()];
  }

  /**
   * OK.ru embed -> HLS manifest first, then MP4 qualities. Every URL is bound to the
   * server's public IP (`srcIp`), so playback from another network fails; the addon has no byte proxy to fix that.
   */
  async _okRu(embedUrl, part) {
    let url = embedUrl.startsWith('//') ? `https:${embedUrl}` : embedUrl;
    url = url.replace('/video/', '/videoembed/');
    const html = await this.fetchPage.fire(url);
    const options = (html.match(/data-options="([^"]+)"/i) || [])[1];
    if (!options) return [];
    const parsed = JSON.parse(options.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
    let meta = parsed.flashvars && parsed.flashvars.metadata;
    if (typeof meta === 'string') meta = JSON.parse(meta);
    if (!meta) return [];

    const headers = { request: { 'User-Agent': BaseProvider.DEFAULT_UA, Referer: 'https://ok.ru/' } };
    const streams = (Array.isArray(meta.videos) ? meta.videos : []).filter((v) => v.url).map((v) => {
      const label = OK_QUALITY[v.name] || v.name || 'HD';
      return new StreamEntity({
        name: this.name, title: `${part} (${label}) [OK.ru]`, url: v.url, resolution: label,
        behaviorHints: { notWebReady: false, proxyHeaders: headers },
      });
    });
    if (meta.hlsManifestUrl) {
      streams.unshift(new StreamEntity({
        name: this.name, title: `${part} (Auto HLS) [OK.ru]`, url: meta.hlsManifestUrl, resolution: 'Auto',
        behaviorHints: { notWebReady: false, proxyHeaders: headers },
      }));
    }
    return streams;
  }

  /** Byse embed -> decrypted SprintCDN sources. */
  async _byse(embedUrl, part) {
    const { host, pathname } = new URL(embedUrl);
    const code = pathname.split('/').filter(Boolean).pop();
    const res = await this.proxyFetch(`https://${host}/api/videos/${code}/`, {
      headers: { Referer: `https://${host}/e/${code}`, Origin: `https://${host}`, Accept: 'application/json' },
      timeoutMs: 10000,
    });
    if (!res.ok) return [];
    const decrypted = decryptByse((await res.json()).playback);
    if (!decrypted || !Array.isArray(decrypted.sources)) return [];
    return decrypted.sources.filter((s) => s.url).map((s) => {
      const label = s.label || (s.height ? `${s.height}p` : '1080p');
      return new StreamEntity({
        name: this.name, title: `${part} (${label}) [SprintCDN]`, url: s.url, resolution: label,
        behaviorHints: {
          notWebReady: false,
          proxyHeaders: { request: { Origin: `https://${host}`, Referer: `https://${host}/`, 'User-Agent': BaseProvider.DEFAULT_UA } },
        },
      });
    });
  }

  /**
   * Streams of one replay page: OK.ru and Byse embeds, cached for 30 minutes.
   * @returns {Promise<StreamEntity[]>}
   */
  async resolveStream(sourceId, matchCategory, matchTitle, src = {}) {
    const pageUrl = sourceId || src.url;
    if (!pageUrl) return [];
    const cached = this._streams.get(pageUrl);
    if (cached && cached.expiresAt > Date.now()) return cached.streams;

    const streams = [];
    try {
      const html = await this.fetchPage.fire(pageUrl);
      const body = (html.match(/<!--\s*<body>\s*-->([\s\S]*?)<!--\s*<\/body>\s*-->/i) || [null, html])[1];
      const embeds = [];
      for (const m of body.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
        if (/ok\.ru|byse/i.test(m[1])) embeds.push({ url: m[1], part: textOf(m[2]) });
      }
      for (const m of body.matchAll(/<iframe[^>]+src="([^"]+)"/gi)) embeds.push({ url: m[1], part: '' });

      const seen = new Set();
      for (let i = 0; i < embeds.length; i++) {
        let target;
        try { target = new URL(embeds[i].url.startsWith('//') ? `https:${embeds[i].url}` : embeds[i].url, pageUrl); } catch (_) { continue; }
        if (!/^https?:$/.test(target.protocol) || seen.has(target.href)) continue;
        seen.add(target.href);
        const part = embeds[i].part || `Part ${i + 1}`;
        try {
          if (/(?:^|\.)ok\.ru$/.test(target.hostname)) streams.push(...await this._okRu(target.href, part));
          else if (isByseHost(target.hostname)) streams.push(...await this._byse(target.href, part));
        } catch (err) {
          console.warn(`[${this.name}] ${target.hostname} extraction failed:`, err.message);
        }
      }
    } catch (err) {
      console.error(`[${this.name}] resolveStream failed for ${pageUrl}:`, err.message);
      return [];
    }

    if (streams.length) {
      if (this._streams.size >= 200) this._streams.delete(this._streams.keys().next().value);
      this._streams.set(pageUrl, { streams, expiresAt: Date.now() + STREAM_CACHE_TTL_MS });
    }
    return streams;
  }
}

module.exports = MlbLiveProvider;
module.exports.decryptByse = decryptByse;
