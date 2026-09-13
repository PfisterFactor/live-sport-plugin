// Catalog stale-while-revalidate window: once the cache is older than this,
// the next catalog/meta request triggers a background re-sync (see ensureFresh).
const REVALIDATE_AFTER_MS = parseInt(process.env.CATALOG_REVALIDATE_MS, 10) || 10 * 60 * 1000;
const SYNC_INTERVAL_MS = 4 * 60 * 60 * 1000;
const KEEP_ALIVE_INTERVAL_MS = 14 * 60 * 1000;

class CronService {
  constructor({ matchAggregator, streamResolveCache, cacheService }) {
    this.matchAggregator = matchAggregator;
    this.streamResolveCache = streamResolveCache;
    this.cacheService = cacheService;
    this.syncing = false;
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

    const externalUrl = process.env.RENDER_EXTERNAL_URL;
    if (externalUrl) {
      console.log(`[CronService] Keep-alive enabled for ${externalUrl}`);
      setInterval(async () => {
        try {
          console.log(`[CronService] Pinging external URL to prevent sleep...`);
          const { request } = require('undici');
          await request(`${externalUrl}/health`);
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
    }, 1000);
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
