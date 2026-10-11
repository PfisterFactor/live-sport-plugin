const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const { withRetry, isTransientStatus } = require('../services/retry');
const { checkOutboundUrl } = require('../services/OutboundUrlGuard');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const MIRRORS = ['https://livetv.sx', 'https://livetv904.me', 'https://m.livetv904.me'];

/** Replay-day archive pages are ~1.5 MB each; fetch a few at a time. */
const ARCHIVE_CONCURRENCY = 4;
const MAX_SNIPE_HOPS = 5;
const SHORTENER_RE = /(?:tinyurl\.com|bit\.ly|t\.co|goo\.gl|is\.gd|cutt\.ly|rb\.gy|shorturl\.at|ow\.ly)/i;
const YOUTUBE_RE = /youtube(?:-nocookie)?\.com\/(?:embed\/|watch\?v=)([A-Za-z0-9_-]{6,})|youtu\.be\/([A-Za-z0-9_-]{6,})/i;
const APL_HOST_RE = /emb\.apl\d+\.online/gi;
const APL_HOST = 'emb.apl613.online';

const clean = (s) => String(s || '').replace(/<[^>]+>/g, '').trim();
const decode = (s) => String(s || '').replace(/&ndash;/g, '-').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const absolute = (url) => (url.startsWith('//') ? `https:${url}` : url);
const normalizeAplHost = (url) => url.replace(APL_HOST_RE, APL_HOST);
const youtubeId = (text) => {
  const m = String(text).match(YOUTUBE_RE);
  return m ? (m[1] || m[2]) : null;
};

const CANONICAL = new Set([
  'football', 'cricket', 'basketball', 'motorsport', 'hockey', 'baseball',
  'mma', 'golf', 'tennis', 'rugby', 'american_football', 'darts', 'college', 'other',
]);

const FOOTBALL_HINTS = [
  'football', 'soccer', 'liga', 'liiga', 'copa', 'serie', 'premier', 'division', 'primera',
  'bundesliga', 'eredivisie', 'ekstraklasa', 'championship', 'league', 'cup',
  'mls', 'usl', 'super lig', 'ligue', 'libertadores', 'sudamericana', 'uefa',
  'afc', 'concacaf', 'qualification', 'world cup', 'euro', 'friendly', 'premiership',
];

/** Map a livetv.sx competition name onto the catalog's canonical categories. */
function normalizeCategory(raw) {
  const c = String(raw || '').toLowerCase();
  if (c.includes('nhl') || c.includes('hockey')) return 'hockey';
  if (c.includes('mlb') || c.includes('baseball')) return 'baseball';
  if (c.includes('wnba') || c.includes('nba') || c.includes('basketball') || c.includes('lnbp') || c.includes('3x3')) return 'basketball';
  if (c.includes('nfl') || c.includes('american football')) return 'american_football';
  if (c.includes('tennis') || c.includes('wta') || c.includes('atp')) return 'tennis';
  if (c.includes('rugby')) return 'rugby';
  if (c.includes('cricket')) return 'cricket';
  if (c.includes('mml') || c.includes('ufc') || c.includes('boxing') || c.includes('fight')) return 'mma';
  if (c.includes('golf') || c.includes('pga')) return 'golf';
  if (c.includes('formula') || c.includes('motogp') || c.includes('racing') || c.includes('nascar')) return 'motorsport';
  if (c.includes('volleyball') || c.includes('gymnastics') || c.includes('athletics')) return 'other';

  // Word boundaries keep short codes (DEL, SHL, NBL) from matching inside
  // longer football league names such as Estonia Meistriliiga.
  if (/\b(?:khl|vhl|mhl|whl|ohl|qmjhl|ahl|nhl|del|shl|ebel)\b/i.test(c) || /\bliiga\b/i.test(c) || c.includes('extraleague')) return 'hockey';
  if (/\b(?:wnbl|nbl|enbl|lnb|lkl|tbl|acb|kbl)\b/i.test(c) || c.includes('ldb')) return 'basketball';
  if (FOOTBALL_HINTS.some((h) => c.includes(h))) return 'football';
  return CANONICAL.has(c) ? c : 'other';
}

