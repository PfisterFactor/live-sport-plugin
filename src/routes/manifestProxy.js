/**
 * manifestProxy.js — /api/manifest HLS proxy.
 *
 * Live HLS players reload the manifest every 2-6 s per viewer. A validated
 * short-TTL cache plus request coalescing removes per-viewer TLS handshakes and
 * repeated upstream fetches. Key = url|referer|origin. Only bodies containing
 * #EXT are cached; failures are cached negatively so polls stop hammering a
 * dead upstream.
 */

const impitClient = require('../impitClient');
const { parsePlaylist } = require('../services/m3u8');
const renewal = require('../services/StreamRenewal');
const guard = require('../services/OutboundUrlGuard');
const net = require('net');

const MANIFEST_TTL_MS = 3000;
const MANIFEST_CACHE_MAX = 100;
const MANIFEST_NEGATIVE_TTL_MS = 2000;
const MAX_START_OFFSET_S = 15;
const LIVE_EDGE_HOLDBACK_SEGMENTS = 3;
const manifestCache = new Map();      // key -> { body, expiresAt, lastAccess }
const manifestInFlight = new Map();   // key -> Promise (coalesced upstream fetch)

const ALLOWED_PROXY_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Validates a user-supplied proxy target syntactically. Returns the parsed
 * URL, or null when the scheme is not http(s) or the host is a reserved name or
 * a blocked IP literal. Hostnames that merely resolve to an internal address
 * are caught by the DNS-aware guard on the fetch itself (see guardedUrl).
 */
function parseSafeTargetUrl(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  let candidate = raw;
  if (candidate.includes('%')) {
    try { candidate = decodeURIComponent(candidate); } catch (_) { /* use raw */ }
  }
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch (_) {
    return null;
  }
  if (!ALLOWED_PROXY_PROTOCOLS.has(parsed.protocol)) return null;
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return null;
  if (net.isIP(host)) return guard.classifyAddress(host) ? null : parsed;
  if (guard.isReservedHostname(host)) return null;
  return parsed;
}

/** DNS-aware SSRF check applied to the manifest URL and every redirect hop. */
function guardedUrl(url) {
  return guard.assertOutboundUrl(url);
}

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

const NON_M3U8 = 'Upstream returned non-m3u8 body';
const TOKEN_DEAD_STATUSES = new Set([403, 404, 410]);

/**
 * Fetches the upstream manifest. Throws on failure so coalesced waiters share
 * the same outcome; successful bodies are cached by the caller. Live players
 * poll this on every segment, so the budget is one attempt and short.
 */
async function fetchUpstreamManifest(targetUrl, referer, origin) {
  const headers = {
    'Referer': referer,
    'Origin': origin,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
  };
  const result = await impitClient.safeFetch(targetUrl, { headers, timeoutMs: 5000, attempts: 1, validateUrl: guardedUrl });
  if (!result.ok) {
    const err = new Error(`HTTP ${result.status}`);
    err.status = result.status;
    throw err;
  }
  const body = await result.text();
  if (!body.includes('#EXT')) {
    console.error('[ManifestProxy] Upstream returned non-m3u8 body for', targetUrl);
    const err = new Error(NON_M3U8);
    err.status = 404;
    throw err;
  }
  return body;
}

/** True when the failure looks like a dead signing token rather than a transport blip. */
function isTokenDead(err) {
  return !!err && (err.message === NON_M3U8 || TOKEN_DEAD_STATUSES.has(err.status));
}

/** Rebuilds a child playlist URL against a re-minted parent manifest. */
function resolveAgainst(parentUrl, rel) {
  if (!rel) return parentUrl;
  try {
    return new URL(rel, parentUrl).toString();
  } catch (_) {
    return parentUrl;
  }
}

/**
 * Seconds behind the live edge to start playback, or 0 to leave the player's
 * default. Starting deeper than the default only helps when the window has
 * room; the oldest segments leave the window on the next refresh.
 */
function startOffsetSeconds(targetDuration, totalDuration) {
  if (!targetDuration || !totalDuration) return 0;
  const holdback = LIVE_EDGE_HOLDBACK_SEGMENTS * targetDuration;
  const offset = Math.min(MAX_START_OFFSET_S, totalDuration - holdback);
  return offset > holdback ? offset : 0;
}

function setPlaylistHeaders(res) {
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
}

/**
 * Rewrites a live manifest for the player: injects the live-edge start offset,
 * absolutizes chunk URLs against the manifest they came from, and routes nested
 * playlists back through this proxy.
 */
