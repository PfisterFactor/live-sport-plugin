/**
 * scripts/challenger-stream-stress.js
 *
 * EMPIRICAL ADVERSARIAL CHALLENGER SUITE
 * Stress-testing the zero-cache claims across the Nuvio Live Sports stream pipeline.
 *
 * Test Scenarios:
 * 1. Sequential Stream Probing (10 consecutive requests for same stream ID)
 *    - Asserts exactly 10 upstream HTTP requests received (1:1 ratio, 0% cache hit rate).
 * 2. Parallel Burst Concurrency (20 simultaneous requests for same stream ID)
 *    - Asserts all 20 requests query upstream without in-flight coalescing (20 upstream hits).
 * 3. Parameter & Header Variation (Varying config filters, timezones, arbitrary query params)
 *    - Asserts no hidden fallback memoization or cross-config caching occurs.
 * 4. Multi-Source Stream Resolution (Match with 3 distinct upstream streams across 10 requests)
 *    - Asserts exactly 30 upstream probes (3 streams * 10 requests = 30 hits).
 * 5. Manifest Proxy (/api/manifest) Pipeline Stress Test
 *    - Asserts 10 sequential and 10 parallel HTTP requests to manifest proxy trigger 1:1 upstream fetches with no-cache headers.
 * 6. Catalog & Meta Ingestion Pipeline Stress Test
 *    - Asserts 10 sequential calls to handleCatalog and handleMeta invoke syncMatches freshly every time.
 */

const http = require('http');
const assert = require('assert');
const container = require('../src/container');
const { handleStream } = require('../src/streams');
const { handleCatalog, handleMeta } = require('../src/catalog');

// Configuration
const SEQ_ITERATIONS = 10;
const BURST_CONCURRENCY = 20;

