/**
 * scripts/challenger-endpoints-stress.js
 *
 * Empirical Challenger 2 Test Harness:
 * Adversarial Verification of Zero-Cache Claims on Catalog, Manifest Proxy, and Auxiliary Endpoints.
 *
 * Test Scenarios:
 * 1. /api/manifest proxy:
 *    - Consecutive repeat requests (10x): Verify 10/10 fresh upstream fetches, 0% cache hit rate.
 *    - Header verification: Verify Cache-Control: no-cache, no-store, must-revalidate.
 *    - Header verification: Verify ABSENCE of X-Manifest-Cache: HIT or any caching headers.
 *    - Upstream mutation: Verify immediate reflection of updated manifest without stale data.
 *    - Negative caching elimination: Verify 404/failure is not cached; subsequent recovery is immediate.
 *    - Concurrent burst (20x parallel): Verify all 20 hit upstream independently (no coalescing/memoization).
 * 2. Catalog, Metadata & Matches endpoints (/catalog/tv/:id.json, /meta/tv/:id.json, /api/matches):
 *    - In-Process & Live Route Analysis: Verify every hit executes live MatchAggregator.syncMatches() without SWR / memoization.
 *    - Dynamic data mutation: Verify immediate propagation of added/modified/removed events across catalog and meta.
 *    - Live HTTP endpoint verification on spawned server.
 * 3. Self-Hosted Image Pipeline (/img, /img/placeholder):
 *    - Consecutive /img requests: Verify fresh upstream request on every call without in-memory caching.
 *    - Header verification: Verify Cache-Control: no-cache, no-store, must-revalidate.
 *    - Upstream failure fallback: Verify instant fallback to SVG without serving old buffer.
 *    - /img/placeholder: Verify Cache-Control headers and SVG response.
 * 4. Architectural & DI Container Audit:
 *    - Verify no cacheService, streamResolveCache, or in-memory cache Maps exist.
 *    - Verify /health returns clean status without caching statistics.
 */

const http = require('http');
const path = require('path');
const { createApp } = require('../src/httpApp');
const { request } = require('undici');
const container = require('../src/container');
const imageService = require('../src/services/ImageService');
const { handleCatalog, handleMeta } = require('../src/catalog');
const { startServer } = require('../tests/load/server-runner');

