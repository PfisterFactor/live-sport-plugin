const crypto = require('crypto');
const BaseProvider = require('./BaseProvider');
const { DEFAULT_UA } = BaseProvider;
const MatchEntity = require('../domain/MatchEntity');
const { unpack } = require('./deanEdwardsUnpack');

const REPLAYS_URL = 'https://replay.adityapangshe.workers.dev/replays.txt';
const CACHE_LIMIT = 500;

function b64Decode(str) {
  let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const rem = b64.length % 4;
  if (rem !== 0) b64 += '='.repeat(4 - rem);
  return Buffer.from(b64, 'base64');
}

/** Insert into a size-bounded Map, evicting the oldest entry. */
function boundedSet(map, key, value, limit = CACHE_LIMIT) {
  if (map.size >= limit) map.delete(map.keys().next().value);
  map.set(key, value);
}

/**
 * ReplayZone replay archive. The feed is a text file of blocks:
 *
 *   # <title>
 *   ~ <category>\t<league>\t<thumbnail>\t<date>
 *   <label>\t<iframe|hls>\t<url>      (one line per server)
 *
 * Streams are plain objects because they carry the `_rzWeb` marker that the
 * stream pipeline keys on to keep browser embeds while filtering other
 * external links.
 */
class ReplayZoneProvider extends BaseProvider {
  constructor(opts) {
    super(opts);
    this.name = 'ReplayZone';
    this.sourceName = 'replayzone';
    this.replaysUrl = REPLAYS_URL;
    this._byseCache = new Map();
    this._dmCache = new Map();
    this._webCache = new Map();
  }

  _parseBlock(block) {
    const lines = block.split('\n').map(l => l.trim()).filter(l => l);
    if (lines.length < 3 || !lines[0].startsWith('#') || !lines[1].startsWith('~')) return null;

    const title = lines[0].replace(/^#\s*/, '').trim();
    const [category = 'football', league = '', thumbnail = '', dateStr = ''] = lines[1].replace(/^~\s*/, '').split('\t');

    const sources = [];
    for (const line of lines.slice(2)) {
      const [label = '', type = '', sourceUrl = ''] = line.split('\t').map(p => p.trim());
      if (!/^https?:\/\//i.test(sourceUrl)) continue;
      sources.push({
        source: this.sourceName,
        id: sourceUrl,
        name: label,
        url: sourceUrl,
        type: type.toLowerCase() || 'iframe',
      });
    }
    if (sources.length === 0) return null;

    return new MatchEntity({
      id: `rz_${title.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${Buffer.from(dateStr).toString('hex')}`,
      title,
      category: (category || 'football').toLowerCase(),
      league,
      date: dateStr,
      status: 'finished',
      thumbnail_url: thumbnail,
      sources,
    });
  }

  async getMatches() {
    try {
      const res = await this.proxyFetch(this.replaysUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeoutMs: 20000 });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();

      const matches = text.split('\n\n')
        .filter(b => b.trim())
        .map(b => this._parseBlock(b))
        .filter(Boolean);

      console.log(`[ReplayZone] Extracted ${matches.length} matches`);
      return matches;
    } catch (error) {
      console.error('[ReplayZone] Error fetching matches:', error.message);
      return [];
    }
  }

  async resolveStream(url, category, team, srcObj) {
    const partName = ((srcObj && srcObj.name) || '').replace(/\([^)]+\)/g, '').trim();

    url = url || (srcObj && srcObj.url) || '';
    if (!url) return [];

    if (this._isByseUrl(url)) {
      const streams = await this.extractByse(url, partName);
      if (streams.length > 0) return streams;
    }

    if (url.includes('ok.ru')) return this._resolveOkRu(url, partName);

    if (this._isDirectMediaUrl(url)) return [this._buildDirectStream(url, partName)];

    if (url.includes('soccerfull.net')) {
      const streams = await this.extractSoccerfull(url, partName);
      if (streams.length > 0) return streams;
    }

    if (this._isDailymotionUrl(url)) return this._resolveDailymotion(url, partName);

    // Replay pages get removed over time, and a dead fallback link is worse
    // than none: the user copies it and gets a 404.
    if (await this._checkWebAlive(url)) return [this._webStream(url, partName)];
    return [];
  }

