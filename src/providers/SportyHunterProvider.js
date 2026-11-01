const BaseProvider = require('./BaseProvider');
const { DEFAULT_UA } = BaseProvider;
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');

const EMBED_PATH_RE = /^https?:\/\/[^/]+\/embed(?:-noads)?\/(?:admin\/)?[^?#]+/;
const MAX_EMBED_HOPS = 3;

/** sportsindx.st category slugs whose label alone does not map correctly. */
const CATEGORY_OVERRIDES = { afl: 'rugby', 'tv-channels': 'networks' };

/**
 * sportyhunter.xyz now redirects to sportsindx.st. The schedule is server
 * rendered into the /new page; each /match/<slug> page carries its embed links
 * as JSON in a data-links attribute. Most embeds are wrappers that nest down to
 * an embedindia-family page, which EmbedIndiaProvider turns into a signed m3u8.
 */
class SportyHunterProvider extends BaseProvider {
  constructor(opts) {
    super(opts);
    this.name = 'SportyHunter';
    this.baseUrl = 'https://sportsindx.st';
    this.embedIndiaProvider = opts.embedIndiaProvider;

    this.fetchData = this.circuitBreaker.wrap(`${this.name}_fetch`, async () => {
      const res = await this.proxyFetch(`${this.baseUrl}/new`, {
        headers: { 'User-Agent': DEFAULT_UA },
        timeoutMs: 15000,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    });
  }

  /**
   * Decode the HTML entities the site uses inside attribute values.
   * @param {string} s
   */
  _decodeAttr(s) {
    return String(s || '')
      .replace(/&#34;|&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }

  /**
   * Parse the schedule page into match rows, first non-"popular" category wins.
   * @param {string} html
   */
  _parseSchedule(html) {
    const rows = new Map();
    const cardRe = /<details class="category-card" data-category="([^"]+)"[\s\S]*?<\/details>/g;
    let card;
    while ((card = cardRe.exec(html)) !== null) {
      const slug = card[1];
      const rowRe = /<a class="match-row" href="\/match\/([^"]+)"[^>]*data-title="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
      let row;
      while ((row = rowRe.exec(card[0])) !== null) {
        const [, matchSlug, title, inner] = row;
        const existing = rows.get(matchSlug);
        if (existing && !(existing.categorySlug === 'popular' && slug !== 'popular')) {
          existing.popular = existing.popular || slug === 'popular';
          continue;
        }
        const ts = inner.match(/data-timestamp="(\d+)"/);
        rows.set(matchSlug, {
          slug: matchSlug,
          title: this._decodeAttr(title),
          categorySlug: slug,
          popular: (existing && existing.popular) || slug === 'popular',
          live: /match-live-tag/.test(inner),
          start: ts ? ts[1] : '',
        });
      }
    }
    return [...rows.values()];
  }

  async getMatches() {
    const matches = [];
    try {
      const html = await this.fetchData.fire();
      if (!html) return [];

      for (const r of this._parseSchedule(html)) {
        const category = CATEGORY_OVERRIDES[r.categorySlug]
          || this.mapCategoryLabel(r.categorySlug.replace(/-/g, ' '));
        matches.push(new MatchEntity({
          id: `sporty_${r.slug}`,
          title: r.title,
          category,
          status: r.live ? 'live' : '',
          date: r.start,
          popular: r.popular || r.live ? '1' : '0',
          sources: [{ source: 'sportyhunter', id: r.slug }],
        }));
      }
    } catch (error) {
      console.error(`[${this.name}] Error fetching matches:`, error.message);
    }
    return matches;
  }

  /**
   * Embed links listed on a match page, in site order, de-duplicated.
   * @param {string} slug
   * @returns {Promise<Array<{url: string, name: string}>>}
   */
  async _fetchLinks(slug) {
    const res = await this.proxyFetch(`${this.baseUrl}/match/${encodeURIComponent(slug)}`, {
      headers: { 'User-Agent': DEFAULT_UA, 'Referer': `${this.baseUrl}/new` },
      timeoutMs: 15000,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const attr = html.match(/data-links="([^"]*)"/);
    if (!attr) return [];
    let links;
    try { links = JSON.parse(this._decodeAttr(attr[1])); } catch (_) { return []; }
    if (!Array.isArray(links)) return [];

    const seen = new Set();
    const out = [];
    for (const l of links) {
      const url = l && l.embedUrl;
      if (typeof url !== 'string' || !/^https?:\/\//.test(url) || seen.has(url)) continue;
      seen.add(url);
      out.push({ url, name: l.name || 'Link' });
    }
    return out;
  }

  /**
   * First nested player URL in an embed wrapper: a static iframe src, or a URL
   * hidden behind atob("...").
   * @param {string} html
   * @param {string} base page URL, resolves protocol-relative/relative srcs
   */
  _findNestedEmbed(html, base) {
    const candidates = [];
    const iframeRe = /<iframe[^>]*\ssrc\s*=\s*["']([^"']+)["']/gi;
    let m;
    while ((m = iframeRe.exec(html)) !== null) candidates.push(this._decodeAttr(m[1]));
    const atobRe = /atob\(\s*["']([A-Za-z0-9+/=]+)["']\s*\)/g;
    while ((m = atobRe.exec(html)) !== null) {
      const decoded = Buffer.from(m[1], 'base64').toString('utf8');
      if (/^https?:\/\//.test(decoded)) candidates.push(decoded);
    }
    for (const c of candidates) {
      if (!c) continue;
      try {
        const u = new URL(c, base);
        if (u.protocol === 'http:' || u.protocol === 'https:') return u.href.replace(/#.*$/, '');
      } catch (_) {}
    }
    return null;
  }

  /**
   * Follow wrapper pages until an embedindia-style /embed/ URL appears.
   * @param {string} url
   * @returns {Promise<string|null>}
   */
  async _resolveEmbed(url) {
    let current = url;
    let referer = `${this.baseUrl}/`;
    for (let hop = 0; hop <= MAX_EMBED_HOPS; hop++) {
      if (EMBED_PATH_RE.test(current)) return current.replace(/#.*$/, '');
      if (hop === MAX_EMBED_HOPS) return null;
      try {
        const res = await this.proxyFetch(current, {
          headers: { 'User-Agent': DEFAULT_UA, 'Referer': referer },
          timeoutMs: 10000,
        });
        if (!res.ok) return null;
        const next = this._findNestedEmbed(await res.text(), current);
        if (!next || next === current) return null;
        referer = current;
        current = next;
      } catch (_) {
        return null;
      }
    }
    return null;
  }

  async resolveStream(sourceId, matchCategory, matchTitle) {
    const streams = [];
    const title = matchTitle || 'Live Event';
    try {
      const links = await this._fetchLinks(sourceId);
      const resolvedEmbeds = await Promise.all(links.map((l) => this._resolveEmbed(l.url)));
      const handled = new Set();

      for (let i = 0; i < links.length; i++) {
        const link = links[i];
        const embed = resolvedEmbeds[i];
        const label = links.length > 1 ? `${title} (${link.name})` : title;

        if (embed && this.embedIndiaProvider) {
          if (handled.has(embed)) continue;
          handled.add(embed);
          const resolved = await this.embedIndiaProvider.resolveStream(
            embed, matchCategory, label, { embedUrl: embed }
          );
          if (Array.isArray(resolved)) streams.push(...resolved);
        } else {
          streams.push(new StreamEntity({
            name: this.name,
            title: `${label} (Web Player)`,
            externalUrl: `/watch?url=${encodeURIComponent(link.url)}&title=${encodeURIComponent(title)}`,
          }));
        }
      }
    } catch (err) {
      console.error(`[${this.name}] resolveStream failed for ${sourceId}:`, err.message);
    }
    return streams;
  }
}

module.exports = SportyHunterProvider;
