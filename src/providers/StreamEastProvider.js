const BaseProvider = require('./BaseProvider');
const { DEFAULT_UA } = BaseProvider;
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const { decodeHtmlEntities } = require('./DliveProvider');
const { manifestProxyUrl } = require('../proxyUrl');

/** Catalog section (first URL path segment) -> catalog category. */
const SECTION_CATEGORY = {
  nfl: 'american_football',
  cfb: 'college',
  ncaab: 'college',
  nba: 'basketball',
  wnba: 'basketball',
  mlb: 'baseball',
  nhl: 'hockey',
  ufc: 'mma',
  boxing: 'mma',
  wwe: 'mma',
  f1: 'motorsport',
  soccer: 'football',
};

const CARD_RE = /<(?:div|a) class="m-card(?: [^"]*)?"([^>]*\bdata-mac-id="[^"]*"[^>]*)>/g;
const SERVER_RE = /<a class="stream-alt-item([^"]*)" href="([^"]+)">([\s\S]*?)<\/a>/g;
const PLAYER_IFRAME_RE = /<iframe[^>]*\bid="iframe"[^>]*\bsrc="([^"]+)"/i;

function attr(attrs, name) {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? decodeHtmlEntities(m[1]) : '';
}

/**
 * StreamEast (v2.streameast.ga). The catalog is server-rendered match cards on
 * the home page; each event page embeds one server per URL suffix (/1, /2, ...).
 *
 * The site bounces cookieless visitors through an SSO handoff on another host
 * that sets `sso_checked`, so every request presents that cookie up front.
 * Cards flagged data-pro-only and "pro" servers are behind a premium gate and
 * are skipped. Free servers embed third-party players (streame.center,
 * embedme.st, ...) whose chains DliveProvider's generic resolver already walks.
 */
class StreamEastProvider extends BaseProvider {
  constructor(opts) {
    super(opts);
    this.name = 'StreamEast';
    this.sourceName = 'streameast';
    this.baseUrl = 'https://v2.streameast.ga';
    this.dliveProvider = opts.dliveProvider;

    this.fetchHome = this.circuitBreaker.wrap(`${this.name}_fetchHome`, async () => {
      const html = await this._fetchSitePage('/', 15000);
      if (html === null) throw new Error('home page unavailable');
      return html;
    });
  }

  /** HTML of a same-site page, or null when the site refuses it. */
  async _fetchSitePage(path, timeoutMs = 8000) {
    const res = await this.proxyFetch(new URL(path, this.baseUrl).toString(), {
      headers: {
        'User-Agent': DEFAULT_UA,
        'Referer': `${this.baseUrl}/`,
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Cookie': 'sso_checked=1',
      },
      timeoutMs,
    });
    return res.ok ? await res.text() : null;
  }

  _absolute(path) {
    if (!path) return '';
    try { return new URL(path, this.baseUrl).toString(); } catch (_) { return ''; }
  }

  /** Free match cards on the home page as MatchEntity rows. */
  parseCards(html) {
    const matches = [];
    const seen = new Set();
    const cards = [...html.matchAll(CARD_RE)];
    cards.forEach((m, i) => {
      const attrs = m[1];
      const id = attr(attrs, 'data-mac-id');
      if (!id || seen.has(id) || attr(attrs, 'data-pro-only') === '1') return;

      // Team cards carry the link and title on an inner anchor; event cards are the anchor.
      const body = html.slice(m.index, i + 1 < cards.length ? cards[i + 1].index : m.index + 3000);
      const inner = body.match(/class="m-card__link" href="([^"]+)" aria-label="([^"]*)"/);
      const path = inner ? inner[1] : attr(attrs, 'href');
      const title = inner
        ? decodeHtmlEntities(inner[2])
        : decodeHtmlEntities((body.match(/class="m-card__title">([^<]+)</) || [])[1] || '');
      if (!path || !title) return;
      seen.add(id);

      const section = path.split('/').filter(Boolean)[0] || '';
      const sportTag = attr(attrs, 'data-sport-tag');
      const category = SECTION_CATEGORY[section] || this.mapCategoryLabel(sportTag || section);
      const startsSec = Number(attr(attrs, 'data-time'));
      const [home, away] = attr(attrs, 'data-team-names').split('|');
      const homeLogo = this._absolute(attr(attrs, 'data-mark-home'));
      const awayLogo = this._absolute(attr(attrs, 'data-mark-away'));

      matches.push(new MatchEntity({
        id: `se_${id}`,
        title,
        category,
        status: /\bm-card--live\b/.test(m[0]) ? 'live' : 'upcoming',
        date: startsSec > 0 ? String(startsSec * 1000) : '',
        popular: attr(attrs, 'data-hot-game') === '1' ? '1' : '0',
        league: sportTag || section.toUpperCase(),
        team1: home && away ? { name: home, logo: homeLogo || null } : null,
        team2: home && away ? { name: away, logo: awayLogo || null } : null,
        thumbnail_url: homeLogo || awayLogo,
        sources: [{ source: this.sourceName, id: path }],
      }));
    });
    return matches;
  }