  _webStream(externalUrl, label) {
    return {
      name: 'RZ (External)',
      title: label ? `${label} (Browser)` : 'Watch in Browser',
      externalUrl,
      _rzWeb: true,
    };
  }

  /**
   * Liveness probe for an external browser-fallback page, cached per URL.
   * Only a definitive 404/410 counts as dead: a 403, a redirect or a timeout
   * means "not proven gone" (some hosts reject probes that a browser would
   * pass), and dropping a working link is worse than keeping a dead one.
   */
  async _checkWebAlive(url) {
    if (!url || typeof url !== 'string') return false;
    const cached = this._webCache.get(url);
    if (cached !== undefined) return cached;

    let alive = true;
    try {
      const res = await this.proxyFetch(url, {
        headers: { 'User-Agent': DEFAULT_UA, 'Accept': 'text/html,application/xhtml+xml,*/*' },
        timeoutMs: 5000,
        attempts: 1,
      });
      if (res.status === 404 || res.status === 410) {
        alive = false;
        console.log(`[ReplayZone] Dropping dead fallback link (HTTP ${res.status}): ${url}`);
      }
    } catch (_) {
      alive = true;
    }

    boundedSet(this._webCache, url, alive, 1000);
    return alive;
  }

  _isDailymotionUrl(url) {
    return typeof url === 'string' && /(?:dailymotion\.com|dai\.ly)/i.test(url);
  }

  _extractDailymotionVideoId(url) {
    if (!url || typeof url !== 'string') return null;
    const match = url.match(/[?&]video=([a-zA-Z0-9]+)/i)
      || url.match(/(?:dailymotion\.com\/(?:video|embed\/video)|dai\.ly)\/([a-zA-Z0-9]+)/i);
    return match ? match[1] : null;
  }

  _getCachedDm(videoId) {
    const cached = this._dmCache.get(videoId);
    if (!cached) return null;
    if (cached.expiresAt < Date.now()) {
      this._dmCache.delete(videoId);
      return null;
    }
    return cached.isAlive;
  }

  /** Dead verdicts are kept 1 h, alive verdicts 15 min. */
  _setCachedDm(videoId, isAlive) {
    const ttl = isAlive ? 15 * 60 * 1000 : 60 * 60 * 1000;
    boundedSet(this._dmCache, videoId, { isAlive, expiresAt: Date.now() + ttl }, 1000);
  }

  /** Dailymotion metadata drops dead videos (removed, Terms of Use, no qualities). */
  async _checkDailymotionAlive(videoId) {
    if (!videoId) return false;
    const cached = this._getCachedDm(videoId);
    if (cached !== null) return cached;

    try {
      const res = await this.proxyFetch(`https://www.dailymotion.com/player/metadata/video/${videoId}`, {
        headers: { 'User-Agent': DEFAULT_UA, 'Referer': 'https://www.dailymotion.com/' },
        timeoutMs: 4000,
      });
      if (!res.ok) {
        console.warn(`[ReplayZone] Dailymotion metadata returned HTTP ${res.status} for ${videoId}`);
        this._setCachedDm(videoId, false);
        return false;
      }

      const json = await res.json();
      if (json && json.error) {
        const errMsg = json.error.message || json.error.title || json.error.raw_message || '';
        console.log(`[ReplayZone] Dropping dead Dailymotion video ${videoId}: ${errMsg}`);
        this._setCachedDm(videoId, false);
        return false;
      }
      if (!json || !json.qualities || Object.keys(json.qualities).length === 0) {
        console.log(`[ReplayZone] Dropping Dailymotion video ${videoId}: no qualities available`);
        this._setCachedDm(videoId, false);
        return false;
      }

      this._setCachedDm(videoId, true);
      return true;
    } catch (err) {
      console.warn(`[ReplayZone] Error checking Dailymotion ${videoId}:`, err.message);
      return false;
    }
  }

  /** Dailymotion embed as a web stream, or nothing when the video is dead. */
  async _resolveDailymotion(url, partName = '') {
    const videoId = this._extractDailymotionVideoId(url);
    if (!videoId || !(await this._checkDailymotionAlive(videoId))) return [];
    return [this._webStream(url, partName)];
  }