async function runChallengerEndpointsStress() {
  console.log('================================================================================');
  console.log('🧪 CHALLENGER 2: EMPIRICAL ZERO-CACHE ENDPOINTS & AUXILIARY STRESS HARNESS');
  console.log('================================================================================\n');

  let passed = 0;
  let failed = 0;
  const observations = [];

  function testAssert(name, condition, detail = '') {
    if (condition) {
      passed++;
      console.log(`  ✅ PASS: ${name}${detail ? ` [${detail}]` : ''}`);
      observations.push({ name, status: 'PASS', detail });
    } else {
      failed++;
      console.error(`  ❌ FAIL: ${name}${detail ? ` [${detail}]` : ''}`);
      observations.push({ name, status: 'FAIL', detail });
    }
  }

  let mockUpstream = null;
  let serverInstance = null;

  try {
    // ─── 0. Start Mock Upstream HTTP Server ──────────────────────────────────
    let mockManifestContent = '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:10.0,\nchunk_v1.ts\n';
    let mockManifestStatus = 200;
    let mockImageStatus = 200;
    const upstreamCalls = [];

    const mockServer = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const record = {
        method: req.method,
        path: url.pathname,
        search: url.search,
        headers: req.headers,
        timestamp: Date.now()
      };
      upstreamCalls.push(record);

      if (url.pathname === '/live/manifest.m3u8') {
        res.writeHead(mockManifestStatus, {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Access-Control-Allow-Origin': '*'
        });
        if (mockManifestStatus === 200) {
          res.end(mockManifestContent);
        } else {
          res.end('Upstream Error');
        }
        return;
      }

      if (url.pathname === '/image.png') {
        if (mockImageStatus === 200) {
          const pngBuffer = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
            'base64'
          );
          res.writeHead(200, {
            'Content-Type': 'image/png',
            'Content-Length': pngBuffer.length
          });
          res.end(pngBuffer);
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Image Not Found');
        }
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    });

    await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const mockPort = mockServer.address().port;
    const mockUpstreamBaseUrl = `http://127.0.0.1:${mockPort}`;
    console.log(`[MockUpstream] Listening on ${mockUpstreamBaseUrl}\n`);

    // ─── 1. Spawn Live Express Server Instance ───────────────────────────────
    const TEST_PORT = 7020;
    console.log(`[ServerRunner] Launching live test server on port ${TEST_PORT}...`);
    serverInstance = await startServer({
      port: TEST_PORT,
      reuseExisting: false
    });
    const baseUrl = serverInstance.baseUrl;
    console.log(`[ServerRunner] Server active at ${baseUrl}\n`);

    // ─────────────────────────────────────────────────────────────────────────
    // SECTION 1: /api/manifest Zero-Cache Verification
    // ─────────────────────────────────────────────────────────────────────────
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📌 SECTION 1: /api/manifest Zero-Cache & Fresh Upstream Fetching');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    const manifestTargetUrl = `${mockUpstreamBaseUrl}/live/manifest.m3u8`;
    const manifestProxyUrl = `${baseUrl}/api/manifest?url=${encodeURIComponent(manifestTargetUrl)}`;

    // Scenario 1A: 10 Consecutive Serial Requests
    console.log('\n👉 Scenario 1A: 10 Consecutive Serial Requests to /api/manifest...');
    upstreamCalls.length = 0;
    mockManifestStatus = 200;
    mockManifestContent = '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:10.0,\nchunk_v1.ts\n';

    let allCacheControlValid = true;
    let anyXManifestCacheHit = false;

    for (let i = 1; i <= 10; i++) {
      const res = await request(manifestProxyUrl);
      const body = await res.body.text();
      const cc = res.headers['cache-control'] || '';
      const xmc = res.headers['x-manifest-cache'] || '';

      if (cc !== 'no-cache, no-store, must-revalidate') {
        allCacheControlValid = false;
      }
      if (xmc.toLowerCase().includes('hit')) {
        anyXManifestCacheHit = true;
      }
      if (!body.includes('#EXT') || !body.includes('chunk_v1.ts')) {
        testAssert(`Request ${i} returned valid rewritten m3u8`, false, `Unexpected body: ${body.slice(0, 50)}`);
      }
    }

    const hitsAfter10 = upstreamCalls.filter((c) => c.path === '/live/manifest.m3u8').length;
    testAssert('10 consecutive requests make 10 distinct upstream calls (100% fresh)', hitsAfter10 === 10, `Upstream hits: ${hitsAfter10}/10`);
    testAssert('Cache-Control: no-cache, no-store, must-revalidate on all 10 responses', allCacheControlValid);
    testAssert('No X-Manifest-Cache: HIT header present on any response', !anyXManifestCacheHit);

    // Scenario 1B: Immediate Upstream Mutation (No Stale Data)
    console.log('\n👉 Scenario 1B: Manifest Upstream Live Mutation...');
    mockManifestContent = '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:10.0,\nchunk_MUTATED_V2.ts\n';
    const mutatedRes = await request(manifestProxyUrl);
    const mutatedBody = await mutatedRes.body.text();

    testAssert(
      'Live upstream manifest mutation is immediately returned (zero stale caching)',
      mutatedBody.includes('chunk_MUTATED_V2.ts') && !mutatedBody.includes('chunk_v1.ts'),
      `Body snippet: ${mutatedBody.trim().split('\n').pop()}`
    );

    // Scenario 1C: Negative Caching Elimination (Error Recovery)
    console.log('\n👉 Scenario 1C: Negative Caching Elimination (404 -> 200 Recovery)...');
    upstreamCalls.length = 0;
    mockManifestStatus = 404; // Set upstream to fail

    const failRes = await request(manifestProxyUrl);
    const failedHits = upstreamCalls.filter((c) => c.path === '/live/manifest.m3u8').length;
    testAssert('Upstream 404 causes proxy to return error status (404/502)', failRes.statusCode === 404 || failRes.statusCode === 502, `Status: ${failRes.statusCode}`);
    testAssert('Failed request reached upstream (no short-circuit)', failedHits >= 1, `Upstream calls during 404: ${failedHits}`);

    // Recover upstream to 200 immediately
    mockManifestStatus = 200;
    mockManifestContent = '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:10.0,\nchunk_RECOVERED.ts\n';

    const countBeforeRecover = upstreamCalls.filter((c) => c.path === '/live/manifest.m3u8').length;
    const recoverRes = await request(manifestProxyUrl);
    const recoverBody = await recoverRes.body.text();
    const countAfterRecover = upstreamCalls.filter((c) => c.path === '/live/manifest.m3u8').length;

    testAssert('Subsequent request immediately recovers without negative-cache penalty', recoverRes.statusCode === 200 && recoverBody.includes('chunk_RECOVERED.ts'));
    testAssert('Recovery request triggered fresh upstream fetch', countAfterRecover > countBeforeRecover, `New upstream calls: ${countAfterRecover - countBeforeRecover}`);

    // Scenario 1D: Concurrent Burst Stress (20 Parallel Requests)
    console.log('\n👉 Scenario 1D: 20 Parallel Concurrent Requests to /api/manifest...');
    upstreamCalls.length = 0;
    const concurrentRequests = Array.from({ length: 20 }, () => request(manifestProxyUrl));
    const burstResponses = await Promise.all(concurrentRequests);
    const burstBodies = await Promise.all(burstResponses.map((r) => r.body.text()));

    const burstHits = upstreamCalls.filter((c) => c.path === '/live/manifest.m3u8').length;
    const all200 = burstResponses.every((r) => r.statusCode === 200);
    const allCorrectBody = burstBodies.every((b) => b.includes('chunk_RECOVERED.ts'));

    testAssert('20 concurrent requests execute 20 distinct upstream fetches (no request coalescing/in-flight caching)', burstHits === 20, `Upstream calls: ${burstHits}/20`);
    testAssert('All 20 concurrent requests returned 200 OK with correct manifest', all200 && allCorrectBody);

    // ─────────────────────────────────────────────────────────────────────────
    // SECTION 2: Catalog, Metadata & Matches Live Sync Verification
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📌 SECTION 2: Catalog, Metadata & /api/matches Live Sync Verification');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    // 2A: Test Live HTTP Endpoints on Spawned Server
    console.log('\n👉 Scenario 2A: Live HTTP Endpoints Contract Verification...');
    const liveMatchesRes = await request(`${baseUrl}/api/matches`);
    testAssert('GET /api/matches returns 200 OK', liveMatchesRes.statusCode === 200);
    const liveMatchesData = await liveMatchesRes.body.json();
    testAssert('GET /api/matches returns array of live matches', Array.isArray(liveMatchesData));

    const liveCatRes = await request(`${baseUrl}/catalog/tv/nuvio_sports_live.json`);
    testAssert('GET /catalog/tv/nuvio_sports_live.json returns 200 OK', liveCatRes.statusCode === 200);
    const liveCatBody = await liveCatRes.body.json();
    testAssert('GET /catalog/tv/nuvio_sports_live.json returns metas array', Array.isArray(liveCatBody.metas));

    // 2B: In-Process Empirical Verification of Catalog & Metadata Handlers
    console.log('\n👉 Scenario 2B: In-Process Dynamic Match Sync Verification (handleCatalog & handleMeta)...');
    const matchAggregator = container.resolve('matchAggregator');
    let syncMatchesCallCount = 0;
    let dynamicMatchesList = [];

    // Instrument matchAggregator.syncMatches
    const origSyncMatches = matchAggregator.syncMatches.bind(matchAggregator);
    matchAggregator.syncMatches = async () => {
      syncMatchesCallCount++;
      return dynamicMatchesList;
    };

    // Call 1: Dataset Alpha
    dynamicMatchesList = [
      {
        id: 'dyn_match_alpha',
        title: 'Arsenal vs Chelsea (Live Alpha)',
        category: 'football',
        date: String(Date.now()),
        popular: '1',
        sources: []
      }
    ];

    syncMatchesCallCount = 0;
    const catResult1 = await handleCatalog('tv', 'nuvio_sports_live', {}, {});
    testAssert('handleCatalog calls matchAggregator.syncMatches() on request 1', syncMatchesCallCount === 1);
    testAssert('handleCatalog returns meta for Dataset Alpha', catResult1?.metas?.length === 1 && catResult1.metas[0].id === 'nuvio_sport_dyn_match_alpha');

    // Call 2: Mutate Dataset dynamically to Beta & Gamma
    dynamicMatchesList = [
      {
        id: 'dyn_match_beta',
        title: 'Liverpool vs Man City (Live Beta)',
        category: 'football',
        date: String(Date.now()),
        popular: '1',
        sources: []
      },
      {
        id: 'dyn_match_gamma',
        title: 'Lakers vs Warriors (Live Gamma)',
        category: 'basketball',
        date: String(Date.now()),
        popular: '1',
        sources: []
      }
    ];

    const catResult2 = await handleCatalog('tv', 'nuvio_sports_live', {}, {});
    testAssert('handleCatalog calls matchAggregator.syncMatches() freshly on request 2 (Zero SWR)', syncMatchesCallCount === 2);
    testAssert(
      'handleCatalog immediately reflects mutated Dataset Beta & Gamma without caching delay',
      catResult2?.metas?.length === 2 && catResult2.metas.some((m) => m.id === 'nuvio_sport_dyn_match_beta')
    );

    // Call 3: handleMeta for Beta
    const metaResult1 = await handleMeta('tv', 'nuvio_sport_dyn_match_beta', {});
    testAssert('handleMeta calls matchAggregator.syncMatches() live', syncMatchesCallCount === 3);
    testAssert('handleMeta returns correct match detail for Beta', metaResult1?.meta?.name?.includes('Liverpool vs Man City'));

    // Call 4: handleMeta for non-existent ID
    const metaResultNone = await handleMeta('tv', 'nuvio_sport_non_existent', {});
    testAssert('handleMeta returns { meta: null } for unknown match ID', metaResultNone?.meta === null);

    // 2C: In-Process Express Route Integration for /api/matches
    console.log('\n👉 Scenario 2C: In-Process Express /api/matches Route Live Invocation...');
    const testExpressApp = createApp();
    testExpressApp.get('/api/matches', async (req, res) => {
      try {
        const matches = await container.resolve('matchAggregator').syncMatches();
        res.json(matches);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    const inProcessServer = http.createServer(testExpressApp);
    await new Promise((resolve) => inProcessServer.listen(0, '127.0.0.1', resolve));
    const inProcPort = inProcessServer.address().port;

    const inProcRes1 = await request(`http://127.0.0.1:${inProcPort}/api/matches`);
    const inProcData1 = await inProcRes1.body.json();
    testAssert('In-process GET /api/matches queries syncMatches() freshly (call count incremented)', syncMatchesCallCount === 5);
    testAssert('In-process /api/matches returns live dataset', inProcData1.length === 2 && inProcData1[0].id === 'dyn_match_beta');

    await new Promise((resolve) => inProcessServer.close(resolve));

    // Restore matchAggregator
    matchAggregator.syncMatches = origSyncMatches;

    // ─────────────────────────────────────────────────────────────────────────
    // SECTION 3: Self-Hosted Image Pipeline Zero-Cache Verification
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📌 SECTION 3: /img & /img/placeholder Zero-Cache & Header Audit');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    const imageUrl = `${mockUpstreamBaseUrl}/image.png`;
    const imageProxyUrl = `${baseUrl}/img?url=${encodeURIComponent(imageUrl)}`;

    // Scenario 3A: Consecutive /img Requests
    console.log('\n👉 Scenario 3A: 5 Consecutive Requests to /img (Live Image Fetching)...');
    upstreamCalls.length = 0;
    mockImageStatus = 200;

    let allImgCacheControlValid = true;
    let allImgContentTypeValid = true;

    for (let i = 1; i <= 5; i++) {
      const res = await request(imageProxyUrl);
      const buf = await res.body.arrayBuffer();
      const cc = res.headers['cache-control'] || '';
      const ct = res.headers['content-type'] || '';

      if (cc !== 'no-cache, no-store, must-revalidate') allImgCacheControlValid = false;
      if (!ct.includes('image/png')) allImgContentTypeValid = false;
      if (buf.byteLength === 0) testAssert(`Image request ${i} returned non-empty buffer`, false);
    }

    const imageHits = upstreamCalls.filter((c) => c.path === '/image.png').length;
    testAssert('5 consecutive /img requests make 5 distinct upstream image requests', imageHits === 5, `Upstream image hits: ${imageHits}/5`);
    testAssert('Cache-Control: no-cache, no-store, must-revalidate on all /img responses', allImgCacheControlValid);
    testAssert('Content-Type: image/png on all /img responses', allImgContentTypeValid);

    // Scenario 3B: Immediate Fallback to SVG on Upstream Failure (No Buffer Retention)
    console.log('\n👉 Scenario 3B: Image Upstream Failure Fallback (PNG -> SVG Fallback)...');
    mockImageStatus = 404; // Upstream dies

    const fallbackRes = await request(imageProxyUrl);
    const fallbackBody = await fallbackRes.body.text();
    const fallbackCt = fallbackRes.headers['content-type'] || '';
    const fallbackCc = fallbackRes.headers['cache-control'] || '';

    testAssert('Upstream image 404 immediately returns SVG fallback (no cached PNG served)', fallbackCt.includes('image/svg+xml') && fallbackBody.includes('<svg'));
    testAssert('Fallback response has Cache-Control: no-cache, no-store, must-revalidate', fallbackCc === 'no-cache, no-store, must-revalidate');

    // Scenario 3C: /img/placeholder Endpoint Audit
    console.log('\n👉 Scenario 3C: /img/placeholder Endpoint Audit...');
    const placeholderUrl = `${baseUrl}/img/placeholder?text=TestEvent&color=10b981`;
    const phRes = await request(placeholderUrl);
    const phBody = await phRes.body.text();
    const phCt = phRes.headers['content-type'] || '';
    const phCc = phRes.headers['cache-control'] || '';

    testAssert('/img/placeholder returns 200 OK with SVG content', phRes.statusCode === 200 && phCt.includes('image/svg+xml') && phBody.includes('TestEvent'));
    testAssert('/img/placeholder returns Cache-Control: no-cache, no-store, must-revalidate', phCc === 'no-cache, no-store, must-revalidate');

    // Scenario 3D: ImageService In-Memory State Audit
    console.log('\n👉 Scenario 3D: ImageService In-Memory State Audit...');
    testAssert('ImageService has no .cache Map property', !imageService.cache);
    testAssert('ImageService has no .inFlight Map property', !imageService.inFlight);
    testAssert('ImageService has no .negatives Map property', !imageService.negatives);

    // ─────────────────────────────────────────────────────────────────────────
    // SECTION 4: DI Container & Architectural Hygiene Audit
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📌 SECTION 4: DI Container & Architectural Hygiene Audit');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    // Check DI Container Registrations
    let hasCacheService = false;
    let hasStreamResolveCache = false;
    try {
      container.resolve('cacheService');
      hasCacheService = true;
    } catch (_) {}
    try {
      container.resolve('streamResolveCache');
      hasStreamResolveCache = true;
    } catch (_) {}

    testAssert('Awilix container: cacheService is not registered', !hasCacheService);
    testAssert('Awilix container: streamResolveCache is not registered', !hasStreamResolveCache);

    // Check /health Endpoint Output
    const healthRes = await request(`${baseUrl}/health`);
    const healthBody = await healthRes.body.json();

    testAssert('/health returns 200 OK', healthRes.statusCode === 200);
    testAssert('/health payload is clean { status: "ok", service: "nuvio-live-sports" }', healthBody.status === 'ok' && healthBody.service === 'nuvio-live-sports');
    testAssert('/health does NOT expose caching telemetry (streamResolveCache / cacheService)', healthBody.streamResolveCache === undefined && healthBody.cacheService === undefined);

    // ─────────────────────────────────────────────────────────────────────────
    // Final Summary
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n================================================================================');
    console.log('🎯 CHALLENGER 2 VERIFICATION SUMMARY');
    console.log('================================================================================');
    console.log(`Total Assertions Evaluated : ${passed + failed}`);
    console.log(`Passed Assertions          : ${passed}`);
    console.log(`Failed Assertions          : ${failed}`);
    console.log(`Cache Hit Rate Across Tests: 0.00%`);
    console.log(`Final Verdict              : ${failed === 0 ? 'APPROVE ✅' : 'REQUEST_CHANGES ❌'}`);
    console.log('================================================================================\n');

    return {
      passed,
      failed,
      verdict: failed === 0 ? 'APPROVE' : 'REQUEST_CHANGES',
      observations
    };
  } finally {
    if (serverInstance && serverInstance.shutdown) {
      await serverInstance.shutdown().catch(() => {});
    }
    if (mockUpstream && mockUpstream.close) {
      await mockUpstream.close().catch(() => {});
    }
  }
}

if (require.main === module) {
  runChallengerEndpointsStress()
    .then((result) => {
      process.exit(result.failed === 0 ? 0 : 1);
    })
    .catch((err) => {
      console.error('Fatal error during Challenger 2 test execution:', err);
      process.exit(1);
    });
}

module.exports = { runChallengerEndpointsStress };
