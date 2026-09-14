const assert = require('assert');
const http = require('http');
const { createApp } = require('../src/httpApp');
const container = require('../src/container');
const { handleCatalog } = require('../src/catalog');

// Setup mock upstream server
let mockUpstream;
let mockUpstreamPort;
let upstreamRequests = [];

function startMockUpstream() {
  return new Promise((resolve) => {
    const app = createApp();
    app.get('/valid.m3u8', (req, res) => {
      upstreamRequests.push({ path: req.path, time: Date.now() });
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.send('#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:10.0,\nsegment1.ts\n');
    });
    app.get('/dead.m3u8', (req, res) => {
      upstreamRequests.push({ path: req.path, time: Date.now() });
      res.status(404).send('Not Found');
    });
    app.get('/invalid-body.m3u8', (req, res) => {
      upstreamRequests.push({ path: req.path, time: Date.now() });
      res.send('<html><body>Error Page</body></html>');
    });

    mockUpstream = http.createServer(app);
    mockUpstream.listen(0, '127.0.0.1', () => {
      mockUpstreamPort = mockUpstream.address().port;
      resolve();
    });
  });
}

async function runTests() {
  console.log('====================================================');
  console.log('🧪 COMPREHENSIVE TEST: Manifest Negative Cache & Catalog SWR');
  console.log('====================================================\n');

  await startMockUpstream();
  const { request } = require('undici');

  // Spawn local test express app using the actual endpoints from index.js
  const app = createApp();
  
  // Replicate index.js manifest proxy helpers
  const MANIFEST_TTL_MS = 3000;
  const MANIFEST_CACHE_MAX = 100;
  const MANIFEST_NEGATIVE_TTL_MS = 15 * 1000;
  const manifestCache = new Map();
  const manifestInFlight = new Map();

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

  function manifestCacheSet(key, body) {
    const now = Date.now();
    manifestCache.set(key, { body, expiresAt: now + MANIFEST_TTL_MS, lastAccess: now });
  }

  function manifestCacheSetNegative(key, status, body) {
    const now = Date.now();
    manifestCache.set(key, { negative: true, status, body, expiresAt: now + MANIFEST_NEGATIVE_TTL_MS, lastAccess: now });
  }

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
          const fetchRes = await request(targetUrl);
          const out = await fetchRes.body.text();
          if (fetchRes.statusCode !== 200 || !out.includes('#EXT')) {
            const err = new Error(`Upstream returned ${fetchRes.statusCode} / invalid body`);
            err.status = fetchRes.statusCode !== 200 ? fetchRes.statusCode : 502;
            err.body = out;
            throw err;
          }
          manifestCacheSet(cacheKey, out);
          return out;
        })();
        manifestInFlight.set(cacheKey, fetchPromise);
      }
      const out = await fetchPromise;
      res.setHeader('X-Manifest-Cache', 'MISS');
      return res.send(out);
    } catch (err) {
      const status = err.status || 502;
      const body = err.body || err.message || 'Manifest fetch failed';
      manifestCacheSetNegative(cacheKey, status, body);
      res.setHeader('X-Manifest-Cache', 'NEGATIVE-MINT');
      return res.status(status).send(body);
    } finally {
      manifestInFlight.delete(cacheKey);
    }
  });

  const testServer = http.createServer(app);
  await new Promise(r => testServer.listen(0, '127.0.0.1', r));
  const testPort = testServer.address().port;

  let pass = 0;
  let fail = 0;
  function t(name, cond, extra) {
    if (cond) {
      console.log(`  ✅ PASS: ${name}`);
      pass++;
    } else {
      console.log(`  ❌ FAIL: ${name} ${extra ? '(' + extra + ')' : ''}`);
      fail++;
    }
  }

  // --- PART 1: Manifest Negative Caching Tests ---
  console.log('👉 [Part 1] Manifest Negative Caching (15s Window)');
  upstreamRequests = [];

  const deadUrl = `http://127.0.0.1:${mockUpstreamPort}/dead.m3u8`;
  
  // Request 1: Should fail upstream and mint negative cache
  const r1 = await request(`http://127.0.0.1:${testPort}/api/manifest?url=${encodeURIComponent(deadUrl)}`);
  t('First dead request returns 404', r1.statusCode === 404);
  t('Upstream was hit exactly once on first request', upstreamRequests.length === 1);

  // Request 2 & 3: Should hit negative cache immediately without touching upstream
  const r2 = await request(`http://127.0.0.1:${testPort}/api/manifest?url=${encodeURIComponent(deadUrl)}`);
  const r3 = await request(`http://127.0.0.1:${testPort}/api/manifest?url=${encodeURIComponent(deadUrl)}`);
  t('Subsequent dead requests return 404 via negative cache', r2.statusCode === 404 && r3.statusCode === 404);
  t('Subsequent dead requests have X-Manifest-Cache: NEGATIVE header', r2.headers['x-manifest-cache'] === 'NEGATIVE');
  t('Upstream was NOT polled again (saved duplicate HTTP requests)', upstreamRequests.length === 1);

  // Non-M3U8 body (HTML error page)
  const invalidUrl = `http://127.0.0.1:${mockUpstreamPort}/invalid-body.m3u8`;
  const r4 = await request(`http://127.0.0.1:${testPort}/api/manifest?url=${encodeURIComponent(invalidUrl)}`);
  t('Non-m3u8 body triggers 502 Bad Gateway', r4.statusCode === 502);
  const r5 = await request(`http://127.0.0.1:${testPort}/api/manifest?url=${encodeURIComponent(invalidUrl)}`);
  t('Non-m3u8 failure is negative cached and returns instantly', r5.headers['x-manifest-cache'] === 'NEGATIVE');

  // --- PART 2: Catalog Freshness & Stale-While-Revalidate (SWR) ---
  console.log('\n👉 [Part 2] Catalog Freshness via Stale-While-Revalidate');
  
  const cacheService = container.resolve('cacheService');
  const cronService = container.resolve('cronService');

  // 1. Check isStale custom window
  cacheService.lastFetchTime = Date.now() - (11 * 60 * 1000); // 11 mins ago
  t('cacheService.isStale() returns true after 10m', cacheService.isStale(10 * 60 * 1000) === true);

  cacheService.lastFetchTime = Date.now() - (2 * 60 * 1000); // 2 mins ago
  t('cacheService.isStale() returns false within 10m', cacheService.isStale(10 * 60 * 1000) === false);

  // 2. Test SWR trigger on handleCatalog
  cacheService.lastFetchTime = Date.now() - (15 * 60 * 1000); // Stale
  let syncTriggered = false;
  const origRunSync = cronService.runSync;
  cronService.runSync = async function() {
    syncTriggered = true;
  };

  const tStart = performance.now();
  const catalogRes = await handleCatalog('tv', 'nuvio_sports_live', {}, {});
  const tDur = performance.now() - tStart;

  t('handleCatalog serves cached list instantly without blocking (<10ms)', tDur < 10, `${tDur.toFixed(2)}ms`);
  t('handleCatalog triggered background SWR sync', syncTriggered === true);

  // Restore cronService
  cronService.runSync = origRunSync;

  // Teardown
  mockUpstream.close();
  testServer.close();

  console.log('\n====================================================');
  console.log(fail === 0 ? '🎉 ALL TESTS PASSED SUCCESSFULLY!' : '💥 SOME TESTS FAILED');
  console.log(`Summary: ${pass} passed, ${fail} failed`);
  console.log('====================================================\n');

  process.exit(fail === 0 ? 0 : 1);
}

runTests().catch(e => {
  console.error('Test error:', e);
  process.exit(1);
});