  _isByseUrl(url) {
    return typeof url === 'string' && /byse[a-z0-9]*\.[a-z]+/i.test(url);
  }

  _isDirectMediaUrl(url) {
    return /\.(m3u8|mp4)(?:[?#]|$)/i.test(url);
  }

  /** Decrypt the AES-256-GCM playback payload served by Byse video platforms. */
  _decryptBysePlayback(playback) {
    if (!playback || !playback.payload || !playback.iv || !Array.isArray(playback.key_parts)) return null;
    try {
      const version = parseInt(playback.version, 10);
      let keyParts = playback.key_parts;
      if (!isNaN(version) && version >= 1 && version <= 20) {
        const first = playback.key_parts[version - 1];
        const second = playback.key_parts[(31 - version) - 1];
        if (first && second) keyParts = [first, second];
      }
      const key = Buffer.concat(keyParts.map(b64Decode));
      if (key.length !== 32) return null;

      const iv = b64Decode(playback.iv);
      const payload = b64Decode(playback.payload);
      if (payload.length < 16) return null;

      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(payload.subarray(payload.length - 16));
      const decrypted = Buffer.concat([decipher.update(payload.subarray(0, payload.length - 16)), decipher.final()]);
      return JSON.parse(decrypted.toString('utf8'));
    } catch (err) {
      console.error('[ReplayZone] Byse decryption failed:', err.message);
      return null;
    }
  }

  /** Byse sources handed straight to the client CDN (no server bandwidth). */
  _formatByseStreams(sources, host, partName = '') {
    const cleanPart = partName.trim();
    return sources.filter(s => s.url).map((s) => {
      const resLabel = s.label || (s.height ? `${s.height}p` : '1080p');
      return {
        name: 'ReplayZone',
        title: cleanPart ? `${cleanPart} (${resLabel})` : `Stream (${resLabel})`,
        resolution: resLabel,
        url: s.url,
        behaviorHints: {
          notWebReady: true,
          proxyHeaders: {
            request: { 'Origin': `https://${host}`, 'Referer': `https://${host}/`, 'User-Agent': DEFAULT_UA },
          },
        },
      };
    });
  }

  async extractByse(embedUrl, partName = '') {
    try {
      const u = new URL(embedUrl);
      const host = u.hostname;
      const code = u.pathname.split('/').filter(Boolean).pop();
      if (!code) return [];

      const cacheKey = `${host}:${code}`;
      const cached = this._byseCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) return this._formatByseStreams(cached.sources, host, partName);

      const res = await this.proxyFetch(`https://${host}/api/videos/${code}/`, {
        headers: {
          'User-Agent': DEFAULT_UA,
          'Referer': `https://${host}/e/${code}`,
          'Origin': `https://${host}`,
          'Accept': 'application/json, text/plain, */*',
        },
        timeoutMs: 10000,
      });
      if (!res.ok) {
        console.warn(`[ReplayZone] Byse API returned HTTP ${res.status} for ${code}`);
        return [];
      }

      const json = await res.json();
      if (!json || !json.playback) {
        console.warn(`[ReplayZone] No playback block in Byse response for ${code}`);
        return [];
      }

      const decrypted = this._decryptBysePlayback(json.playback);
      const sources = decrypted && Array.isArray(decrypted.sources) ? decrypted.sources : [];
      if (sources.length === 0) return [];

      let expiresAt = Date.now() + 10 * 60 * 1000;
      const exp = decrypted.expires_at ? new Date(decrypted.expires_at).getTime() : NaN;
      if (!isNaN(exp) && exp > Date.now()) expiresAt = Math.min(expiresAt, exp);
      boundedSet(this._byseCache, cacheKey, { sources, expiresAt });

      return this._formatByseStreams(sources, host, partName);
    } catch (error) {
      console.error(`[ReplayZone] Error extracting Byse stream (${embedUrl}):`, error.message);
      return [];
    }
  }

  /**
   * ok.ru is served as a web embed. Its own player opens parallel byte-range
   * connections to okcdn.ru, which is why 1080p plays smoothly there; handing
   * the raw okcdn URL to a single-connection player throttles to ~2 Mbps.
   */
  _resolveOkRu(url, partName = '') {
    const embedUrl = /ok\.ru\/video\/\d+/.test(url) ? url.replace('/video/', '/videoembed/') : url;
    return [{
      name: 'RZ (External)',
      title: partName.trim() ? `${partName.trim()} (ok.ru)` : 'ok.ru Player',
      externalUrl: embedUrl,
      _rzWeb: true,
    }];
  }

  _buildDirectStream(streamUrl, partName = '', origin = '', referer = '') {
    const cleanPart = partName.trim();
    const stream = {
      name: 'ReplayZone',
      title: cleanPart ? `${cleanPart} (Direct)` : 'Stream (Direct)',
      resolution: 'HD',
      url: streamUrl,
      behaviorHints: { notWebReady: true },
    };
    if (origin || referer) {
      stream.behaviorHints.proxyHeaders = {
        request: {
          ...(origin ? { 'Origin': origin } : {}),
          ...(referer ? { 'Referer': referer } : {}),
          'User-Agent': DEFAULT_UA,
        },
      };
    }
    return stream;
  }

  /** soccerfull.net pages: Byse/ok.ru/Dailymotion iframes, direct media, or legacy ArtPlayer. */
  async extractSoccerfull(url, partName = '') {
    try {
      const res = await this.proxyFetch(url, { headers: { 'User-Agent': DEFAULT_UA }, timeoutMs: 15000 });
      if (!res.ok) return [];
      const html = await res.text();

      const iframes = [...html.matchAll(/<iframe[^>]+src="([^">]+)"/gi)]
        .map((m) => { try { return new URL(m[1], url).toString(); } catch (_) { return null; } })
        .filter(Boolean);

      const streams = [];
      for (const iframeUrl of iframes) {
        if (this._isByseUrl(iframeUrl)) streams.push(...await this.extractByse(iframeUrl, partName));
        else if (iframeUrl.includes('ok.ru')) streams.push(...this._resolveOkRu(iframeUrl, partName));
        else if (this._isDailymotionUrl(iframeUrl)) streams.push(...await this._resolveDailymotion(iframeUrl, partName));
        else if (this._isDirectMediaUrl(iframeUrl)) streams.push(this._buildDirectStream(iframeUrl, partName));
      }
      if (streams.length > 0) return streams;

      const m3u8Var = html.match(/var\s+m3u8Url\s*=\s*["']([^"']+)["']/i);
      if (m3u8Var) return [this._buildDirectStream(new URL(m3u8Var[1], url).toString(), partName)];

      for (const iframeUrl of iframes) {
        const target = iframeUrl.replace('hgcloud.to', 'hanerix.com');
        if (!target.includes('hanerix.com')) continue;
        const direct = await this._extractHanerix(target, url);
        if (direct) streams.push(this._buildDirectStream(direct, partName, 'https://hanerix.com', 'https://hanerix.com/'));
      }
      return streams;
    } catch (error) {
      console.error('[ReplayZone] Error extracting soccerfull:', error.message);
      return [];
    }
  }

  /** Legacy hanerix/hgcloud player: the manifest sits in a Dean Edwards packed script. */
  async _extractHanerix(iframeUrl, pageUrl) {
    try {
      const res = await this.proxyFetch(iframeUrl, {
        headers: { 'User-Agent': DEFAULT_UA, 'Referer': `${new URL(pageUrl).origin}/` },
        timeoutMs: 15000,
      });
      const html = await res.text();
      if (html.includes('sandbox not allowed') || html.includes('Access denied')) return null;

      const start = html.indexOf('eval(function(p,a,c,k,e,d)');
      if (start === -1) return null;
      const end = html.indexOf('</script>', start);
      if (end === -1) return null;

      const unpacked = unpack(html.substring(start, end).trim());
      if (!unpacked) return null;

      const file = unpacked.match(/file\s*:\s*["']([^"']+)["']/);
      const direct = file && file[1].trim().startsWith('http') ? file[1].trim() : null;
      const embedded = unpacked.match(/https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/);
      const resolved = direct || (embedded && embedded[0]);
      return resolved ? new URL(resolved, iframeUrl).toString() : null;
    } catch (_) {
      return null;
    }
  }
}

module.exports = ReplayZoneProvider;
