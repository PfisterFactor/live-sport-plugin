const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const { extractTeamsFromTitle } = require('../services/TeamNameExtractor');
const { manifestProxyUrl } = require('../proxyUrl');

const SITE = 'https://pitsport.st';
const WATCH_API_URL = 'https://api.embdlol.st/watch';
const EMBED_REFERER = 'https://embdlol.st/';
const EMBED_ORIGIN = 'https://embdlol.st';

const SITE_HEADERS = { Referer: `${SITE}/`, Origin: SITE, Accept: 'application/json' };

/** Series names whose title spelling differs from the feed footer ("Formula 1" vs "F1"). */
const SERIES_ALIASES = [
  /\b(?:formula\s*1|f1)\b/i, /\bmotogp\b/i, /\bmoto\s*[23]\b/i, /\bnascar\b/i, /\bindycar\b/i,
  /\bsupercars?\b/i, /\bdtm\b/i, /\b(?:wsbk|superbike)\b/i, /\b(?:wrc|rally)\b/i,
];

/** Pulls the embdlol watch id out of an embed URL such as https://embdlol.st/embed/<uuid>. */
function watchIdOf(embedUrl) {
  const m = String(embedUrl).match(/(?:\/embed\/|\/watch\/|\bv=|\bwatchId=)([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

/**
 * pitsport.st: motorsport (and some football, darts, ...) schedule. Each
 * program lists embdlol.st embeds; the embdlol watch API turns an embed's
 * watch id into a signed HLS manifest.
 */
class PitSportProvider extends BaseProvider {
  /**
   * @param {object} opts  provider cradle ({ circuitBreaker })
   */
  constructor(opts) {
    super(opts);
    this.name = 'PitSport';
    this.sourceName = 'pitsport';

    this.fetchHome = this.circuitBreaker.wrap(`${this.name}_fetchHome`, async () => {
      const res = await this.proxyFetch(`${SITE}/api/v1/home`, { headers: SITE_HEADERS, timeoutMs: 15000 });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    });
  }

  /** Motorsport titles lead with the series so "Qualifying" alone is not ambiguous. */
  _displayTitle(title, category, item) {
    if (category !== 'motorsport') return title;
    const series = (item.footer || (item.competitionSlug ? item.competitionSlug.toUpperCase() : '')).trim();
    if (!series || /^(?:pitsport|motorsport|motor\s*sport|racing)$/i.test(series)) return title;
    const escaped = series.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?:^|[^a-zA-Z0-9])${escaped}(?:[^a-zA-Z0-9]|$)`, 'i').test(title)) return title;
    const aliased = SERIES_ALIASES.some((re) => re.test(series) && re.test(title));
    return aliased ? title : `${series}: ${title}`;
  }

  /** Fork category for a feed item; college and motorsport are detected before the generic mapping. */
  _category(item, title) {
    const context = `${item.competitionSlug || ''} ${item.footer || ''} ${title}`.toLowerCase();
    if (/\b(?:ncaa|college|ncaab|ncaaf)\b/.test(context)) return 'college';
    const slug = String(item.competitionSlug || item.footer || '').toLowerCase();
    if (/formula|rally|supercar|motocross|karting|motor/.test(slug) || /formula\s*1|\bf1\b|motogp|nascar|indycar/i.test(title)) {
      return 'motorsport';
    }
    return this.mapCategoryLabel(slug);
  }

  /**
   * Live and upcoming programs from the pitsport.st home feed.
   * @returns {Promise<MatchEntity[]>}
   */
  async getMatches() {
    const matches = [];
    try {
      const json = await this.fetchHome.fire();
      const data = json && json.data;
      if (!data) return matches;

      const seen = new Set();
      const now = Date.now();
      for (const item of [...(data.live || []), ...(data.upcoming || []), ...(data.carousel || [])]) {
        if (!item || !item.programId || seen.has(item.programId)) continue;
        seen.add(item.programId);

        const title = (item.titleText || (Array.isArray(item.title) && item.title[0] && item.title[0].text) || item.slug || '').trim();
        if (!title) continue;

        const category = this._category(item, title);
        const slug = String(item.slug || title).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50).replace(/^-|-$/g, '');

        const startSec = Number(item.sessionStart);
        const startMs = startSec > 0 ? (startSec < 1e11 ? startSec * 1000 : startSec) : 0;
        const live = item.liveState === 'live' || (startMs > 0 && startMs <= now);

        const teams = extractTeamsFromTitle(title);
        const artwork = category === 'motorsport' ? (item.background || '') : '';
        const programId = String(item.programId);

        matches.push(new MatchEntity({
          id: `pitsport_${programId}_${slug}`,
          title: this._displayTitle(title, category, item),
          category,
          date: startMs ? String(startMs) : '',
          status: live ? 'live' : 'upcoming',
          league: item.footer || (item.competitionSlug ? item.competitionSlug.toUpperCase() : 'PitSport'),
          logo: item.logo || '',
          thumbnail_url: artwork,
          poster: artwork,
          team1: teams ? { name: teams[0] } : null,
          team2: teams ? { name: teams[1] } : null,
          sources: [{ source: this.sourceName, id: programId, programId }],
        }));
      }
    } catch (err) {
      console.error(`[${this.name}] Failed to get matches:`, err.message);
    }
    return matches;
  }

  /** Signed HLS manifest for one embdlol embed, as { m3u8, referer, channel }, or null. */
  async extractM3u8(embedUrl) {
    const watchId = watchIdOf(embedUrl);
    if (!watchId) return null;
    const res = await this.proxyFetch(WATCH_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: EMBED_ORIGIN,
        Referer: EMBED_REFERER,
        Accept: 'application/json',
      },
      body: JSON.stringify({ watchId }),
      timeoutMs: 10000,
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (!json || typeof json.url !== 'string' || !json.url.trim()) return null;
    return {
      m3u8: json.url.trim(),
      referer: EMBED_REFERER,
      channel: (json.channel && json.channel.channelname) || '',
    };
  }

  /**
   * One stream per embdlol embed of the program: a renewable proxied HLS manifest, or a web player when the watch API refuses.
   * @returns {Promise<StreamEntity[]>}
   */
  async resolveStream(sourceId, matchCategory, matchTitle, src = {}) {
    const streams = [];
    const programId = String((src && src.programId) || sourceId || '').replace(/^pitsport_(\d+).*$/, '$1');
    if (!programId) return streams;

    try {
      const res = await this.proxyFetch(`${SITE}/api/v1/programs/${encodeURIComponent(programId)}/play`, {
        headers: SITE_HEADERS,
        timeoutMs: 10000,
      });
      if (!res.ok) return streams;
      const play = await res.json();

      const videos = [];
      const seen = new Set();
      const data = (play && play.data) || {};
      for (const v of [...(Array.isArray(data.videos) ? data.videos : []), ...(data.video ? [data.video] : [])]) {
        const embedUrl = v && typeof v.embedUrl === 'string' ? v.embedUrl.trim() : '';
        if (!embedUrl || seen.has(embedUrl)) continue;
        seen.add(embedUrl);
        videos.push({ embedUrl, label: v.label || '' });
      }

      for (let i = 0; i < videos.length; i++) {
        const { embedUrl } = videos[i];
        const label = videos[i].label || (videos.length > 1 ? `Feed ${i + 1}` : 'PitSport');
        let resolved = null;
        try {
          resolved = await this.extractM3u8(embedUrl);
        } catch (err) {
          console.warn(`[${this.name}] Watch resolver failed for ${embedUrl}: ${err.message}`);
        }

        if (resolved) {
          streams.push(new StreamEntity({
            name: this.name,
            title: videos.length > 1 || videos[i].label ? `${matchTitle || 'Live Event'} (${label})` : (matchTitle || 'Live Event'),
            url: manifestProxyUrl({
              url: resolved.m3u8,
              referer: EMBED_REFERER,
              origin: EMBED_ORIGIN,
              renew: this.sourceName,
              embed: embedUrl,
              proxySegments: true,
            }),
            behaviorHints: { notWebReady: true },
            resolution: '1080p',
          }));
        } else {
          streams.push(new StreamEntity({
            name: this.name,
            title: `${matchTitle || 'Live Event'} (${label}) (Web Player)`,
            externalUrl: `/watch?url=${encodeURIComponent(embedUrl)}&title=${encodeURIComponent(matchTitle || 'Live Event')}`,
          }));
        }
      }
    } catch (err) {
      console.warn(`[${this.name}] resolveStream failed for ${programId}:`, err.message);
    }
    return streams;
  }
}

module.exports = PitSportProvider;
