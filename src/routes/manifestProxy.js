/**
 * manifestProxy.js — /api/manifest HLS proxy.
 *
 * Live HLS players reload the manifest every 2-6 s per viewer. A validated
 * short-TTL cache plus request coalescing removes per-viewer TLS handshakes and
 * repeated upstream fetches. Key = url|referer|origin. Only bodies containing
 * #EXT are cached; failures are cached negatively so polls stop hammering a
 * dead upstream.
 */

const { safeFetch: _safeFetch } = require('../impitClient');

const MANIFEST_TTL_MS = 3000;
const MANIFEST_CACHE_MAX = 100;
const MANIFEST_NEGATIVE_TTL_MS = 15 * 1000;
const manifestCache = new Map();      // key -> { body, expiresAt, lastAccess }
const manifestInFlight = new Map();   // key -> Promise (coalesced upstream fetch)

/** Returns the stored cache entry (positive or negative), or null when missing/expired. */
function manifestCacheGet(key) {
  const e = manifestCache.get(key);
  if (!e) return null;
  const now = Date.now();
  if (now > e.expiresAt) {
    manifestCache.delete(key);
    return null;
  }
  e.lastAccess = now;
  return e;
}

/** Stores a successful manifest body under the given TTL. */
function manifestCacheSet(key, body, ttlMs = MANIFEST_TTL_MS) {
  const now = Date.now();
  manifestCache.set(key, { body, expiresAt: now + ttlMs, lastAccess: now });
  evictManifestCacheIfNeeded();
}

/** Drops least-recently-accessed entries once the cache exceeds its cap. */
function evictManifestCacheIfNeeded() {
  if (manifestCache.size > MANIFEST_CACHE_MAX) {
    const byAccess = [...manifestCache.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    const excess = manifestCache.size - MANIFEST_CACHE_MAX;
    for (let i = 0; i < excess; i++) manifestCache.delete(byAccess[i][0]);
  }
}

/** Briefly stores a dead upstream result so player polls stop re-fetching it. */
function manifestCacheSetNegative(key, status, body) {
  const now = Date.now();
  manifestCache.set(key, { negative: true, status, body, expiresAt: now + MANIFEST_NEGATIVE_TTL_MS, lastAccess: now });
  evictManifestCacheIfNeeded();
}

/**
 * Fetches the upstream manifest. Throws on failure so coalesced waiters share
 * the same outcome; successful bodies are cached by the caller.
 */
async function fetchUpstreamManifest(targetUrl, referer, origin) {
  const headers = {
    'Referer': referer,
    'Origin': origin,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
  };
  // A hard 10 s timeout ensures a hung upstream can never hold the viewer's poll.
  const result = await _safeFetch(targetUrl, { headers, timeoutMs: 10000 });
  if (!result.ok) throw new Error(`HTTP ${result.status}`);
  return await result.text();
}

/** Mounts GET /api/manifest on the given Express app. */
function mount(app) {
  app.get('/api/manifest', async (req, res) => {
    const targetUrl = req.query.url;
    const referer = req.query.referer || 'https://embed.st/';
    const origin = req.query.origin || 'https://embed.st';

    if (!targetUrl) return res.status(400).send('Missing url');

    const cacheKey = `${targetUrl}|${referer}|${origin}`;
    const entry = manifestCacheGet(cacheKey);
    if (entry && entry.negative) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('X-Manifest-Cache', 'NEGATIVE');
      return res.status(entry.status).send(entry.body);
    }
    if (entry) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('X-Manifest-Cache', 'HIT');
      return res.send(entry.body);
    }

    try {
      let fetchPromise = manifestInFlight.get(cacheKey);
      if (!fetchPromise) {
        fetchPromise = (async () => {
          let out = await fetchUpstreamManifest(targetUrl, referer, origin);
          if (!out.includes('#EXT')) {
            console.error('[ManifestProxy] Upstream returned non-m3u8 body for', targetUrl);
            throw new Error('Upstream returned non-m3u8 body');
          }

          let dynamicTtl = MANIFEST_TTL_MS;
          try {
            const m3u8Parser = require('m3u8-parser');
            const parser = new m3u8Parser.Parser();
            parser.push(out);
            parser.end();
            if (parser.manifest.targetDuration) {
              dynamicTtl = (parser.manifest.targetDuration * 1000) / 2;
            }
          } catch (e) {
            // Fallback to default TTL on parse error
          }

          const isLive = !out.includes('#EXT-X-ENDLIST');
          let injectedStart = out.includes('#EXT-X-START');

          const lines = out.split('\n');
          const rewritten = lines.map(line => {
            const l = line.trim();

            let resultLine = line;

            if (isLive && !injectedStart && (l === '#EXTM3U' || l.startsWith('#EXT-X-VERSION'))) {
              const carriageReturn = line.endsWith('\r') ? '\r' : '';
              resultLine = `${line}\n#EXT-X-START:TIME-OFFSET=-15${carriageReturn}`;
              injectedStart = true;
            }

            if (!l || l.startsWith('#')) return resultLine;

            let absoluteUrl = l;
            try {
              const chunkUrl = new URL(l, targetUrl);
              const manifestUrl = new URL(targetUrl);

              manifestUrl.searchParams.forEach((val, key) => {
                if (!chunkUrl.searchParams.has(key)) {
                  chunkUrl.searchParams.set(key, val);
                }
              });
              absoluteUrl = chunkUrl.toString();
            } catch (err) {
              absoluteUrl = l;
            }

            if (absoluteUrl.includes('.m3u8')) {
              return `/api/manifest?url=${encodeURIComponent(absoluteUrl)}&referer=${encodeURIComponent(referer)}&origin=${encodeURIComponent(origin)}`;
            }

            if ((absoluteUrl.includes('.image') || absoluteUrl.includes('.js')) && !absoluteUrl.includes('.ts') && !absoluteUrl.includes('.m3u8')) {
              absoluteUrl += '#.ts';
            }
            return absoluteUrl;
          });

          const rewrittenResult = rewritten.join('\n');
          manifestCacheSet(cacheKey, rewrittenResult, dynamicTtl);
          return rewrittenResult;
        })().finally(() => {
          manifestInFlight.delete(cacheKey);
        });
        manifestInFlight.set(cacheKey, fetchPromise);
      }

      const finalBody = await fetchPromise;
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('X-Manifest-Cache', 'MISS');
      res.send(finalBody);
    } catch (err) {
      // 404 semantics let players fail over to another stream.
      if (err.message === 'Upstream returned non-m3u8 body') {
        manifestCacheSetNegative(cacheKey, 404, 'Stream not found or expired');
        return res.status(404).send('Stream not found or expired');
      }
      console.error('[ManifestProxy] Error:', err.message);
      manifestCacheSetNegative(cacheKey, 502, 'Manifest proxy error: ' + err.message);
      return res.status(502).send('Manifest proxy error: ' + err.message);
    }
  });
}

module.exports = { mount };