function rewriteManifest(out, manifestUrl, referer, origin, descriptor) {
  const { targetDuration, totalDuration } = parsePlaylist(out);
  const ttlMs = targetDuration ? (targetDuration * 1000) / 2 : MANIFEST_TTL_MS;

  const isLive = !out.includes('#EXT-X-ENDLIST');
  const startOffset = isLive && !out.includes('#EXT-X-START') ? startOffsetSeconds(targetDuration, totalDuration) : 0;
  let injectedStart = startOffset === 0;

  const rewritten = out.split('\n').map(line => {
    const l = line.trim();

    let resultLine = line;

    if (!injectedStart && (l === '#EXTM3U' || l.startsWith('#EXT-X-VERSION'))) {
      const carriageReturn = line.endsWith('\r') ? '\r' : '';
      resultLine = `${line}\n#EXT-X-START:TIME-OFFSET=-${startOffset}${carriageReturn}`;
      injectedStart = true;
    }

    if (!l || l.startsWith('#')) return resultLine;

    let absoluteUrl = l;
    try {
      const chunkUrl = new URL(l, manifestUrl);
      const parsedManifest = new URL(manifestUrl);

      parsedManifest.searchParams.forEach((val, key) => {
        if (!chunkUrl.searchParams.has(key)) {
          chunkUrl.searchParams.set(key, val);
        }
      });
      absoluteUrl = chunkUrl.toString();
    } catch (err) {
      absoluteUrl = l;
    }

    if (absoluteUrl.includes('.m3u8')) {
      let child = `/api/manifest?url=${encodeURIComponent(absoluteUrl)}&referer=${encodeURIComponent(referer)}&origin=${encodeURIComponent(origin)}`;
      if (descriptor) {
        // `rel` lets a child playlist be rebuilt against a re-minted parent.
        child += `&renew=${encodeURIComponent(descriptor.source)}`
          + `&embed=${encodeURIComponent(descriptor.embed)}`
          + `&base=${encodeURIComponent(descriptor.base)}`
          + `&rel=${encodeURIComponent(l)}`;
      }
      return child;
    }

    if ((absoluteUrl.includes('.image') || absoluteUrl.includes('.js')) && !absoluteUrl.includes('.ts') && !absoluteUrl.includes('.m3u8')) {
      absoluteUrl += '#.ts';
    }
    return absoluteUrl;
  });

  return { body: rewritten.join('\n'), ttlMs };
}

/** Mounts GET /api/manifest on the given Express app. */
function mount(app) {
  app.get('/api/manifest', async (req, res) => {
    const targetUrl = req.query.url;
    const referer = req.query.referer || 'https://embed.st/';
    const origin = req.query.origin || 'https://embed.st';
    const renewSource = req.query.renew;
    const renewEmbed = req.query.embed;
    const renewRel = typeof req.query.rel === 'string' ? req.query.rel : null;

    if (!targetUrl) return res.status(400).send('Missing url');
    if (!parseSafeTargetUrl(targetUrl)) {
      console.warn('[ManifestProxy] Blocked unsafe target URL:', targetUrl);
      return res.status(400).send('Invalid url');
    }

    const renewable = typeof renewEmbed === 'string'
      && renewal.isRenewable(renewSource)
      && !!parseSafeTargetUrl(renewEmbed);

    // A child playlist renews through its parent, so both share one base key.
    const renewBase = renewable && typeof req.query.base === 'string' ? req.query.base : targetUrl;
    const descriptor = renewable ? { source: renewSource, embed: renewEmbed, base: renewBase } : null;

    const cacheKey = `${targetUrl}|${referer}|${origin}`;
    const entry = manifestCacheGet(cacheKey);
    if (entry && entry.negative) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Manifest-Cache', 'NEGATIVE');
      return res.status(entry.status).send(entry.body);
    }
    if (entry) {
      setPlaylistHeaders(res);
      res.setHeader('X-Manifest-Cache', 'HIT');
      return res.send(entry.body);
    }

    try {
      let fetchPromise = manifestInFlight.get(cacheKey);
      if (!fetchPromise) {
        fetchPromise = (async () => {
          let manifestUrl = targetUrl;
          let manifestReferer = referer;
          let usedRenewed = false;

          if (renewable) {
            const known = renewal.currentUrl(renewSource, renewEmbed, renewBase);
            if (known) {
              manifestUrl = resolveAgainst(known.url, renewRel);
              if (known.referer) manifestReferer = known.referer;
              usedRenewed = true;
            }
          }

          let out;
          try {
            out = await fetchUpstreamManifest(manifestUrl, manifestReferer, origin);
          } catch (err) {
            // A remembered URL that fails for any reason (dead token, dead edge
            // host) is dropped, so the next poll mints a new one.
            if (!renewable || !(usedRenewed || isTokenDead(err))) throw err;
            if (usedRenewed) renewal.forget(renewSource, renewEmbed, renewBase);
            const fresh = await renewal.renew(renewSource, renewEmbed, renewBase);
            if (!fresh) throw err;
            manifestUrl = resolveAgainst(fresh.url, renewRel);
            if (fresh.referer) manifestReferer = fresh.referer;
            out = await fetchUpstreamManifest(manifestUrl, manifestReferer, origin);
          }

          const { body, ttlMs } = rewriteManifest(out, manifestUrl, manifestReferer, origin, descriptor);
          manifestCacheSet(cacheKey, body, ttlMs);
          return body;
        })().finally(() => {
          manifestInFlight.delete(cacheKey);
        });
        manifestInFlight.set(cacheKey, fetchPromise);
      }

      const finalBody = await fetchPromise;
      setPlaylistHeaders(res);
      res.setHeader('X-Manifest-Cache', 'MISS');
      res.send(finalBody);
    } catch (err) {
      res.setHeader('Cache-Control', 'no-store');
      if (err.message === NON_M3U8) {
        manifestCacheSetNegative(cacheKey, 404, 'Stream not found or expired');
        return res.status(404).send('Stream not found or expired');
      }
      if (err.blocked) {
        console.warn('[ManifestProxy] Blocked outbound URL:', err.message);
        return res.status(403).send('Blocked outbound URL');
      }
      console.error('[ManifestProxy] Error:', err.message);
      manifestCacheSetNegative(cacheKey, 502, 'Manifest proxy error: ' + err.message);
      return res.status(502).send('Manifest proxy error: ' + err.message);
    }
  });
}

module.exports = { mount, parseSafeTargetUrl };
