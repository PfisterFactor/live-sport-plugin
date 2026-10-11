// Catalog stale-while-revalidate window: once the cache is older than this,
// the next catalog/meta request triggers a background re-sync (see ensureFresh).
const REVALIDATE_AFTER_MS = parseInt(process.env.CATALOG_REVALIDATE_MS, 10) || 10 * 60 * 1000;
const SYNC_INTERVAL_MS = 4 * 60 * 60 * 1000;
const KEEP_ALIVE_INTERVAL_MS = 14 * 60 * 1000;
const PREWARM_INTERVAL_MS = parseInt(process.env.PREWARM_INTERVAL_MS, 10) || 3 * 60 * 1000;
const PREWARM_MAX_MATCHES = parseInt(process.env.PREWARM_MAX_MATCHES, 10) || 12;
const BOOT_RETRY_DELAY_MS = 60 * 1000;

class CronService {
  constructor({ matchAggregator, streamResolveCache, cacheService }) {
    this.matchAggregator = matchAggregator;
    this.streamResolveCache = streamResolveCache;
    this.cacheService = cacheService;
    this.syncing = false;
    this.prewarming = false;
  }

  async runSync() {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const activeMatches = await this.matchAggregator.syncMatches();
      if (activeMatches !== null) {
        this.pruneStreamCache(activeMatches);
      }
    } finally {
      this.syncing = false;
    }
  }

  // Catalog stale-while-revalidate: serve the cached list immediately and
  // refresh in the background once the cache passes REVALIDATE_AFTER_MS.
  // Traffic-driven, so idle instances stay quiet; the 4-hour cron is the floor.
  ensureFresh() {
    try {
      if (this.syncing) return;
      if (!this.cacheService || !this.cacheService.isStale(REVALIDATE_AFTER_MS)) return;
      console.log('[CronService] Catalog stale, triggering background re-sync (SWR)...');
      this.runSync().catch((err) => console.error('[CronService] SWR sync failed:', err.message));
    } catch (err) {
      console.error('[CronService] ensureFresh error:', err.message);
    }
  }

  start() {
    console.log('[CronService] Starting background jobs...');

    setInterval(async () => {
      console.log('[CronService] Running match sync job...');
      try {
        await this.runSync();
      } catch (err) {
        console.error('[CronService] Match sync failed:', err.message);
      }
    }, SYNC_INTERVAL_MS).unref();

    setInterval(async () => {
      try {
        await this.prewarmPopular();
      } catch (err) {
        console.error('[CronService] Prewarm job failed:', err.message);
      }
    }, PREWARM_INTERVAL_MS).unref();

    const externalUrl = process.env.RENDER_EXTERNAL_URL;
    if (externalUrl) {
      console.log(`[CronService] Keep-alive enabled for ${externalUrl}`);
      setInterval(async () => {
        try {
          console.log(`[CronService] Pinging external URL to prevent sleep...`);
          await require('undici').request(`${externalUrl}/health`);
        } catch (err) {
          console.error('[CronService] Keep-alive ping failed:', err.message);
        }
      }, KEEP_ALIVE_INTERVAL_MS).unref();
    }

    // Run first sync immediately on boot
    setTimeout(async () => {
      try {
        console.log('[CronService] Running initial match sync...');
        await this.runSync();
      } catch(e) {
        console.error('[CronService] Match sync failed:', e.message);
      }
      this.scheduleBootRetry();
    }, 1000);
  }

  /**
   * A cold instance often loses providers to the sync budget on its first
   * sync, and the next sync is otherwise up to 4 hours away. Run one more
   * sync shortly after boot when that happened.
   */
  scheduleBootRetry() {
    const timedOut = (this.matchAggregator && this.matchAggregator.lastSyncTimedOut) || [];
    if (timedOut.length === 0) return;
    console.log(`[CronService] ${timedOut.length} provider(s) timed out on the first sync (${timedOut.join(', ')}); retrying in ${BOOT_RETRY_DELAY_MS / 1000}s.`);
    setTimeout(() => {
      this.runSync().catch((err) => console.error('[CronService] Boot retry sync failed:', err.message));
    }, BOOT_RETRY_DELAY_MS).unref();
  }

  /**
   * Prewarm LIVE matches so hot streams are already resolving when clicked.
   * Deliberately narrow to protect the upstreams: live matches only (no
   * replays, upcoming fixtures or 24/7 networks), at most PREWARM_MAX_MATCHES
   * per tick, one match at a time, and matches whose sources are already in the
   * resolve cache are skipped, so a warm instance makes no upstream requests.
   */
  async prewarmPopular() {
    if (this.prewarming) return;
    this.prewarming = true;
    try {
      const { isMatchLive, isReplayMatch } = require('../catalog');
      const { prewarmMatch } = require('../streams');
      const resolveCache = this.streamResolveCache;
      const matches = this.cacheService ? this.cacheService.getMatches() : [];

      const live = matches.filter((m) => m && m.sources && m.sources.length > 0
        && m.category !== 'networks' && !isReplayMatch(m) && isMatchLive(m));
      live.sort((a, b) => {
        const ap = a.popular === '1' ? 1 : 0;
        const bp = b.popular === '1' ? 1 : 0;
        if (ap !== bp) return bp - ap;
        return (Number(b.date) || 0) - (Number(a.date) || 0);
      });

      const cached = (m) => m.sources.some((s) => resolveCache && resolveCache.get(`${s.source}:${m.id}:${s.id}`));
      const todo = live.filter((m) => !cached(m)).slice(0, PREWARM_MAX_MATCHES);
      if (todo.length === 0) return;

      console.log(`[CronService] Prewarming ${todo.length} live match(es) (of ${live.length} live)`);
      for (const m of todo) {
        await prewarmMatch(m, null);
      }
    } catch (err) {
      console.error('[CronService] Prewarm failed:', err.message);
    } finally {
      this.prewarming = false;
    }
  }

  /** Drop stream-cache entries for matches that are no longer active. */
  pruneStreamCache(activeMatches) {
    try {
      if (!this.streamResolveCache) return;
      const ids = new Set((activeMatches || []).map(m => m && m.id).filter(Boolean));
      this.streamResolveCache.pruneEnded(ids);
    } catch (_) {}
  }
}

module.exports = CronService;
