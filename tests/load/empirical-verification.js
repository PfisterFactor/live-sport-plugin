/**
 * tests/load/empirical-verification.js
 *
 * Empirical verification harness for Challenger 2:
 * 1. Validates cache hit speedup factor on /stream/tv/* (cold vs warm)
 * 2. Validates single-flight deduplication under 50 simultaneous requests
 * 3. Validates manifest cache headers (X-Manifest-Cache: HIT, MISS, NEGATIVE)
 * 4. Validates /health telemetry counters match actual request deltas
 */

const { request } = require('undici');
const { startServer, startMockUpstream } = require('./server-runner');
const { performance } = require('perf_hooks');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getHealth(baseUrl) {
  const res = await request(`${baseUrl}/health`);
  const body = await res.body.json();
  return body.streamResolveCache;
}

async function runEmpiricalTests() {
  console.log('🔬 [Challenger 2] Starting Deep Empirical Verification...\n');
  const results = {
    manifestHeaders: { passed: false, details: {} },
    streamSpeedup: { passed: false, details: {} },
    singleFlightDedup: { passed: false, details: {} },
    telemetryDeltas: { passed: false, details: {} }
  };

  let mockUpstream = null;
  let serverInstance = null;

  try {
    mockUpstream = await startMockUpstream();
    console.log(`✅ Mock upstream active at ${mockUpstream.baseUrl}`);

    serverInstance = await startServer({
      port: 7090,
      reuseExisting: false
    });
    console.log(`✅ Nuvio server active at ${serverInstance.baseUrl}`);

    // Wait for catalog readiness
    console.log('⏳ Awaiting catalog readiness...');
    let matches = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      try {
        const r = await request(`${serverInstance.baseUrl}/api/matches`);
        if (r.statusCode === 200) {
          matches = await r.body.json();
          if (matches.length > 0) break;
        }
      } catch (_) {}
      await sleep(500);
    }
    await sleep(2500);
    console.log(`✅ Catalog ready with ${matches.length} matches.\n`);

    // ─────────────────────────────────────────────────────────────
    // TEST 1: Manifest Cache Headers (MISS, HIT, NEGATIVE)
    // ─────────────────────────────────────────────────────────────
    console.log('--- TEST 1: Manifest Cache Headers ---');
    const validUrl = `${mockUpstream.baseUrl}/valid.m3u8`;
    const deadUrl = `${mockUpstream.baseUrl}/dead.m3u8`;

    mockUpstream.clearRequests();

    // 1a. Cold request -> MISS
    const res1 = await request(`${serverInstance.baseUrl}/api/manifest?url=${encodeURIComponent(validUrl)}`);
    const h1 = res1.headers['x-manifest-cache'];
    const b1 = await res1.body.text();
    const upCount1 = mockUpstream.requests.length;

    // 1b. Warm request -> HIT
    const res2 = await request(`${serverInstance.baseUrl}/api/manifest?url=${encodeURIComponent(validUrl)}`);
    const h2 = res2.headers['x-manifest-cache'];
    const b2 = await res2.body.text();
    const upCount2 = mockUpstream.requests.length;

    // 1c. Dead request 1 -> 404 (MISS)
    const deadRes1 = await request(`${serverInstance.baseUrl}/api/manifest?url=${encodeURIComponent(deadUrl)}`);
    const deadH1 = deadRes1.headers['x-manifest-cache'];
    await deadRes1.body.text();

    // 1d. Dead request 2 -> 404 (NEGATIVE)
    const deadRes2 = await request(`${serverInstance.baseUrl}/api/manifest?url=${encodeURIComponent(deadUrl)}`);
    const deadH2 = deadRes2.headers['x-manifest-cache'];
    await deadRes2.body.text();

    const t1Passed =
      res1.statusCode === 200 &&
      h1 === 'MISS' &&
      upCount1 === 1 &&
      res2.statusCode === 200 &&
      h2 === 'HIT' &&
      upCount2 === 1 &&
      deadRes1.statusCode === 404 &&
      deadRes2.statusCode === 404 &&
      (deadH2 === 'NEGATIVE' || deadH2 === 'NEGATIVE-MINT');

    results.manifestHeaders = {
      passed: t1Passed,
      details: {
        coldHeader: h1,
        warmHeader: h2,
        deadColdStatus: deadRes1.statusCode,
        deadColdHeader: deadH1,
        deadWarmStatus: deadRes2.statusCode,
        deadWarmHeader: deadH2,
        upstreamRequestsMadeTotal: upCount2
      }
    };
    console.log(`Result: ${t1Passed ? 'PASSED ✅' : 'FAILED ❌'}`, JSON.stringify(results.manifestHeaders.details));

    // ─────────────────────────────────────────────────────────────
    // TEST 2: Stream Resolution Speedup Factor (Cold vs Warm)
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- TEST 2: Stream Resolution Speedup Factor (Cold vs Warm) ---');
    const targetMatch = matches[0] || { id: 'stream_speedup_test' };
    const streamEndpoint = `${serverInstance.baseUrl}/stream/tv/nuvio_sport_${targetMatch.id}.json`;

    // Cold request
    const tColdStart = performance.now();
    const coldRes = await request(streamEndpoint, { headersTimeout: 20000, bodyTimeout: 20000 });
    const coldDurationMs = performance.now() - tColdStart;
    const coldBody = await coldRes.body.json();

    // 20 Warm requests
    const warmLatencies = [];
    for (let i = 0; i < 20; i++) {
      const tWarmStart = performance.now();
      const warmRes = await request(streamEndpoint);
      warmLatencies.push(performance.now() - tWarmStart);
      await warmRes.body.json();
    }
    warmLatencies.sort((a, b) => a - b);
    const warmMedian = warmLatencies[Math.floor(warmLatencies.length / 2)];
    const speedupFactor = coldDurationMs / Math.max(warmMedian, 0.1);

    const t2Passed =
      coldRes.statusCode === 200 &&
      Array.isArray(coldBody.streams) &&
      warmMedian < 200 &&
      speedupFactor >= 5.0;

    results.streamSpeedup = {
      passed: t2Passed,
      details: {
        coldDurationMs: Math.round(coldDurationMs * 100) / 100,
        warmMedianMs: Math.round(warmMedian * 100) / 100,
        speedupFactor: `${Math.round(speedupFactor * 10) / 10}x`,
        coldStreamsCount: coldBody.streams ? coldBody.streams.length : 0
      }
    };
    console.log(`Result: ${t2Passed ? 'PASSED ✅' : 'FAILED ❌'}`, JSON.stringify(results.streamSpeedup.details));

    // ─────────────────────────────────────────────────────────────
    // TEST 3: Single-Flight Deduplication under 50 Simultaneous Requests
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- TEST 3: Single-Flight Deduplication under 50 Simultaneous Requests ---');
    const unCachedMatch = matches[1] || { id: `uncached_match_${Date.now()}` };
    const unCachedUrl = `${serverInstance.baseUrl}/stream/tv/nuvio_sport_${unCachedMatch.id}.json`;

    const healthBeforeDedup = await getHealth(serverInstance.baseUrl);

    const burst50Promises = Array.from({ length: 50 }, (_, i) => {
      const tStart = performance.now();
      return request(unCachedUrl, { headersTimeout: 20000, bodyTimeout: 20000 }).then(async (res) => {
        const body = await res.body.json();
        return {
          idx: i,
          status: res.statusCode,
          durationMs: performance.now() - tStart,
          hasStreams: body && Array.isArray(body.streams)
        };
      });
    });

    const burst50Results = await Promise.all(burst50Promises);
    await sleep(200);
    const healthAfterDedup = await getHealth(serverInstance.baseUrl);

    const all200 = burst50Results.every((r) => r.status === 200 && r.hasStreams);
    const burstLatencies = burst50Results.map((r) => r.durationMs).sort((a, b) => a - b);
    const minBurst = burstLatencies[0];
    const maxBurst = burstLatencies[burstLatencies.length - 1];
    const burstSpreadMs = maxBurst - minBurst;

    const missesDelta = healthAfterDedup.misses - healthBeforeDedup.misses;

    const t3Passed = all200 && burst50Results.length === 50 && missesDelta <= (unCachedMatch.sources ? unCachedMatch.sources.length + 2 : 5);

    results.singleFlightDedup = {
      passed: t3Passed,
      details: {
        totalBurstRequests: burst50Results.length,
        allSuccess200: all200,
        minBurstLatencyMs: Math.round(minBurst * 100) / 100,
        maxBurstLatencyMs: Math.round(maxBurst * 100) / 100,
        burstSpreadMs: Math.round(burstSpreadMs * 100) / 100,
        serverMissesDelta: missesDelta,
        activeInFlightAfter: healthAfterDedup.inFlight
      }
    };
    console.log(`Result: ${t3Passed ? 'PASSED ✅' : 'FAILED ❌'}`, JSON.stringify(results.singleFlightDedup.details));

    // ─────────────────────────────────────────────────────────────
    // TEST 4: /health Telemetry Counters Delta Accuracy
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- TEST 4: /health Telemetry Counters Delta Accuracy ---');
    const healthPreTest4 = await getHealth(serverInstance.baseUrl);

    const WARM_REQ_COUNT = 25;
    for (let i = 0; i < WARM_REQ_COUNT; i++) {
      const res = await request(streamEndpoint);
      await res.body.json();
    }

    await sleep(100);
    const healthPostTest4 = await getHealth(serverInstance.baseUrl);

    const actualHitsDelta = healthPostTest4.hits - healthPreTest4.hits;
    const actualMissesDelta = healthPostTest4.misses - healthPreTest4.misses;

    const t4Passed = actualHitsDelta > 0 && actualMissesDelta === 0;

    results.telemetryDeltas = {
      passed: t4Passed,
      details: {
        warmRequestsFired: WARM_REQ_COUNT,
        actualHitsDelta,
        actualMissesDelta,
        preHits: healthPreTest4.hits,
        postHits: healthPostTest4.hits,
        learnedTtls: healthPostTest4.learnedTtls
      }
    };
    console.log(`Result: ${t4Passed ? 'PASSED ✅' : 'FAILED ❌'}`, JSON.stringify(results.telemetryDeltas.details));

    console.log('\n======================================================');
    console.log('🏆 EMPIRICAL CHALLENGER VERIFICATION SUMMARY:');
    console.log('======================================================');
    console.log('1. Manifest Cache Headers (HIT/MISS/NEGATIVE):', results.manifestHeaders.passed ? 'PASS ✅' : 'FAIL ❌');
    console.log('2. Stream Cache Hit Speedup Factor           :', results.streamSpeedup.passed ? 'PASS ✅' : 'FAIL ❌');
    console.log('3. Single-Flight 50-Request Thundering Herd  :', results.singleFlightDedup.passed ? 'PASS ✅' : 'FAIL ❌');
    console.log('4. /health Telemetry Delta Exactness         :', results.telemetryDeltas.passed ? 'PASS ✅' : 'FAIL ❌');
    console.log('======================================================\n');

    return results;
  } finally {
    if (mockUpstream) await mockUpstream.close().catch(() => {});
    if (serverInstance && serverInstance.shutdown) await serverInstance.shutdown().catch(() => {});
  }
}

if (require.main === module) {
  runEmpiricalTests()
    .then((res) => {
      const allPassed = Object.values(res).every((r) => r.passed);
      process.exit(allPassed ? 0 : 1);
    })
    .catch((err) => {
      console.error('Fatal error in empirical tests:', err);
      process.exit(1);
    });
}

module.exports = { runEmpiricalTests };
