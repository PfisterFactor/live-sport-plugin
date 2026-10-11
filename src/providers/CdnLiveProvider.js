const BaseProvider = require('./BaseProvider');
const { DEFAULT_UA } = BaseProvider;
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const { parseTimezone } = require('../timezone');

const EXCLUDE_KEYS = ['total_events', 'cached', 'timestamp'];

/**
 * Shared client for the cdnlivetv API family. Behavior is driven entirely by
 * the variant config passed to the constructor (see CdnLiveProvider.VARIANTS).
 */
class CdnLiveProvider extends BaseProvider {
  constructor(opts, config) {
    super(opts);
    this.config = config;
    this.name = config.name;
    this.apiUrl = config.apiUrl;
    this.apiUrls = [config.apiUrl, ...(config.fallbackApiUrls || [])];

    // Both API hosts serve the same event feed, so a dead or rate-limited
    // endpoint falls through to the next instead of emptying the catalog.
    this.fetchMain = this.circuitBreaker.wrap(`${this.name}_fetchMain`, async () => {
      let lastErr = null;
      for (const url of this.apiUrls) {
        try {
          const res = await this.proxyFetch(url, {
            headers: { 'User-Agent': DEFAULT_UA },
            timeoutMs: 20000,
          });
          if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
          return await res.json();
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr || new Error('no sports events host answered');
    });
  }

  /**
   * Yield [categoryKey, events[]] pairs the variant cares about.
   */
  *_eventGroups(data) {
    const sportsData = data?.['cdn-live-tv'] || {};
    if (!this.config.allCategories) {
      const soccer = sportsData['Soccer'] || sportsData['Football'] || [];
      if (Array.isArray(soccer)) yield ['Soccer', soccer];
      return;
    }
    for (const key of Object.keys(sportsData)) {
      if (EXCLUDE_KEYS.includes(key) || key.startsWith('total_events_')) continue;
      const events = sportsData[key];
      if (Array.isArray(events)) yield [key, events];
    }
  }

  _titleOf(item) {
    if (this.config.allCategories) {
      return item.name || `${item.homeTeam || ''} vs ${item.awayTeam || ''}`.trim();
    }
    return `${item.homeTeam || ''} vs ${item.awayTeam || ''}`;
  }

  _genId(item, title) {
    const base = this.config.allCategories ? title : `${item.homeTeam}-vs-${item.awayTeam}`;
    return base.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  }

  _idOf(item, title) {
    return item.gameID || this._genId(item, title);
  }

  async getMatches() {
    const matches = [];
    try {
      const data = await this.fetchMain.fire();
      const { idPrefix, sourceKey, allCategories, timeWindow } = this.config;

      for (const [key, events] of this._eventGroups(data)) {
        for (const item of events) {
          const title = this._titleOf(item);
          if (allCategories && (!title || title === 'vs')) continue;

          const matchId = this._idOf(item, title);
          const status = (item.status === 'live' || item.status === 'in') ? 'live' : 'upcoming';
          const matchTime = (item.start ? parseTimezone(item.start, 'UTC') : null) ?? Date.now();

          // Far-out fixtures never get channels and resolve to nothing.
          // Live-flagged events are always kept (clock-skew tolerant).
          if (timeWindow && item.start && Number.isFinite(matchTime) && status !== 'live') {
            const now = Date.now();
            if (matchTime < now - timeWindow.pastMs || matchTime > now + timeWindow.futureMs) continue;
          }

          const fields = {
            id: `${idPrefix}${matchId}`,
            title,
            category: allCategories ? this.normalizeCategory(key) : 'football',
            status,
            timestamp: matchTime,
            sources: [{ source: sourceKey, id: matchId }],
          };

          if (allCategories) {
            Object.assign(fields, {
              date: matchTime.toString(),
              popular: status === 'live' ? '1' : '0',
              league: item.tournament || key,
              team1: { name: item.homeTeam, logo: item.homeTeamIMG },
              team2: { name: item.awayTeam, logo: item.awayTeamIMG },
              thumbnail_url: item.homeTeamIMG || item.awayTeamIMG || '',
            });
          }

          matches.push(new MatchEntity(fields));
        }
      }
    } catch (err) {
      console.error(`[${this.name}] Failed to get matches:`, err.message);
    }
    return matches;
  }

  /** Decode one URL-safe base64 fragment of an obfuscated player URL. */
  _decodeB64Part(part) {
    let b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    try { return Buffer.from(b64, 'base64').toString('utf8'); } catch (_) { return ''; }
  }

  /**
   * Scrape the obfuscated m3u8 URL out of a player page. Player pages come in
   * three shapes, tried in order: `var x = atob('..') + atob('..')`, a decoder
   * function applied to base64 variables, and a plain URL in the markup.
   */
  _extractM3u8FromPlayerHtml(html) {
    let m3u8Url = '';

    const direct = html.match(/var\s+[a-zA-Z0-9_]+\s*=\s*(atob\([^;]+;)/);
    if (direct) {
      const parts = /atob\s*\(\s*["']([^"']+)["']\s*\)/g;
      let p;
      while ((p = parts.exec(direct[1])) !== null) m3u8Url += this._decodeB64Part(p[1]);
    }

    if (!m3u8Url) {
      const decoderMatch = html.match(/function\s+([a-zA-Z0-9_]+)\s*\([a-zA-Z0-9_]+\)\s*\{[\s\S]{0,300}?atob/);
      if (decoderMatch) {
        const decoderName = decoderMatch[1];
        const concatMatch = html.match(new RegExp(`var\\s+([a-zA-Z0-9_]+)\\s*=\\s*${decoderName}\\([^;]+;`));
        if (concatMatch) {
          const varRegex = new RegExp(`${decoderName}\\(([a-zA-Z0-9_]+)\\)`, 'g');
          let match;
          while ((match = varRegex.exec(concatMatch[0])) !== null) {
            const valMatch = html.match(new RegExp(`var\\s+${match[1]}\\s*=\\s*(?:'([^']+)'|"([^"]+)")`));
            if (valMatch) m3u8Url += this._decodeB64Part(valMatch[1] || valMatch[2]);
          }
        }
      }
    }

    if (!m3u8Url) {
      const plain = html.match(/(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/i);
      if (plain) m3u8Url = plain[1];
    }
    return m3u8Url.includes('.m3u8') ? m3u8Url : '';
  }

  /** The player page on the sibling mirror (.tv <-> .is), or the page itself when it has none. */
  _playerMirrors(playerUrl) {
    const urls = [playerUrl];
    if (playerUrl.includes('cdnlivetv.tv')) urls.push(playerUrl.replace('cdnlivetv.tv', 'cdnlivetv.is'));
    else if (playerUrl.includes('cdnlivetv.is')) urls.push(playerUrl.replace('cdnlivetv.is', 'cdnlivetv.tv'));
    return urls;
  }

  /** Try each player mirror until one yields a manifest URL. */
  async _decodePlayer(playerUrl, refererOrigin) {
    for (const url of this._playerMirrors(playerUrl)) {
      try {
        const res = await this.proxyFetch(url, {
          headers: { 'User-Agent': DEFAULT_UA, 'Referer': `${refererOrigin}/` },
          timeoutMs: 10000,
        });
        if (!res.ok) continue;
        const m3u8Url = this._extractM3u8FromPlayerHtml(await res.text());
        if (m3u8Url) return m3u8Url;
      } catch (e) {
        console.warn(`[${this.name}] Failed to extract m3u8 for ${url}:`, e.message);
      }
    }
    return '';
  }

  _findItem(data, sourceId) {
    for (const [, events] of this._eventGroups(data)) {
      const found = events.find((e) => {
        if (e.gameID === sourceId) return true;
        return this._genId(e, this._titleOf(e)) === sourceId;
      });
      if (found) return found;
    }
    return null;
  }

  async resolveStream(sourceId, matchCategory, matchTitle) {
    const streams = [];
    const { refererOrigin, streamLabel } = this.config;
    try {
      const data = await this.fetchMain.fire();
      const item = this._findItem(data, sourceId);

      if (item && Array.isArray(item.channels)) {
        for (const [idx, ch] of item.channels.entries()) {
          if (!ch.url) continue;
          const m3u8Url = await this._decodePlayer(ch.url, refererOrigin);
          if (m3u8Url) {
            streams.push(new StreamEntity({
              name: this.name,
              title: ch.channel_name || `${streamLabel} ${idx + 1}`,
              url: m3u8Url,
              behaviorHints: {
                notWebReady: true,
                proxyHeaders: {
                  request: {
                    'Origin': refererOrigin,
                    'Referer': `${refererOrigin}/`,
                    'User-Agent': DEFAULT_UA,
                  },
                },
              },
              resolution: 'HD',
            }));
            continue;
          }

          streams.push(new StreamEntity({
            name: this.name,
            title: ch.channel_name || `${streamLabel} ${idx + 1} (Web Player)`,
            externalUrl: ch.url,
            resolution: 'HD',
          }));
        }
      }
    } catch (err) {
      console.error(`[${this.name}] resolveStream failed for ${sourceId}:`, err.message);
    }
    return streams;
  }
}

CdnLiveProvider.VARIANTS = {
  cdnlive: {
    name: 'CDNLiveTV',
    apiUrl: 'https://api.cdnlivetv.tv/api/v1/events/sports/?user=cdnlivetv&plan=free',
    sourceKey: 'cdnlive',
    idPrefix: 'cdn_',
    refererOrigin: 'https://cdnlivetv.tv',
    streamLabel: 'CDNLive Stream',
    allCategories: false,
    fallbackApiUrls: ['https://api.cdnlivetv.is/api/v1/events/sports/?user=streamsports99&plan=vip'],
  },
  streamsports99: {
    name: 'StreamSports99',
    apiUrl: 'https://api.cdnlivetv.is/api/v1/events/sports/?user=streamsports99&plan=vip',
    sourceKey: 'streamsports99',
    idPrefix: 'ss99_',
    refererOrigin: 'https://streamsports99.is',
    streamLabel: 'VIP Stream',
    allCategories: true,
    // Upstream lists fixtures days ahead that never get channels.
    timeWindow: { pastMs: 6 * 60 * 60 * 1000, futureMs: 48 * 60 * 60 * 1000 },
    fallbackApiUrls: ['https://api.cdnlivetv.tv/api/v1/events/sports/?user=cdnlivetv&plan=free'],
  },
};

module.exports = CdnLiveProvider;