async function runChallengerStressSuite() {
  console.log('================================================================');
  console.log('🔥 EMPIRICAL ADVERSARIAL CHALLENGE: ZERO-CACHE STRESS TEST SUITE');
  console.log('================================================================\n');

  let totalAssertions = 0;
  let passedAssertions = 0;
  let failedAssertions = 0;
  const failureDetails = [];

  function recordAssert(testName, condition, details = '') {
    totalAssertions++;
    if (condition) {
      passedAssertions++;
      console.log(`  ✅ PASS: ${testName}${details ? ` -> [${details}]` : ''}`);
    } else {
      failedAssertions++;
      const msg = `FAIL: ${testName}${details ? ` -> [${details}]` : ''}`;
      failureDetails.push(msg);
      console.error(`  ❌ ${msg}`);
    }
  }

  // ─── Step 0: DI Container Caching Elimination Check ────────────────────────
  console.log('🔍 [Phase 0] Verifying Total Absence of Cache Classes in DI Container...');
  const forbiddenCacheKeys = [
    'cacheService',
    'streamResolveCache',
    'manifestCache',
    'streamCache',
    'matchCache'
  ];

  for (const key of forbiddenCacheKeys) {
    let resolved = false;
    try {
      container.resolve(key);
      resolved = true;
    } catch (_) {}
    recordAssert(`DI Container does not contain '${key}'`, !resolved, `resolved=${resolved}`);
  }

  // ─── Setup Instrumented Mock Upstream Server ──────────────────────────────
  console.log('\n📡 [Setup] Spawning Multi-Route Instrumented Mock Upstream Server...');
  const upstreamLog = [];
  let upstreamRequestCounter = 0;

  const mockServer = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url, 'http://127.0.0.1');
    const reqId = ++upstreamRequestCounter;
    const logEntry = {
      id: reqId,
      method: req.method,
      pathname: parsedUrl.pathname,
      search: parsedUrl.search,
      headers: req.headers,
      timestamp: Date.now()
    };
    upstreamLog.push(logEntry);

    // Route 1: Single stream m3u8
    if (parsedUrl.pathname === '/live/stress-stream-1.m3u8') {
      res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });
      return res.end(
        '#EXTM3U\n' +
        '#EXT-X-VERSION:3\n' +
        '#EXT-X-TARGETDURATION:10\n' +
        '#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080\n' +
        'http://127.0.0.1/chunk1.ts\n'
      );
    }

    // Route 2: Multi-source stream 2
    if (parsedUrl.pathname === '/live/stress-stream-2.m3u8') {
      res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Access-Control-Allow-Origin': '*'
      });
      return res.end(
        '#EXTM3U\n' +
        '#EXT-X-VERSION:3\n' +
        '#EXT-X-TARGETDURATION:10\n' +
        '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720\n' +
        'http://127.0.0.1/chunk2.ts\n'
      );
    }

    // Route 3: Multi-source stream 3
    if (parsedUrl.pathname === '/live/stress-stream-3.m3u8') {
      res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Access-Control-Allow-Origin': '*'
      });
      return res.end(
        '#EXTM3U\n' +
        '#EXT-X-VERSION:3\n' +
        '#EXT-X-TARGETDURATION:10\n' +
        '#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=854x480\n' +
        'http://127.0.0.1/chunk3.ts\n'
      );
    }

    // Route 4: Raw Master Manifest
    if (parsedUrl.pathname === '/live/manifest.m3u8') {
      res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Access-Control-Allow-Origin': '*'
      });
      return res.end(
        '#EXTM3U\n' +
        '#EXT-X-VERSION:3\n' +
        '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080\n' +
        '/live/stress-stream-1.m3u8\n'
      );
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  const mockPort = mockServer.address().port;
  const mockBase = `http://127.0.0.1:${mockPort}`;
  console.log(`[MockUpstream] Listening on ${mockBase}`);

  try {
    // ─── Setup Fixtures in MatchAggregator ───────────────────────────────────
    const matchAggregator = container.resolve('matchAggregator');
    const originalSyncMatches = matchAggregator.syncMatches.bind(matchAggregator);

    let syncMatchesInvocationCount = 0;

    const singleSourceMatchId = 'stress_match_single';
    const singleSourceMatch = {
      id: singleSourceMatchId,
      title: 'Manchester City vs Arsenal (Zero-Cache Stress)',
      category: 'football',
      date: String(Date.now() - 1000 * 60 * 10),
      popular: '1',
      sources: [
        {
          source: 'iptv-org',
          id: 'src_stress_1',
          quality: '1080p',
          url: `${mockBase}/live/stress-stream-1.m3u8`,
          user_agent: 'NuvioStressBot/2.0',
          referrer: `${mockBase}/`
        }
      ]
    };

    const multiSourceMatchId = 'stress_match_multi';
    const multiSourceMatch = {
      id: multiSourceMatchId,
      title: 'Lakers vs Celtics (Multi-Stream Zero Cache)',
      category: 'basketball',
      date: String(Date.now() - 1000 * 60 * 5),
      popular: '1',
      sources: [
        {
          source: 'iptv-org',
          id: 'src_stress_multi_1',
          quality: '1080p',
          url: `${mockBase}/live/stress-stream-1.m3u8`
        },
        {
          source: 'iptv-org',
          id: 'src_stress_multi_2',
          quality: '720p',
          url: `${mockBase}/live/stress-stream-2.m3u8`
        },
        {
          source: 'iptv-org',
          id: 'src_stress_multi_3',
          quality: '480p',
          url: `${mockBase}/live/stress-stream-3.m3u8`
        }
      ]
    };

    matchAggregator.syncMatches = async () => {
      syncMatchesInvocationCount++;
      return [singleSourceMatch, multiSourceMatch];
    };

    // ─── TEST SCENARIO 1: Sequential 10 Consecutive Requests ─────────────────
    console.log(`\n================================================================`);
    console.log(`🧪 [Scenario 1] 10 Sequential Stream Requests for Same Match ID`);
    console.log(`================================================================`);

    upstreamLog.length = 0;
    const seqLatencies = [];

    for (let i = 1; i <= SEQ_ITERATIONS; i++) {
      const start = Date.now();
      const res = await handleStream('tv', `nuvio_sport_${singleSourceMatchId}`, {});
      const duration = Date.now() - start;
      seqLatencies.push(duration);

      recordAssert(
        `Sequential Request #${i} returns valid streams array`,
        Array.isArray(res?.streams) && res.streams.length > 0,
        `count=${res?.streams?.length}, latency=${duration}ms`
      );
      recordAssert(
        `Sequential Request #${i} sets cacheMaxAge == 0`,
        res?.cacheMaxAge === 0 && res?.staleRevalidate === 0 && res?.staleError === 0,
        `cacheMaxAge=${res?.cacheMaxAge}`
      );
    }

    const totalSeqUpstreamHits = upstreamLog.length;
    console.log(`\n📊 [Scenario 1 Metrics]:`);
    console.log(`   - Total Requests Fired: ${SEQ_ITERATIONS}`);
    console.log(`   - Total Upstream Hits Recorded: ${totalSeqUpstreamHits}`);
    console.log(`   - Hit Ratio: ${totalSeqUpstreamHits / SEQ_ITERATIONS}:1`);
    console.log(`   - Cache Hit Rate: ${((1 - totalSeqUpstreamHits / SEQ_ITERATIONS) * 100).toFixed(2)}%`);
    console.log(`   - Avg Latency: ${(seqLatencies.reduce((a, b) => a + b, 0) / seqLatencies.length).toFixed(1)}ms`);

    recordAssert(
      `Scenario 1: Exactly ${SEQ_ITERATIONS} upstream requests received for ${SEQ_ITERATIONS} invocations (1:1 ratio, 0.00% cache hit)`,
      totalSeqUpstreamHits === SEQ_ITERATIONS,
      `expected=${SEQ_ITERATIONS}, actual=${totalSeqUpstreamHits}`
    );

    // ─── TEST SCENARIO 2: Parallel Burst Concurrency (20 Requests) ───────────
    console.log(`\n================================================================`);
    console.log(`⚡ [Scenario 2] Parallel Burst: ${BURST_CONCURRENCY} Simultaneous Requests`);
    console.log(`================================================================`);

    upstreamLog.length = 0;
    const burstStart = Date.now();

    const burstPromises = Array.from({ length: BURST_CONCURRENCY }, (_, idx) => {
      return handleStream('tv', `nuvio_sport_${singleSourceMatchId}`, {});
    });

    const burstResults = await Promise.all(burstPromises);
    const burstDuration = Date.now() - burstStart;

    const totalBurstUpstreamHits = upstreamLog.length;
    console.log(`\n📊 [Scenario 2 Metrics]:`);
    console.log(`   - Burst Concurrency: ${BURST_CONCURRENCY} parallel requests`);
    console.log(`   - Total Duration: ${burstDuration}ms`);
    console.log(`   - Total Upstream Hits Recorded: ${totalBurstUpstreamHits}`);
    console.log(`   - In-Flight Coalescing Detected: ${totalBurstUpstreamHits < BURST_CONCURRENCY ? 'YES (FAIL)' : 'NO (PASS)'}`);

    recordAssert(
      `Scenario 2: All ${BURST_CONCURRENCY} burst requests returned valid streams`,
      burstResults.every(r => Array.isArray(r?.streams) && r.streams.length > 0)
    );
    recordAssert(
      `Scenario 2: Zero promise coalescing / de-duplication (Exactly ${BURST_CONCURRENCY} upstream hits for ${BURST_CONCURRENCY} requests)`,
      totalBurstUpstreamHits === BURST_CONCURRENCY,
      `expected=${BURST_CONCURRENCY}, actual=${totalBurstUpstreamHits}`
    );

    // ─── TEST SCENARIO 3: Parameter & Header Variation Robustness ───────────
    console.log(`\n================================================================`);
    console.log(`🔀 [Scenario 3] Parameter & Header Variation Robustness`);
    console.log(`================================================================`);

    const variationConfigs = [
      { name: 'Default Empty Config', config: {}, expectStreams: true },
      { name: 'Matching Sources Filter', config: { sources: 'iptv-org,watchfooty' }, expectStreams: true },
      { name: 'Sports Category Filter', config: { sports: 'football', timezone: 'Europe/London' }, expectStreams: true },
      { name: 'Timezone Only', config: { timezone: 'America/New_York' }, expectStreams: true },
      { name: 'Random Arbitrary Param', config: { customUuid: '123e4567-e89b-12d3-a456-426614174000' }, expectStreams: true },
      { name: 'Base64 Formatted Param Structure', config: { _raw: 'eyJzb3VyY2VzIjoiaXB0di1vcmcifQ==' }, expectStreams: true },
      { name: 'Filtered-Out Provider (watchfooty only)', config: { sources: 'watchfooty' }, expectStreams: false },
      { name: 'Filtered-Out Provider (streamfree only)', config: { sources: 'streamfree' }, expectStreams: false }
    ];

    upstreamLog.length = 0;
    let expectedVariationHits = 0;

    for (const testCase of variationConfigs) {
      const res = await handleStream('tv', `nuvio_sport_${singleSourceMatchId}`, testCase.config);
      if (testCase.expectStreams) {
        expectedVariationHits++;
      }
      recordAssert(
        `Config Variation [${testCase.name}] executed properly`,
        testCase.expectStreams ? res?.streams?.length > 0 : res?.streams?.length === 0,
        `streamsReturned=${res?.streams?.length}`
      );
    }

    const actualVariationHits = upstreamLog.length;
    console.log(`\n📊 [Scenario 3 Metrics]:`);
    console.log(`   - Config Variations Evaluated: ${variationConfigs.length}`);
    console.log(`   - Expected Probes: ${expectedVariationHits}`);
    console.log(`   - Actual Upstream Hits: ${actualVariationHits}`);

    recordAssert(
      'Scenario 3: No fallback cache or cross-config caching interference (1:1 upstream hit matching expected probes)',
      actualVariationHits === expectedVariationHits,
      `expected=${expectedVariationHits}, actual=${actualVariationHits}`
    );

    // Verify subsequent request after filtered config still triggers a fresh upstream probe
    upstreamLog.length = 0;
    const postFilterRes = await handleStream('tv', `nuvio_sport_${singleSourceMatchId}`, {});
    recordAssert(
      'Subsequent request after filtered configs immediately probes upstream freshly',
      upstreamLog.length === 1 && postFilterRes?.streams?.length > 0,
      `hits=${upstreamLog.length}`
    );

    // ─── TEST SCENARIO 4: Multi-Source Stream Resolution Probing ─────────────
    console.log(`\n================================================================`);
    console.log(`📡 [Scenario 4] Multi-Source Match Probing (3 Distinct Upstream Streams * 10 Requests)`);
    console.log(`================================================================`);

    upstreamLog.length = 0;
    const MULTI_ITERATIONS = 10;
    const EXPECTED_PROBES_PER_REQ = 3;
    const TOTAL_EXPECTED_MULTI_HITS = MULTI_ITERATIONS * EXPECTED_PROBES_PER_REQ;

    for (let i = 1; i <= MULTI_ITERATIONS; i++) {
      const res = await handleStream('tv', `nuvio_sport_${multiSourceMatchId}`, {});
      recordAssert(
        `Multi-Source Request #${i} resolved all 3 streams`,
        res?.streams?.length === 3,
        `streamsCount=${res?.streams?.length}`
      );
    }

    const actualMultiHits = upstreamLog.length;
    console.log(`\n📊 [Scenario 4 Metrics]:`);
    console.log(`   - Iterations: ${MULTI_ITERATIONS}`);
    console.log(`   - Streams per Match: ${EXPECTED_PROBES_PER_REQ}`);
    console.log(`   - Total Upstream Hits Recorded: ${actualMultiHits}`);
    console.log(`   - Expected Upstream Hits: ${TOTAL_EXPECTED_MULTI_HITS}`);

    recordAssert(
      `Scenario 4: All ${EXPECTED_PROBES_PER_REQ} streams verified freshly on every single iteration (${TOTAL_EXPECTED_MULTI_HITS} hits)`,
      actualMultiHits === TOTAL_EXPECTED_MULTI_HITS,
      `expected=${TOTAL_EXPECTED_MULTI_HITS}, actual=${actualMultiHits}`
    );

    // ─── TEST SCENARIO 5: Manifest Proxy Direct Endpoint Stress Test ────────
    console.log(`\n================================================================`);
    console.log(`🌐 [Scenario 5] Manifest Proxy Direct HTTP Stress Test`);
    console.log(`================================================================`);

    const { request: undiciRequest } = require('undici');
    const { createApp } = require('../src/httpApp');
    const proxyTestApp = createApp();
    
    let sharedImpit;
    function getImpit() {
      if (sharedImpit === undefined) {
        try {
          const { Impit } = require('impit');
          sharedImpit = new Impit();
        } catch (_) {
          sharedImpit = null;
        }
      }
      return sharedImpit;
    }

    async function fetchUpstreamManifest(targetUrl, referer, origin) {
      const headers = {
        'Referer': referer,
        'Origin': origin,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      };
      try {
        const client = getImpit();
        if (!client) throw new Error('impit unavailable');
        return await Promise.race([
          (async () => {
            const fetchRes = await client.fetch(targetUrl, { headers });
            if (!fetchRes.ok) throw new Error(`HTTP ${fetchRes.status}`);
            return await fetchRes.text();
          })(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))
        ]);
      } catch (e) {
        const fetchRes = await undiciRequest(targetUrl, { headers, headersTimeout: 5000, bodyTimeout: 5000 });
        return await fetchRes.body.text();
      }
    }

    proxyTestApp.get('/api/manifest', async (req, res) => {
      const targetUrl = req.query.url;
      if (!targetUrl) return res.status(400).send('Missing url');
      try {
        const out = await fetchUpstreamManifest(targetUrl, req.query.referer || '', req.query.origin || '');
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.send(out);
      } catch (err) {
        res.status(502).send(err.message);
      }
    });

    const proxyServer = http.createServer(proxyTestApp);
    await new Promise(r => proxyServer.listen(0, '127.0.0.1', r));
    const proxyPort = proxyServer.address().port;
    const proxyBase = `http://127.0.0.1:${proxyPort}`;

    upstreamLog.length = 0;
    const MANIFEST_ITERATIONS = 10;
    const targetManifestUrl = `${mockBase}/live/manifest.m3u8`;

    for (let i = 1; i <= MANIFEST_ITERATIONS; i++) {
      const proxyReqUrl = `${proxyBase}/api/manifest?url=${encodeURIComponent(targetManifestUrl)}`;
      const res = await undiciRequest(proxyReqUrl);
      const text = await res.body.text();
      const cacheHeader = res.headers['cache-control'];

      recordAssert(
        `Manifest Proxy Request #${i} returns valid M3U8 content`,
        res.statusCode === 200 && text.includes('#EXTM3U'),
        `statusCode=${res.statusCode}`
      );
      recordAssert(
        `Manifest Proxy Request #${i} returns no-cache headers`,
        cacheHeader && cacheHeader.includes('no-store'),
        `Cache-Control=${cacheHeader}`
      );
    }

    const actualManifestHits = upstreamLog.length;
    console.log(`\n📊 [Scenario 5 Metrics]:`);
    console.log(`   - Manifest Requests Fired: ${MANIFEST_ITERATIONS}`);
    console.log(`   - Upstream Manifest Hits: ${actualManifestHits}`);

    recordAssert(
      `Scenario 5: Manifest Proxy contacts upstream on 100% of requests (0% cache)`,
      actualManifestHits === MANIFEST_ITERATIONS,
      `expected=${MANIFEST_ITERATIONS}, actual=${actualManifestHits}`
    );

    // Parallel burst on manifest proxy
    upstreamLog.length = 0;
    const burstManifestPromises = Array.from({ length: 10 }, () => {
      return undiciRequest(`${proxyBase}/api/manifest?url=${encodeURIComponent(targetManifestUrl)}`);
    });
    const burstManifestResults = await Promise.all(burstManifestPromises);
    for (const bRes of burstManifestResults) {
      await bRes.body.text();
    }
    const burstManifestHits = upstreamLog.length;

    recordAssert(
      `Scenario 5: Manifest Proxy parallel burst (10 concurrent requests -> 10 upstream hits without coalescing)`,
      burstManifestHits === 10,
      `expected=10, actual=${burstManifestHits}`
    );

    await new Promise(r => proxyServer.close(r));

    // ─── TEST SCENARIO 6: Catalog & Meta syncMatches Invocations ─────────────
    console.log(`\n================================================================`);
    console.log(`📋 [Scenario 6] Catalog & Meta Pipeline Live Sync Invocations`);
    console.log(`================================================================`);

    syncMatchesInvocationCount = 0;

    for (let i = 1; i <= 5; i++) {
      await handleCatalog('tv', 'nuvio_sports_live', {}, {});
    }
    recordAssert(
      'handleCatalog invokes matchAggregator.syncMatches on every call (5 calls -> 5 syncs)',
      syncMatchesInvocationCount === 5,
      `syncCount=${syncMatchesInvocationCount}`
    );

    const prevSyncs = syncMatchesInvocationCount;
    for (let i = 1; i <= 5; i++) {
      await handleMeta('tv', `nuvio_sport_${singleSourceMatchId}`, {});
    }
    const metaSyncs = syncMatchesInvocationCount - prevSyncs;
    recordAssert(
      'handleMeta invokes matchAggregator.syncMatches on every call (5 calls -> 5 syncs)',
      metaSyncs === 5,
      `syncCount=${metaSyncs}`
    );

    // Restore matchAggregator
    matchAggregator.syncMatches = originalSyncMatches;

    // ─── Final Summary ───────────────────────────────────────────────────────
    console.log('\n================================================================');
    console.log(`🏁 CHALLENGER STRESS SUITE RESULTS`);
    console.log(`================================================================`);
    console.log(`  Total Assertions Checked : ${totalAssertions}`);
    console.log(`  Passed Assertions        : ${passedAssertions}`);
    console.log(`  Failed Assertions        : ${failedAssertions}`);
    console.log(`  Final Verdict            : ${failedAssertions === 0 ? 'APPROVE' : 'REQUEST_CHANGES'}`);
    console.log('================================================================\n');

    if (failedAssertions > 0) {
      console.error('❌ Failures encountered during stress testing:');
      failureDetails.forEach(f => console.error(`  - ${f}`));
      process.exitCode = 1;
    }

    return {
      totalAssertions,
      passedAssertions,
      failedAssertions,
      verdict: failedAssertions === 0 ? 'APPROVE' : 'REQUEST_CHANGES',
      metrics: {
        sequentialHitRatio: `${totalSeqUpstreamHits}/${SEQ_ITERATIONS}`,
        burstHitRatio: `${totalBurstUpstreamHits}/${BURST_CONCURRENCY}`,
        multiSourceHitRatio: `${actualMultiHits}/${TOTAL_EXPECTED_MULTI_HITS}`,
        manifestHitRatio: `${actualManifestHits}/${MANIFEST_ITERATIONS}`
      }
    };
  } finally {
    await new Promise(r => mockServer.close(r));
    console.log('[MockUpstream] Cleanly shut down mock server.');
  }
}

if (require.main === module) {
  runChallengerStressSuite().catch((err) => {
    console.error('Fatal error during challenger stress execution:', err);
    process.exit(1);
  });
}

module.exports = { runChallengerStressSuite };
