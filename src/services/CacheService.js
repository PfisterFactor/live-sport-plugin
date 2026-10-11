/** Strips the provider prefix ("dlv_123_") and every non-alphanumeric from an id. */
function slugOf(value) {
  return String(value || '').toLowerCase().replace(/^[a-z0-9]+_[0-9]+_/, '').replace(/[^a-z0-9]/g, '');
}

function cloneMatch(m) {
  const clone = { ...m, sources: [...(m.sources || [])] };
  if (Array.isArray(m.aliasIds)) clone.aliasIds = [...m.aliasIds];
  return clone;
}

class CacheService {
  constructor() {
    this.cachedMatches = [];
    this.lastFetchTime = 0;
    this.CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  }

  getMatches() {
    return this.cachedMatches.map(cloneMatch);
  }

  setMatches(matches) {
    this.cachedMatches = (matches || []).map(cloneMatch);
    this.lastFetchTime = Date.now();
  }

  /**
   * Resolves one match by id without cloning the whole list. Ids drift between
   * syncs (merged events keep every provider's id as an alias), so a meta
   * request for a stale id must still land on the right fixture. Tiers, in order:
   *   1. primary id
   *   2. alias id from a merged provider row
   *   3. any source id
   *   4. normalized slug against id or title (slugs longer than 6 chars only)
   *
   * @param {string} matchId - Id with or without the `nuvio_sport_` prefix.
   * @returns {object|null} A defensive copy, or null.
   */
  findMatch(matchId) {
    if (!matchId || !this.cachedMatches.length) return null;
    const id = String(matchId);
    const bare = id.replace(/^nuvio_sport_/, '');
    const ids = id === bare ? [id, `nuvio_sport_${id}`] : [id, bare];
    const matches = this.cachedMatches;

    let found = matches.find(m => m && ids.includes(m.id));
    if (!found) found = matches.find(m => m && Array.isArray(m.aliasIds) && m.aliasIds.some(a => ids.includes(a)));
    if (!found) {
      found = matches.find(m => m && Array.isArray(m.sources) && m.sources.some(s => {
        if (!s || s.id == null) return false;
        const sid = String(s.id);
        return ids.includes(sid) || ids.includes(sid.replace(/^stream_/, '')) || (bare.length > 6 && sid.includes(bare));
      }));
    }
    if (!found) {
      const clean = slugOf(bare);
      if (clean.length > 6) {
        found = matches.find(m => {
          if (!m) return false;
          const mid = slugOf(m.id);
          if (mid && (mid.includes(clean) || clean.includes(mid))) return true;
          const title = String(m.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          return !!title && (title.includes(clean) || clean.includes(title));
        });
      }
    }
    return found ? structuredClone(found) : null;
  }

  isStale(ttlMs = this.CACHE_TTL) {
    return (Date.now() - this.lastFetchTime) > ttlMs;
  }
}

module.exports = CacheService;