function ymdDash(ymd) {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

const SECTION_CATEGORIES = {
  'football': 'football', 'futsal': 'football', 'beach soccer': 'football',
  'ice hockey': 'hockey', 'basketball': 'basketball', 'tennis': 'tennis',
  'racing': 'motorsport', 'cycling': 'motorsport', 'rugby league': 'rugby', 'rugby union': 'rugby',
  'baseball': 'baseball', 'american football': 'american_football', 'darts': 'darts',
  'golf': 'golf', 'cricket': 'cricket', 'mma': 'mma', 'boxing': 'mma',
};

/** Map a livetv.sx sport section title onto a catalog category; unknown sports are 'other'. */
function sectionCategory(section) {
  return SECTION_CATEGORIES[section.toLowerCase()] || 'other';
}

/**
 * Parse one livetv.sx archive day. Every fixture row is a
 * `<table height=27>` block; goal clips and long highlights sit in nested
 * popup tables inside the same block, so the block (not the <tr>) is the unit.
 */
function parseArchive(html, ymd) {
  const sectionRe = /<span class="whitetitle">([^<]+)<\/span>/g;
  const sections = [];
  let sm;
  while ((sm = sectionRe.exec(html)) !== null) sections.push({ name: clean(sm[1]), index: sm.index });
  const lastBefore = (list, idx) => {
    let cur = null;
    for (const item of list) { if (item.index < idx) cur = item; else break; }
    return cur;
  };

  const headerRe = /<a class="main" href="\/enx\/videotourney\/(\d+)\/"><b>([\s\S]*?)<\/b><\/a>/g;
  const headers = [];
  let hm;
  while ((hm = headerRe.exec(html)) !== null) {
    const section = lastBefore(sections, hm.index);
    headers.push({ name: clean(hm[2]), index: hm.index, section: section ? section.name : '' });
  }

  const blocks = html.split(/<table[^>]+height=27/i);
  const out = [];

  let blockIndex = 0;
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    blockIndex = html.indexOf(block, blockIndex);
    if (!block.includes('showvideo')) continue;
    const teams = block.match(/<b>([^<]+)&ndash;([^<]+)<\/b>/);
    if (!teams) continue;
    const score = block.match(/<font color="#949494"><b>(\d+:\d+)<\/b><\/font>/);
    const header = lastBefore(headers, blockIndex !== -1 ? blockIndex : i);
    const league = header ? header.name : '';
    const category = header && header.section ? sectionCategory(header.section) : normalizeCategory(league);

    const linkRe = /<a class="small" href="(\/enx\/showvideo\/(\d+)_[^"]*)">([^<]*)<\/a>/g;
    const sources = [];
    const seen = new Set();
    let lm;
    while ((lm = linkRe.exec(block)) !== null) {
      const path = lm[1];
      const label = clean(lm[3]);
      if (!label || seen.has(path)) continue;
      seen.add(path);
      sources.push({ source: 'livetv', id: path, name: label, url: MIRRORS[0] + path, type: 'iframe' });
    }
    if (!sources.length) continue;

    const home = decode(teams[1]).trim();
    const away = decode(teams[2]).trim();
    const title = `${home} - ${away}`;
    out.push(new MatchEntity({
      id: `livetv_${title.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${ymd}`,
      title,
      category,
      league,
      date: ymdDash(ymd),
      status: 'finished',
      score: score ? score[1] : '',
      team1: home ? { name: home } : null,
      team2: away ? { name: away } : null,
      sources,
    }));
  }
  return out;
}

