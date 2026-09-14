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

    this.fetchMain = this.circuitBreaker.wrap(`${this.name}_fetchMain`, async () => {
      const res = await this.proxyFetch(this.apiUrl, {
        headers: { 'User-Agent': DEFAULT_UA },
        timeoutMs: 20000,
      });
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      return await res.json();
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

  /**
   * Scrape the obfuscated atob()-concatenated m3u8 URL out of a player page.
   */
  _extractM3u8FromPlayerHtml(html) {
    const decoderMatch = html.match(/function\s+([a-zA-Z0-9_]+)\s*\([a-zA-Z0-9_]+\)\s*\{.+?atob/);
    if (!decoderMatch) return '';
    const decoderName = decoderMatch[1];
    const concatMatch = html.match(new RegExp(`var\\s+([a-zA-Z0-9_]+)\\s*=\\s*${decoderName}\\([^;]+;`));
    if (!concatMatch) return '';

    const varRegex = new RegExp(`${decoderName}\\(([a-zA-Z0-9_]+)\\)`, 'g');
    const vars = [];
    let match;
    while ((match = varRegex.exec(concatMatch[0])) !== null) vars.push(match[1]);

    let m3u8Url = '';
    for (const v of vars) {
      const valMatch = html.match(new RegExp(`var\\s+${v}\\s*=\\s*(?:'([^']+)'|"([^"]+)")`));
      if (!valMatch) continue;
      let b64 = (valMatch[1] || valMatch[2]).replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      try { m3u8Url += Buffer.from(b64, 'base64').toString('utf8'); } catch (_) {}
    }
    return m3u8Url;
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
          try {
            const playerRes = await this.proxyFetch(ch.url, {
              headers: { 'User-Agent': DEFAULT_UA, 'Referer': `${refererOrigin}/` },
              timeoutMs: 10000,
            });

            if (playerRes.status >= 200 && playerRes.status < 300) {
              const m3u8Url = this._extractM3u8FromPlayerHtml(await playerRes.text());
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
            }
          } catch (e) {
            console.warn(`[${this.name}] Failed to extract m3u8 for ${ch.url}:`, e.message);
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
  },
  streamsports99: {
    name: 'StreamSports99',
    apiUrl: 'https://api.cdnlivetv.is/api/v1/events/sports/?user=streamsports99&plan=vip',
    sourceKey: 'streamsports99',
    idPrefix: 'ss99_',
    refererOrigin: 'https://streamsports99.fun',
    streamLabel: 'VIP Stream',
    allCategories: true,
    // Upstream lists fixtures days ahead that never get channels.
    timeWindow: { pastMs: 6 * 60 * 60 * 1000, futureMs: 48 * 60 * 60 * 1000 },
  },
};

module.exports = CdnLiveProvider;
