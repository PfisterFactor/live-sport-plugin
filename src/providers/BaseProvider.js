// Hardcoded CF proxy pool — add more URLs to multiply free-tier limits
const CF_PROXY_POOL = [];

// Safe impit wrapper — falls back to undici when impit native binary is
// unavailable (ARM64 VPS, Alpine/musl Linux, certain Windows Server builds).
const { safeFetch: _safeFetch } = require('../impitClient');

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

// Pick a random proxy from the pool
function getCfProxyUrl() {
  if (process.env.NODE_ENV === 'test') return null;
  if (CF_PROXY_POOL.length === 0) return null;
  return CF_PROXY_POOL[Math.floor(Math.random() * CF_PROXY_POOL.length)];
}

class BaseProvider {
  constructor({ circuitBreaker }) {
    this.circuitBreaker = circuitBreaker;
    this.name = 'BaseProvider';
  }

  /**
   * Fetch matches from the provider.
   * Should return an array of MatchEntity objects.
   */
  async getMatches() {
    throw new Error('getMatches() must be implemented by subclasses');
  }

  /**
   * Resolve a specific stream source.
   * Should return an array of StreamEntity objects.
   */
  async resolveStream(sourceId, matchCategory, matchTitle) {
    return [];
  }

  /**
   * Helper to normalize category strings across all providers
   */
  normalizeCategory(cat) {
    if (!cat) return 'other';
    if (typeof cat === 'object' && !Array.isArray(cat)) {
      cat = cat.name || cat.title || 'other';
    }
    cat = String(cat).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (cat.includes('ncaa') || cat.includes('college')) return 'college';
    if (cat.includes('americanfootball') || cat.includes('nfl') || cat.includes('afl') || cat.includes('gridiron')) return 'american_football';
    if (cat.includes('soccer') || cat.includes('football')) return 'football';
    if (cat.includes('motor') || cat.includes('racing') || cat.includes('cycling') || cat.includes('f1')) return 'motorsport';
    if (cat.includes('fight') || cat.includes('mma') || cat.includes('boxing') || cat.includes('wrestling') || cat.includes('knuckle') || cat.includes('ufc')) return 'mma';
    if (cat.includes('basketball') || cat.includes('nba')) return 'basketball';
    if (cat.includes('golf')) return 'golf';
    if (cat.includes('rugby')) return 'rugby';
    if (cat.includes('cricket')) return 'cricket';
    if (cat.includes('tennis')) return 'tennis';
    if (cat.includes('hockey') || cat.includes('nhl')) return 'hockey';
    if (cat.includes('baseball') || cat.includes('mlb')) return 'baseball';
    if (cat.includes('darts')) return 'darts';
    if (cat.includes('liveshow') || cat.includes('uncategorized')) return 'other';
    return cat;
  }

  /**
   * Fetch wrapper that routes through Cloudflare proxy if configured
   */
  async proxyFetch(url, options = {}) {
    const cfProxyUrl = getCfProxyUrl();
    if (cfProxyUrl) {
      const proxyUrl = new URL(cfProxyUrl);
      proxyUrl.searchParams.set('url', url);
      
      if (options.headers) {
        let referer, origin;
        if (options.headers instanceof Headers) {
          referer = options.headers.get('referer') || options.headers.get('Referer');
          origin = options.headers.get('origin') || options.headers.get('Origin');
        } else {
          referer = options.headers.referer || options.headers.Referer;
          origin = options.headers.origin || options.headers.Origin;
        }
        
        if (referer) proxyUrl.searchParams.set('referer', referer);
        if (origin) proxyUrl.searchParams.set('origin', origin);
      }
      
      url = proxyUrl.toString();
    }
    
    const { timeoutMs = 15000, signal, ...rest } = options;
    return await _safeFetch(url, {
      method: 'GET',
      ...rest,
      headers: options.headers || {},
      timeoutMs,
    });
  }

  /**
   * Helper to normalize strings for fuzzy matching
   */
  normalizeStr(str) {
    if (!str) return '';
    return str.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

module.exports = BaseProvider;
module.exports.getCfProxyUrl = getCfProxyUrl;
module.exports.DEFAULT_UA = DEFAULT_UA;
BaseProvider.DEFAULT_UA = DEFAULT_UA;