/** The one clip target a livetv.sx video page points at, or null. */
function clipTarget(html) {
  const og = html.match(/property=["']og:video["']\s+content=["']([^"']+)["']/i);
  if (og) return og[1];
  const iframe = html.match(/<iframe[^>]+src=["']([^"']+player\/video\.php[^"']+|[^"']+youtube[^"']+)["']/i);
  return iframe ? iframe[1] : null;
}

/**
 * LiveTV (livetv.sx) replay archive. Roughly 85% of the clips embed a YouTube
 * video, which is returned as a `ytId` stream; MP4 clips play directly and
 * anything else falls back to the clip page.
 *
 * Streams are plain objects because they carry the `ytId` and `_livetvReplay`
 * markers that the stream pipeline keys on.
 */
class LiveTVProvider extends BaseProvider {
  constructor(opts) {
    super(opts);
    this.name = 'LiveTV';
    this.sourceName = 'livetv';
    this.daysBack = Number(process.env.LIVETV_DAYS_BACK || 21);
    this.enabled = process.env.LIVETV_DISABLED !== 'true';
    this._streamCache = new Map();
    this._cacheTtlMs = Number(process.env.LIVETV_STREAM_TTL_MS || 6 * 3600 * 1000);
    // 21 archive pages of ~1.5 MB each; on Render they take ~30s, far past the
    // default per-provider sync budget. Replays are re-scraped only every 12h.
    this.syncTimeoutMs = Number(process.env.LIVETV_SYNC_TIMEOUT_MS || 60000);
  }

  _recentYmd() {
    const p = (n) => String(n).padStart(2, '0');
    const out = [];
    for (let i = 0; i < this.daysBack; i++) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - i);
      out.push(`${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`);
    }
    return out;
  }

  /** GET with bounded retry on transient failures; every hop passes the SSRF gate. */
  async _get(url, timeoutMs = 15000) {
    const res = await withRetry(
      () => this.proxyFetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
        timeoutMs,
        attempts: 1,
        validateUrl: async (hop) => {
          const verdict = await checkOutboundUrl(hop);
          if (!verdict.ok) throw new Error(`blocked outbound url: ${verdict.reason}`);
        },
      }),
      { attempts: 3, baseDelayMs: 350, shouldRetryResult: (r) => !r.ok && isTransientStatus(r.status), label: 'LiveTV' },
    );
    if (!res || !res.ok) throw new Error(`HTTP ${res && res.status}`);
    return await res.text();
  }

  async _getMirrored(path) {
    let lastErr;
    for (const base of MIRRORS) {
      try {
        return await this._get(base + path);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  }

  async getMatches() {
    if (!this.enabled) return [];
    try {
      const days = this._recentYmd();
      const matches = [];
      for (let i = 0; i < days.length; i += ARCHIVE_CONCURRENCY) {
        const batch = days.slice(i, i + ARCHIVE_CONCURRENCY);
        const results = await Promise.allSettled(
          batch.map(async (ymd) => parseArchive(await this._getMirrored(`/enx/video/${ymd}/`), ymd)),
        );
        for (const r of results) if (r.status === 'fulfilled') matches.push(...r.value);
      }
      console.log(`[LiveTV] Extracted ${matches.length} replay events across ${days.length} day(s)`);
      return matches;
    } catch (error) {
      console.error('[LiveTV] Error fetching matches:', error.message);
      return [];
    }
  }

  /** Follow shortener redirects (tinyurl, bit.ly, ...) without fetching the destination. */
  async _unshorten(url) {
    let curr = String(url || '').trim();
    for (let step = 0; step < MAX_SNIPE_HOPS; step++) {
      if (youtubeId(curr) || curr.includes('.mp4')) return curr;
      try {
        const verdict = await checkOutboundUrl(curr);
        if (!verdict.ok) break;
        const res = await fetch(curr, { method: 'GET', headers: { 'User-Agent': UA }, redirect: 'manual' });
        const loc = res.status >= 300 && res.status < 400 && res.headers.get('location');
        if (!loc) break;
        curr = new URL(loc, curr).href;
      } catch (_) {
        break;
      }
    }
    return curr;
  }

  /**
   * Walk a clip target (shortener -> intermediate pages -> player) until a
   * YouTube id or MP4 URL turns up.
   * @returns {{ytId?: string, mp4Url?: string, finalUrl: string}}
   */
  async _snipe(target) {
    let currentUrl = normalizeAplHost(absolute(target));
    if (currentUrl.startsWith('/')) currentUrl = MIRRORS[0] + currentUrl;
    const next = async (raw) => normalizeAplHost(await this._unshorten(absolute(raw)));

    for (let iters = 0; iters < MAX_SNIPE_HOPS; iters++) {
      if (SHORTENER_RE.test(currentUrl)) currentUrl = await this._unshorten(currentUrl);

      const yt = youtubeId(currentUrl);
      if (yt) return { ytId: yt, finalUrl: `https://www.youtube.com/watch?v=${yt}` };
      if (currentUrl.includes('.mp4')) return { mp4Url: currentUrl, finalUrl: currentUrl };

      let html;
      try {
        html = await this._get(currentUrl);
      } catch (_) {
        break;
      }

      const htmlYt = (html.match(/["']videoId["']\s*:\s*["']([A-Za-z0-9_-]{11})["']/) || [])[1]
        || (html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']https?:\/\/(?:www\.)?youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})["']/i) || [])[1]
        || (html.match(/<meta[^>]+property=["']og:video(?::url)?["'][^>]+content=["']https?:\/\/(?:www\.)?youtube\.com\/embed\/([A-Za-z0-9_-]{11})["']/i) || [])[1]
        || youtubeId(html);
      if (htmlYt) return { ytId: htmlYt, finalUrl: `https://www.youtube.com/watch?v=${htmlYt}` };

      if (html.includes('Antiphishing.biz checks the short link') || html.includes('Long link:')) {
        const long = html.match(/Long link:.*?(\bhttps?:\/\/[^<]+)/is) || html.match(/Long link:[^>]*>(?:[^<]*<[^>]*>)*\s*(https?:\/\/[^\s<]+)/i);
        if (long && long[1]) {
          currentUrl = normalizeAplHost(long[1].trim());
          continue;
        }
      }

      const trimmed = html.trim();
      if (/^https?:\/\//i.test(trimmed)) {
        currentUrl = await next(trimmed);
        continue;
      }

      const iframe = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
      if (iframe) {
        const src = absolute(iframe[1]);
        if (!src.includes('/v3/signin') && !src.includes('accounts.google.com')) {
          currentUrl = await next(src);
          continue;
        }
      }

      const source = html.match(/<source[^>]+src=["']([^"']+\.mp4[^"']*)["']/i) || html.match(/file:\s*['"]([^'"]+\.mp4[^'"]*)['"]/i);
      if (source) {
        const mp4Url = absolute(source[1].split(',')[0]);
        return { mp4Url, finalUrl: mp4Url };
      }

      const refresh = html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["']?\d+;\s*url=['"]?([^"'>]+)["']?/i)
        || html.match(/window\.location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/i);
      if (refresh) {
        currentUrl = await this._unshorten(refresh[1]);
        continue;
      }
      break;
    }
    return { finalUrl: currentUrl };
  }

  /** Clip targets of a video page: its own clip plus the "Other Videos" siblings. */
  async _collectClips(html, pagePath, baseLabel) {
    const clips = [];
    const root = clipTarget(html);
    if (root) clips.push({ label: baseLabel, target: root });

    const others = html.match(/<b>Other\s+Videos:<\/b>(.*?)<\/table>/is);
    if (others) {
      const linkRe = /<a[^>]+href=["'](\/enx\/showvideo\/[^"']+)["'][^>]*>(.*?)<\/a>/gi;
      let m;
      while ((m = linkRe.exec(others[1]))) {
        if (m[1] === pagePath) continue;
        try {
          const target = clipTarget(await this._getMirrored(m[1]));
          if (target) clips.push({ label: clean(m[2]), target });
        } catch (_) { /* skip a clip whose page failed */ }
      }
    }
    return { clips, hasRoot: !!root };
  }

  _clipStream(clip, sniped) {
    if (sniped.ytId) {
      return { name: 'LiveTV', title: `LiveTV | ${clip.label}`, ytId: sniped.ytId, externalUrl: sniped.finalUrl, _livetvReplay: true };
    }
    if (sniped.mp4Url) {
      return {
        name: 'LiveTV',
        title: `LiveTV | ${clip.label}`,
        url: sniped.mp4Url,
        behaviorHints: { notWebReady: true, proxyHeaders: { request: { 'User-Agent': UA, 'Referer': `https://${APL_HOST}/` } } },
        _livetvReplay: true,
      };
    }
    return { name: 'LiveTV (Web)', title: `LiveTV | ${clip.label} (Fallback)`, externalUrl: sniped.finalUrl, _livetvReplay: true };
  }

  async resolveStream(sourceId, category, team, srcObj) {
    const path = sourceId || (srcObj && (srcObj.id || srcObj.url)) || '';
    if (!path) return [];

    const cached = this._streamCache.get(path);
    if (cached && Date.now() - cached.at < this._cacheTtlMs) return cached.value;

    const baseLabel = (srcObj && srcObj.name) || 'Replay';
    let streams = [];
    try {
      const pagePath = path.startsWith('/') ? path : new URL(path).pathname;
      const html = await this._getMirrored(pagePath);
      const { clips, hasRoot } = await this._collectClips(html, pagePath, baseLabel);

      if (!hasRoot) {
        streams.push({ name: 'LiveTV (Web)', title: `LiveTV | ${baseLabel}`, externalUrl: MIRRORS[0] + pagePath, _livetvReplay: true });
      }
      for (const clip of clips) streams.push(this._clipStream(clip, await this._snipe(clip.target)));
    } catch (e) {
      console.warn(`[LiveTV] resolveStream failed for ${path}: ${e.message}`);
    }

    // The root clip and its "Other Videos" siblings can resolve to the same video.
    const seen = new Set();
    streams = streams.filter((s) => {
      const key = s.ytId ? `yt:${s.ytId}` : (s.url ? `url:${s.url}` : (s.externalUrl ? `ext:${s.externalUrl}` : null));
      if (!key) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    this._streamCache.set(path, { at: Date.now(), value: streams });
    return streams;
  }
}

LiveTVProvider.parseArchive = parseArchive;
LiveTVProvider.normalizeCategory = normalizeCategory;

module.exports = LiveTVProvider;
