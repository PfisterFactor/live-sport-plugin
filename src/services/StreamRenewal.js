/**
 * StreamRenewal.js — re-mints expiring signed manifest URLs.
 *
 * Every source signs its manifest URL with a lifetime measured from the mint,
 * not from the end of the event (TimStreams ~2.5 h, WatchFooty ~5.9 h,
 * StreamFree ~7.9 h). The URL handed to the player is immutable, so without
 * renewal a long event dies mid-stream and only a manual restart recovers it.
 *
 * The manifest proxy carries a renewal descriptor (source + embed page URL) on
 * the player URL. When the token dies, the proxy asks this service for a fresh
 * signed URL, which it keeps so later polls skip the embed scrape.
 */

const container = require('../container');

/** Minimum gap between embed scrapes for one stream, so a dead stream is not hammered. */
const MIN_RENEW_INTERVAL_MS = 5000;

/**
 * Sources that can re-mint a signed manifest URL.
 * Each renewer takes the embed page URL plus the dead URL and returns
 * { m3u8, referer } or null. Providers are resolved lazily to avoid a cycle.
 */
const RENEWERS = {
  timstreams: (embedUrl) => container.resolve('timStreamsProvider').extractM3u8(embedUrl),
  embedst: (embedUrl) => container.resolve('embedStProvider').extractM3u8(embedUrl),
  embedindia: (embedUrl) => container.resolve('embedIndiaProvider').extractM3u8(embedUrl),
  dlive: (embedUrl) => container.resolve('dliveProvider').extractM3u8(embedUrl),
  streamfree: (embedUrl, deadUrl) => container.resolve('streamFreeProvider').refreshSignedUrl(embedUrl, deadUrl),
  sportsembed: async (embedUrl) => {
    const { extractSportsEmbed } = require('../providers/SportsEmbedExtractor');
    const m3u8 = await extractSportsEmbed(embedUrl);
    return m3u8 ? { m3u8, referer: 'https://sportsembed.su/' } : null;
  },
};

const current = new Map();   // key -> { url, referer, mintedAt }
const inFlight = new Map();  // key -> Promise<{ url, referer } | null>

/**
 * Streams are keyed by the URL the player was originally given, so two
 * qualities behind one embed page never share a renewed URL.
 */
function cacheKey(source, embedUrl, baseUrl) {
  return `${source}|${embedUrl}|${baseUrl}`;
}

/** True when the source knows how to re-mint its signed URL. */
function isRenewable(source) {
  return typeof source === 'string' && Object.prototype.hasOwnProperty.call(RENEWERS, source);
}

/** Latest known good URL for this stream, or null when none is usable. */
function currentUrl(source, embedUrl, baseUrl) {
  const entry = current.get(cacheKey(source, embedUrl, baseUrl));
  if (!entry || entry.stale) return null;
  return { url: entry.url, referer: entry.referer };
}

/**
 * Marks the remembered URL unusable — its token died or its edge host stopped
 * answering. The entry survives so the mint interval still rate-limits scrapes.
 */
function forget(source, embedUrl, baseUrl) {
  const entry = current.get(cacheKey(source, embedUrl, baseUrl));
  if (entry) entry.stale = true;
}

/**
 * Mints a fresh signed URL for the stream, single-flight per stream.
 * Returns null when the source cannot renew, the scrape fails, or the last
 * mint is younger than MIN_RENEW_INTERVAL_MS.
 */
async function renew(source, embedUrl, baseUrl) {
  if (!isRenewable(source)) return null;
  const key = cacheKey(source, embedUrl, baseUrl);

  const pending = inFlight.get(key);
  if (pending) return await pending;

  const existing = current.get(key);
  if (existing && Date.now() - existing.mintedAt < MIN_RENEW_INTERVAL_MS) return null;

  const task = (async () => {
    try {
      const result = await RENEWERS[source](embedUrl, existing ? existing.url : baseUrl);
      if (!result || !result.m3u8) return null;
      const entry = { url: result.m3u8, referer: result.referer || null, mintedAt: Date.now() };
      current.set(key, entry);
      console.log(`[StreamRenewal] re-minted ${source} manifest: ${entry.url}`);
      return { url: entry.url, referer: entry.referer };
    } catch (err) {
      console.warn(`[StreamRenewal] renew failed for ${source} ${embedUrl}:`, err.message);
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, task);
  return await task;
}

/** Drops all remembered URLs. Test-only. */
function reset() {
  current.clear();
  inFlight.clear();
}

module.exports = { isRenewable, currentUrl, forget, renew, reset, MIN_RENEW_INTERVAL_MS };
