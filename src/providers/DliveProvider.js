const BaseProvider = require('./BaseProvider');
const { DEFAULT_UA } = BaseProvider;
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const { parseTimezone } = require('../timezone');
const { manifestProxyUrl } = require('../proxyUrl');

/**
 * dlive.sx (DaddyLiveHD). The daily schedule is plain HTML; every event lists
 * channel links of the form /watch.php?id=<N>.
 *
 * A channel page carries ~635 KB of obfuscated ad code around one plain
 * iframe pointing at the real player host. That embed page holds the stream
 * config in `window._econfig`, encoded as: base64 -> split into 4 equal
 * chunks -> drop the 4th character of each chunk -> base64-decode each ->
 * reassemble in the order [2,0,3,1] -> base64 -> JSON.
 *
 * The signed manifest token is short-lived and bound to the requesting IP,
 * so streams are handed to the player through the manifest proxy with a
 * renewal descriptor (see services/StreamRenewal.js).
 */
class DliveProvider extends BaseProvider {
  constructor(opts) {
    super(opts);
    this.name = 'DaddyLive';
    this.baseUrl = 'https://dlive.sx';

    this.fetchSchedule = this.circuitBreaker.wrap(`${this.name}_fetchSchedule`, async () => {
      const res = await this.proxyFetch(`${this.baseUrl}/index.php`, {
        headers: { 'User-Agent': DEFAULT_UA },
        timeoutMs: 20000,
      });
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      return await res.text();
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
  async getMatches() {
    const matches = [];
    try {
      const html = await this.fetchSchedule.fire();
      const events = this._parseSchedule(html);

      for (const ev of events) {
        const kickoff = ev.dayDate && ev.time
          ? parseTimezone(`${ev.dayDate} ${ev.time}`, 'Europe/London')
          : null;
        const startsMs = typeof kickoff === 'number' ? kickoff : NaN;

        matches.push(new MatchEntity({
          id: `dl_${Buffer.from(`${ev.dayDate}|${ev.time}|${ev.title}`).toString('base64url').slice(0, 40)}`,
          title: ev.title,
          category: this._mapCategory(ev.categoryName, ev.title),
          status: Number.isFinite(startsMs) && startsMs > Date.now() ? 'upcoming' : 'live',
          date: Number.isFinite(startsMs) ? String(startsMs) : '',
          popular: '0',
          league: ev.categoryName,
          sources: [{
            source: 'dlive',
            id: ev.channels.map(c => c.id).join(','),
            names: ev.channels.map(c => c.name),
          }],
        }));
      }
    } catch (err) {
      console.error(`[${this.name}] Failed to get matches:`, err.message);
    }
    return matches;
  }

  /** Player host iframe embedded in a channel page, or null when absent. */
  async _playerEmbedUrl(channelId) {
    const res = await this.proxyFetch(`${this.baseUrl}/stream/stream-${encodeURIComponent(channelId)}.php`, {
      headers: {
        'User-Agent': DEFAULT_UA,
        'Referer': `${this.baseUrl}/watch.php?id=${encodeURIComponent(channelId)}`,
      },
      timeoutMs: 15000,
    });
    if (!res.ok) return null;
    const html = await res.text();
    const match = html.match(/<iframe[^>]+src="(https?:\/\/[^"]+)"/i);
    return match ? match[1] : null;
  }

  /**
   * Decode the embed page's `window._econfig` payload. Throws on malformed
   * input so callers can fall back to the web player.
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

  /**
   * Re-mints the signed manifest for an embed page.
   * Shape matches the StreamRenewal renewer contract.
   */
  async extractM3u8(embedUrl) {
    const res = await this.proxyFetch(embedUrl, {
      headers: { 'User-Agent': DEFAULT_UA, 'Referer': `${this.baseUrl}/` },
      timeoutMs: 15000,
    });
    if (!res.ok) return null;

    const html = await res.text();
    const encoded = html.match(/_econfig\s*=\s*'([A-Za-z0-9+/=]+)'/);
    if (!encoded) return null;

    let config;
    try {
      config = DliveProvider.decodeEmbedConfig(encoded[1]);
    } catch (err) {
      console.error(`[${this.name}] embed config decode failed for ${embedUrl}:`, err.message);
      return null;
    }

    const m3u8 = config && (config.stream_url_nop2p || config.stream_url);
    if (!m3u8) return null;
    return { m3u8, referer: `${new URL(embedUrl).origin}/` };
  }

  async resolveStream(sourceId, matchCategory, matchTitle, src = {}) {
    const ids = String(sourceId).split(',').filter(Boolean).slice(0, DliveProvider.MAX_CHANNELS);
    const names = Array.isArray(src.names) ? src.names : [];

    const resolved = await Promise.all(ids.map(async (id, idx) => {
      const label = names[idx] || `Source ${idx + 1}`;
      try {
        const embedUrl = await this._playerEmbedUrl(id);
        if (embedUrl) {
          const extracted = await this.extractM3u8(embedUrl);
          if (extracted) {
            return new StreamEntity({
              name: this.name,
              title: `${matchTitle} (${label})`,
              url: manifestProxyUrl({
                url: extracted.m3u8,
                referer: extracted.referer,
                renew: 'dlive',
                embed: embedUrl,
              }),
              behaviorHints: { notWebReady: true },
              resolution: 'HD',
            });
          }
        }
      } catch (err) {
        console.error(`[${this.name}] resolveStream failed for channel ${id}:`, err.message);
      }
      return new StreamEntity({
        name: this.name,
        title: `${matchTitle} (${label}) (Web Player)`,
        externalUrl: `${this.baseUrl}/watch.php?id=${encodeURIComponent(id)}`,
      });
    }));

    return resolved;
  }
}

/** Channels resolved per event; events can list a dozen, each costing two fetches. */
DliveProvider.MAX_CHANNELS = 4;

module.exports = DliveProvider;