  async getMatches() {
    try {
      return this.parseCards(await this.fetchHome.fire());
    } catch (err) {
      console.error(`[${this.name}] Failed to get matches:`, err.message);
      return [];
    }
  }

  /**
   * Free servers listed on an event page, in site order. Pages without the
   * source picker expose only their own player.
   */
  parseServers(html, eventPath) {
    const servers = [];
    for (const m of html.matchAll(SERVER_RE)) {
      if (/\bstream-alt-item-pro\b/.test(m[1])) continue;
      const label = decodeHtmlEntities(m[3].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
      servers.push({ path: m[2], label: label.replace(/^Free\s+/i, '') || 'Server', active: /\bactive\b/.test(m[1]) });
    }
    if (servers.length === 0) servers.push({ path: eventPath, label: 'Server 1', active: true });
    return servers.slice(0, StreamEastProvider.MAX_SERVERS);
  }

  static playerIframe(html) {
    const m = html && html.match(PLAYER_IFRAME_RE);
    if (!m) return null;
    const src = decodeHtmlEntities(m[1]);
    const url = src.startsWith('//') ? `https:${src}` : src;
    return /^https?:/i.test(url) ? url : null;
  }

  /** Re-mints a signed manifest from a server's player iframe (StreamRenewal contract). */
  async extractM3u8(embedUrl) {
    return this.dliveProvider.extractM3u8(embedUrl);
  }

  async _resolveServer(server, eventHtml, matchTitle) {
    const pageUrl = this._absolute(server.path);
    const webPlayer = () => new StreamEntity({
      name: this.name,
      title: `${matchTitle} (${server.label}) (Web Player)`,
      externalUrl: pageUrl,
    });

    try {
      const html = server.active ? eventHtml : await this._fetchSitePage(server.path);
      const embedUrl = StreamEastProvider.playerIframe(html);
      if (!embedUrl) return null;
      const extracted = await this.extractM3u8(embedUrl);
      if (!extracted) return webPlayer();
      return new StreamEntity({
        name: this.name,
        title: `${matchTitle} (${server.label})`,
        url: manifestProxyUrl({
          url: extracted.m3u8,
          referer: extracted.referer,
          renew: this.sourceName,
          embed: embedUrl,
        }),
        behaviorHints: { notWebReady: true },
        resolution: 'HD',
      });
    } catch (err) {
      console.error(`[${this.name}] ${server.path} failed:`, err.message);
      return webPlayer();
    }
  }

  async resolveStream(sourceId, matchCategory, matchTitle) {
    try {
      const eventHtml = await this._fetchSitePage(sourceId);
      if (!eventHtml) return [];
      const servers = this.parseServers(eventHtml, sourceId);
      const streams = await Promise.all(servers.map((s) => this._resolveServer(s, eventHtml, matchTitle)));
      return streams.filter(Boolean);
    } catch (err) {
      console.error(`[${this.name}] resolveStream failed for ${sourceId}:`, err.message);
      return [];
    }
  }
}

/** Free servers resolved per event; the site lists four. */
StreamEastProvider.MAX_SERVERS = 4;

module.exports = StreamEastProvider;
