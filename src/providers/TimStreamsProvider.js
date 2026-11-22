const BaseProvider = require('./BaseProvider');
const { DEFAULT_UA } = BaseProvider;
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const DliveProvider = require('./DliveProvider');
const { decodePngSegment, isPng } = require('../services/PngSegmentDecoder');
const { manifestProxyUrl } = require('../proxyUrl');
const { parseTimezone } = require('../timezone');

const SITE = 'https://tim-streams.com';
const API_URL = `${SITE}/api/live-upcoming`;

/** The feed publishes kickoff times as zone-less wall-clock strings in US Eastern. */
const FEED_TIMEZONE = 'America/New_York';

/** Events that kicked off longer ago than this are over; the feed is a live/upcoming list. */
const MAX_LIVE_MS = 4 * 60 * 60 * 1000;

const M3U8_RE = /https?:\/\/[^"'<>\s\\]+\.m3u8[^"'<>\s\\]*/;

/** Bytes of a segment fetched to see whether it is plain MPEG-TS. */
const SEGMENT_PROBE_BYTES = 1024;

/**
 * tim-streams.com. The JSON feed lists events with per-broadcaster embed URLs.
 * An embed page hides its player script behind an XOR/subtract-encoded number
 * array; the decoded script names a ticket URL whose body (XOR-keyed with the
 * ticket id) is the signed manifest URL. Its CDN usually serves segments as
 * pixel-packed PNGs; those streams are flagged so the manifest proxy decodes
 * each segment back to MPEG-TS (see PngSegmentDecoder).
 */
class TimStreamsProvider extends BaseProvider {
  constructor(opts) {
    super(opts);
    this.name = 'TimStreams';
    this.sourceName = 'timstreams';
    this.apiUrl = API_URL;

    this.fetchEvents = this.circuitBreaker.wrap(`${this.name}_fetchEvents`, async () => {
      const res = await this.proxyFetch(this.apiUrl, {
        headers: { 'Accept': 'application/json' },
        timeoutMs: 15000,
      });
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      return await res.json();
    });
  }

  /** Genre id -> display name from the feed's `genres` table. */
  static genreName(genres, id) {
    if (!Array.isArray(genres)) return '';
    const hit = genres.find((g) => g && g.id === id);
    return hit && hit.name ? String(hit.name) : '';
  }

  async getMatches() {
    const matches = [];
    try {
      const data = await this.fetchEvents.fire();
      if (!data || !Array.isArray(data.events)) return [];
      const now = Date.now();

      for (const ev of data.events) {
        if (!ev || typeof ev !== 'object' || !ev.url || !ev.name) continue;

        const startMs = ev.time ? parseTimezone(ev.time, FEED_TIMEZONE) : 0;
        let status = 'upcoming';
        if (startMs > 0 && startMs <= now) {
          if (now - startMs > MAX_LIVE_MS) continue;
          status = 'live';
        }

        const sources = (Array.isArray(ev.streams) ? ev.streams : [])
          .filter((st) => st && !st.vip && typeof st.url === 'string' && /^https?:\/\//i.test(st.url))
          .map((st) => ({
            source: this.sourceName,
            id: st.url.replace(/^https?:\/\/[^/]+\//i, ''),
            channelName: this.formatChannelLabel(st.name),
            url: st.url,
          }));
        if (sources.length === 0) continue;

        const logo = typeof ev.logo === 'string' ? ev.logo : '';
        matches.push(new MatchEntity({
          id: `ts_${ev.url}`,
          title: ev.name,
          category: this.normalizeCategory(TimStreamsProvider.genreName(data.genres, ev.genre) || 'other'),
          date: startMs > 0 ? String(startMs) : '',
          status,
          popular: status === 'live' && ev.featured ? '1' : '0',
          poster: logo.startsWith('/') ? `${SITE}${logo}` : logo,
          sources,
        }));
      }
    } catch (err) {
      console.error(`[${this.name}] Failed to get matches:`, err.message);
    }
    return matches;
  }

  /**
   * Decodes the obfuscated script of an embed page: a number array decoded as
   * `((n ^ xor) - sub) mod 256`, with both constants assigned elsewhere in the page.
   *
   * @param {string} html
   * @returns {string|null}
   */
  static decodeObfuscatedScript(html) {
    const arrMatch = html.match(/var\s+\w+\s*=\s*\[([\d,\s]{100,})\]/);
    const loopMatch = html.match(/String\.fromCharCode\(\s*\(+[^^]+\^\s*(\w+)\s*\)\s*-\s*(\w+)\s*\+\s*256\s*\)\s*(?:%|&)\s*(?:256|255)\)/);
    if (!arrMatch || !loopMatch) return null;

    const xorMatch = html.match(new RegExp(`\\b${loopMatch[1]}\\s*=\\s*(\\d+)`));
    const subMatch = html.match(new RegExp(`\\b${loopMatch[2]}\\s*=\\s*(\\d+)`));
    if (!xorMatch || !subMatch) return null;

    const xor = parseInt(xorMatch[1], 10);
    const sub = parseInt(subMatch[1], 10);
    let out = '';
    for (const n of arrMatch[1].split(',')) {
      out += String.fromCharCode(((Number(n) ^ xor) - sub + 256) % 256);
    }
    return out;
  }

  /**
   * Decrypts a ticket body. Byte 0 seeds a rolling key; the rest is XORed with
   * the ticket id (last URL path segment) and that rolling key.
   *
   * @param {Buffer} body
   * @param {string} ticketUrl
   * @returns {string}
   */
  static decryptTicket(body, ticketUrl) {
    const key = ticketUrl.substring(ticketUrl.lastIndexOf('/') + 1);
    const seed = body[0];
    let out = '';
    for (let i = 1; i < body.length; i++) {
      out += String.fromCharCode(body[i] ^ key.charCodeAt((i - 1) % key.length) ^ ((seed + i - 1) & 255));
    }
    return out;
  }

  /**
   * Re-mints the signed manifest for an embed page.
   * Shape matches the StreamRenewal renewer contract.
   *
   * @param {string} embedUrl
   * @returns {Promise<{m3u8: string, referer: string}|null>}
   */
  async extractM3u8(embedUrl) {
    const res = await this.proxyFetch(embedUrl, {
      headers: { Referer: `${SITE}/` },
      timeoutMs: 15000,
    });
    if (!res.ok) return null;
    const decoded = TimStreamsProvider.decodeObfuscatedScript(await res.text());
    if (!decoded) return null;

    const referer = `${new URL(embedUrl).origin}/`;
    const direct = decoded.match(M3U8_RE);
    if (direct) return { m3u8: direct[0], referer };

    const ticket = decoded.match(/"ticketUrl"\s*:\s*"([^"]+)"/);
    if (!ticket) return null;
    const ticketUrl = ticket[1].replace(/\\\//g, '/');
    const tres = await fetch(ticketUrl, {
      headers: { 'User-Agent': DEFAULT_UA, Referer: referer, Origin: referer.replace(/\/$/, '') },
      signal: AbortSignal.timeout(10000),
    });
    if (!tres.ok) return null;
    const body = Buffer.from(await tres.arrayBuffer());
    if (body.length < 2) return null;
    const m3u8 = TimStreamsProvider.decryptTicket(body, ticketUrl).match(M3U8_RE);
    return m3u8 ? { m3u8: m3u8[0], referer } : null;
  }

  /**
   * Format of the manifest's first media segment: 'ts' for plain MPEG-TS,
   * 'png' for a pixel-packed PNG that decodes to MPEG-TS, null when the
   * segment is unreachable or neither (a master playlist is followed one level).
   *
   * @param {string} m3u8
   * @param {string} referer
   * @param {number} [depth]
   * @returns {Promise<'ts'|'png'|null>}
   */
  async segmentFormat(m3u8, referer, depth = 0) {
    try {
      const headers = { 'User-Agent': DEFAULT_UA, Referer: referer };
      const res = await this.proxyFetch(m3u8, { headers, timeoutMs: 10000 });
      if (!res.ok) return null;
      const body = await res.text();
      if (!body.includes('#EXTM3U')) return null;
      const first = body.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
      if (!first) return null;
      const target = new URL(first, m3u8).toString();
      if (body.includes('#EXT-X-STREAM-INF')) {
        return depth < 1 ? await this.segmentFormat(target, referer, depth + 1) : null;
      }
      const seg = await fetch(target, { headers, signal: AbortSignal.timeout(15000) });
      if (!seg.ok) return null;
      const bytes = Buffer.from(await seg.arrayBuffer());
      if (isPng(bytes)) {
        const ts = decodePngSegment(bytes);
        return ts.length > 2 * 188 && ts[0] === 0x47 && ts[188] === 0x47 ? 'png' : null;
      }
      return DliveProvider.tsOffset(bytes.subarray(0, SEGMENT_PROBE_BYTES)) >= 0 ? 'ts' : null;
    } catch (_) {
      return null;
    }
  }

  /** Strips brackets so the label cannot break first-parentheses channel extraction downstream. */
  formatChannelLabel(raw) {
    if (typeof raw !== 'string') return '';
    return raw.replace(/[()[\]]/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 60);
  }

  async resolveStream(sourceId, matchCategory, matchTitle, src = {}) {
    const embedUrl = src.url || '';
    if (!/^https?:\/\//i.test(embedUrl)) return [];

    const label = this.formatChannelLabel(src.channelName);
    const title = label ? `${matchTitle} (${label})` : matchTitle;
    const webPlayer = () => new StreamEntity({
      name: this.name,
      title: `${title} (Web Player)`,
      externalUrl: `/watch?url=${encodeURIComponent(embedUrl)}&title=${encodeURIComponent(matchTitle || 'Live Event')}`,
    });

    let extracted = null;
    try {
      extracted = await this.extractM3u8(embedUrl);
    } catch (err) {
      console.warn(`[${this.name}] extraction failed for ${embedUrl}:`, err.message);
    }
    if (!extracted) return [webPlayer()];
    const format = await this.segmentFormat(extracted.m3u8, extracted.referer);
    if (!format) return [webPlayer()];

    const url = manifestProxyUrl({
      url: extracted.m3u8,
      referer: extracted.referer,
      renew: this.sourceName,
      embed: embedUrl,
      proxySegments: format === 'png',
    });

    return [new StreamEntity({
      name: this.name,
      title,
      url,
      behaviorHints: { notWebReady: true },
      resolution: 'HD',
    })];
  }
}

module.exports = TimStreamsProvider;
