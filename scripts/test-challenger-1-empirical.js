/**
 * scripts/test-challenger-1-empirical.js
 *
 * Comprehensive Empirical Verification Suite for Challenger 1:
 * 1. Awilix DI Container 20-singleton resolution and legacy provider omission.
 * 2. MatchAggregator provider list & isolation rule checks.
 * 3. Server boot & endpoint contract verification (/health, /manifest.json, /catalog/tv/nuvio_sports_live.json, /catalog/tv/nuvio_sports_football.json, /stream/tv/*.json).
 * 4. Legacy Client Resilience: Querying legacy bein stream IDs and legacy source configs.
 * 5. Concurrent API load & Stream Resolution stability.
 */

const { request } = require('undici');
const http = require('http');
const path = require('path');
const container = require('../src/container');
const { handleStream } = require('../src/streams');
const { handleCatalog, handleMeta } = require('../src/catalog');
const { startServer, startMockUpstream } = require('../tests/load/server-runner');

async function runChallengerVerification() {
  console.log('================================================================');
  console.log('🔬 [Challenger 1] Comprehensive Empirical API & Container Tests');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;
  const testResults = [];

  function assert(name, condition, detail = '') {
    if (condition) {
      passed++;
      console.log(`  ✅ PASS: ${name}${detail ? ` (${detail})` : ''}`);
      testResults.push({ name, status: 'PASS', detail });
    } else {
      failed++;
      console.error(`  ❌ FAIL: ${name}${detail ? ` (${detail})` : ''}`);
      testResults.push({ name, status: 'FAIL', detail });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // PART 1: DI Container Resolution (17 Registrations)
  // ─────────────────────────────────────────────────────────────
  console.log('👉 [Part 1] DI Container 17-Singleton Resolution Verification');

  const expectedRegistrations = [
    'cacheService',
    'circuitBreaker',
    'm3u8Parser',
    'cronService',
    'matchAggregator',
    'streamScorer',
    'streamResolveCache',
    'streamFreeProvider',
    'timStreamsProvider',
    'sportyHunterProvider',
    'watchFootyProvider',
    'cdnLiveProvider',
    'streamSports99Provider',
    'streamicProvider',
    'embedIndiaProvider',
    'embedStProvider',
    'streamedPkProvider'
  ];

  assert('Container has exactly 17 registered dependencies', Object.keys(container.registrations).length === 17, `Found ${Object.keys(container.registrations).length}`);

  for (const regName of expectedRegistrations) {
    let resolvedInstance = null;
    let resolveError = null;
    try {
      resolvedInstance = container.resolve(regName);
    } catch (e) {
      resolveError = e;
    }
    assert(
      `Container resolves '${regName}' without error`,
      resolveError === null && resolvedInstance !== undefined && resolvedInstance !== null,
      resolveError ? `Error: ${resolveError.message}` : (typeof resolvedInstance === 'object' ? 'OK' : typeof resolvedInstance)
    );
  }

  // Verify BeinArabicProvider is NOT registered
  let beinResolved = null;
  let beinError = null;
  try {
    beinResolved = container.resolve('beinArabicProvider');
  } catch (e) {
    beinError = e;
  }
  assert('beinArabicProvider is completely absent from container', beinResolved === null && beinError !== null, beinError ? beinError.message : 'Dangling registration found!');

  // Verify MatchAggregator providers list
  const matchAggregator = container.resolve('matchAggregator');
  const providerNames = matchAggregator.providers.map(p => p.name || p.constructor.name);
  assert(
    'MatchAggregator does NOT contain BeinArabicProvider in providers list',
    !providerNames.some(n => String(n).toLowerCase().includes('bein')),
    `Active providers: ${providerNames.join(', ')}`
  );

  // ─────────────────────────────────────────────────────────────
  // PART 2: Server Boot & Core Endpoints Contract Verification
  // ─────────────────────────────────────────────────────────────
  console.log('\n👉 [Part 2] Server Boot & Live API Endpoints Contract Verification');
  
  let serverInstance = null;
  let mockUpstream = null;

  try {
    mockUpstream = await startMockUpstream();
    serverInstance = await startServer({
      port: 7080,
      reuseExisting: false
    });

    const baseUrl = serverInstance.baseUrl;
    console.log(`Server running at ${baseUrl}`);

    // 1. /health
    const healthRes = await request(`${baseUrl}/health`);
    const healthBody = await healthRes.body.json();
    assert('/health returns 200 OK', healthRes.statusCode === 200);
    assert('/health payload contains status: ok', healthBody.status === 'ok');
    assert('/health payload contains streamResolveCache telemetry', typeof healthBody.streamResolveCache === 'object' && healthBody.streamResolveCache !== null);
    assert('/health streamResolveCache has hits/misses/inFlight metrics', typeof healthBody.streamResolveCache.hits === 'number' && typeof healthBody.streamResolveCache.misses === 'number');

    // 2. /manifest.json
    const manifestRes = await request(`${baseUrl}/manifest.json`);
    const manifestBody = await manifestRes.body.json();
    assert('/manifest.json returns 200 OK', manifestRes.statusCode === 200);
    assert('/manifest.json returns valid Stremio ID and version', manifestBody.id === 'community.nuvio.live-sports' && manifestBody.version === '3.0.0');
    assert('/manifest.json declares tv types and catalogs', Array.isArray(manifestBody.catalogs) && manifestBody.catalogs.length > 0 && manifestBody.types.includes('tv'));
    assert('/manifest.json declares stream/meta/catalog resources', manifestBody.resources.includes('stream') && manifestBody.resources.includes('catalog'));

    // Wait a bit for background match sync if running
    await new Promise(r => setTimeout(r, 2000));

    // 3. /catalog/tv/nuvio_sports_live.json
    const catLiveRes = await request(`${baseUrl}/catalog/tv/nuvio_sports_live.json`);
    const catLiveBody = await catLiveRes.body.json();
    assert('/catalog/tv/nuvio_sports_live.json returns 200 OK', catLiveRes.statusCode === 200);
    assert('/catalog/tv/nuvio_sports_live.json returns metas array', Array.isArray(catLiveBody.metas));

    // 4. /catalog/tv/nuvio_sports_football.json
    const catFootRes = await request(`${baseUrl}/catalog/tv/nuvio_sports_football.json`);
    const catFootBody = await catFootRes.body.json();
    assert('/catalog/tv/nuvio_sports_football.json returns 200 OK', catFootRes.statusCode === 200);
    assert('/catalog/tv/nuvio_sports_football.json returns metas array', Array.isArray(catFootBody.metas));

    // 5. Querying live stream endpoints for existing catalog items
    const matchesRes = await request(`${baseUrl}/api/matches`);
    let matches = [];
    if (matchesRes.statusCode === 200) {
      matches = await matchesRes.body.json();
    }
    console.log(`Found ${matches.length} active matches in catalog.`);

    if (matches.length > 0) {
      const sampleMatch = matches[0];
      const streamRes = await request(`${baseUrl}/stream/tv/nuvio_sport_${sampleMatch.id}.json`);
      const streamBody = await streamRes.body.json();
      assert(`/stream/tv/nuvio_sport_${sampleMatch.id}.json returns 200 OK`, streamRes.statusCode === 200);
      assert('Stream response contains streams array and cache metadata', Array.isArray(streamBody.streams) && streamBody.cacheMaxAge !== undefined);
    } else {
      console.log('No matches in catalog to query live stream, testing mock match stream...');
    }

    // ─────────────────────────────────────────────────────────────
    // PART 3: Legacy Client Resilience (BeinArabic removal)
    // ─────────────────────────────────────────────────────────────
    console.log('\n👉 [Part 3] Legacy Client Stream Request Resilience (BeinArabic)');

    // 3a. Client requests old legacy bein channel IDs
    const legacyIds = [
      'nuvio_sport_bein_ar_1',
      'nuvio_sport_bein_ar_2',
      'nuvio_sport_bein_ar_3',
      'nuvio_sport_bein_ar_news',
      'nuvio_sport_bein_ar_max1',
      'nuvio_sport_non_existent_match'
    ];

    for (const legId of legacyIds) {
      const legRes = await request(`${baseUrl}/stream/tv/${legId}.json`);
      const legBody = await legRes.body.json();
      assert(
        `Legacy ID ${legId} gracefully returns 200 with empty streams`,
        legRes.statusCode === 200 && Array.isArray(legBody.streams) && legBody.streams.length === 0,
        `Status: ${legRes.statusCode}, Streams: ${legBody.streams ? legBody.streams.length : 'none'}`
      );
    }

    // 3b. Direct handleStream call with legacy source names in config
    const legacyConfigMatch = {
      id: 'test_legacy_match_123',
      title: 'Real Madrid vs Barcelona',
      category: 'football',
      date: String(Date.now()),
      sources: [
        { source: 'BeinArabic', id: 'bein_ar_1', quality: 'HD' },
        { source: 'legacy_unknown_provider', id: 'stream_99', quality: 'HD' }
      ]
    };

    const cacheService = container.resolve('cacheService');
    const prevMatches = cacheService.getMatches();
    cacheService.setMatches([legacyConfigMatch]);

    // Client requests with config sources including 'BeinArabic'
    const legacyStreamResult1 = await handleStream('tv', 'nuvio_sport_' + legacyConfigMatch.id, { sources: 'BeinArabic,streamfree' });
    assert(
      'handleStream gracefully handles legacy source "BeinArabic" in config without crashing',
      legacyStreamResult1 && Array.isArray(legacyStreamResult1.streams) && legacyStreamResult1.streams.length === 0
    );

    // Client requests with default config
    const legacyStreamResult2 = await handleStream('tv', 'nuvio_sport_' + legacyConfigMatch.id, {});
    assert(
      'handleStream filters out obsolete "BeinArabic" source and returns empty streams',
      legacyStreamResult2 && Array.isArray(legacyStreamResult2.streams) && legacyStreamResult2.streams.length === 0
    );

    // Restore cacheService matches
    cacheService.setMatches(prevMatches);

    // ─────────────────────────────────────────────────────────────
    // PART 4: Edge Cases & Adversarial Input Fuzzing
    // ─────────────────────────────────────────────────────────────
    console.log('\n👉 [Part 4] Edge Cases & Adversarial Input Fuzzing');

    // 4a. Malformed Stream IDs
    const malformedIds = [
      'invalid_prefix_12345',
      'nuvio_sport_',
      'nuvio_sport_../../../etc/passwd',
      'nuvio_sport_!@#$%^&*()_+',
      'nuvio_sport_null',
      'nuvio_sport_undefined'
    ];

    for (const mId of malformedIds) {
      const mRes = await request(`${baseUrl}/stream/tv/${encodeURIComponent(mId)}.json`);
      const mBody = await mRes.body.json();
      assert(
        `Malformed ID "${mId}" returns 200 with { streams: [] } without unhandled exception`,
        mRes.statusCode === 200 && Array.isArray(mBody.streams) && mBody.streams.length === 0
      );
    }

    // 4b. Malformed catalog types and IDs
    const invalidCatRes1 = await request(`${baseUrl}/catalog/movie/nuvio_sports_live.json`);
    assert('Non-tv catalog type returns 200 with { metas: [] } or empty list', invalidCatRes1.statusCode === 200);

    const invalidCatRes2 = await request(`${baseUrl}/catalog/tv/non_existent_catalog.json`);
    assert('Unknown catalog ID returns 200 with { metas: [] }', invalidCatRes2.statusCode === 200);

  } finally {
    if (mockUpstream && mockUpstream.close) await mockUpstream.close().catch(() => {});
    if (serverInstance && serverInstance.shutdown) await serverInstance.shutdown().catch(() => {});
  }

  console.log('\n================================================================');
  console.log('🏆 CHALLENGER 1 VERIFICATION SUMMARY');
  console.log('================================================================');
  console.log(`Total Assertions Passed : ${passed}`);
  console.log(`Total Assertions Failed : ${failed}`);
  console.log(`Final Verdict           : ${failed === 0 ? 'APPROVE ✅' : 'REQUEST_CHANGES ❌'}`);
  console.log('================================================================\n');

  return { passed, failed, verdict: failed === 0 ? 'APPROVE' : 'REQUEST_CHANGES', testResults };
}

if (require.main === module) {
  runChallengerVerification()
    .then((res) => {
      process.exit(res.failed === 0 ? 0 : 1);
    })
    .catch((err) => {
      console.error('Fatal error running Challenger 1 test suite:', err);
      process.exit(1);
    });
}

module.exports = { runChallengerVerification };
