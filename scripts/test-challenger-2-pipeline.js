/**
 * Adversarial Challenger 2 Stress Test: Provider & Aggregation Pipeline Verification
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');

async function runTests() {
  console.log('===============================================================');
  console.log('🔥 STARTING CHALLENGER 2 EMPIRICAL PIPELINE STRESS HARNESS');
  console.log('===============================================================');

  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    try {
      fn();
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ❌ FAIL: ${name} -> ${err.message}`);
      failed++;
    }
  }

  async function testAsync(name, fn) {
    try {
      await fn();
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ❌ FAIL: ${name} -> ${err.message}`);
      failed++;
    }
  }

  // --- 1. DI CONTAINER & PROVIDER REGISTRATION INTEGRITY ---
  console.log('\n[1] DI Container & Provider Resolution:');
  const container = require('../src/container');

  const EXPECTED_PROVIDERS = [
    'streamFreeProvider',
    'timStreamsProvider',
    'iptvOrgProvider',
    'sportyHunterProvider',
    'watchFootyProvider',
    'cdnLiveProvider',
    'streamSports99Provider',
    'streamicProvider',
    'strims24Provider',
    'embedIndiaProvider',
    'embedStProvider',
    'streamedPkProvider'
  ];

  EXPECTED_PROVIDERS.forEach((providerKey) => {
    test(`Container resolves provider '${providerKey}' cleanly`, () => {
      const p = container.resolve(providerKey);
      assert.ok(p, `Provider ${providerKey} should be instantiated`);
      assert.strictEqual(typeof p.getMatches, 'function', `Provider ${providerKey} should implement getMatches()`);
      assert.strictEqual(typeof p.resolveStream, 'function', `Provider ${providerKey} should implement resolveStream()`);
    });
  });

  test(`Container resolves 'matchAggregator' with 8 direct providers`, () => {
    const aggregator = container.resolve('matchAggregator');
    assert.ok(aggregator, 'matchAggregator should be resolved');
    assert.ok(Array.isArray(aggregator.providers), 'aggregator.providers should be an array');
    assert.strictEqual(aggregator.providers.length, 8, `Aggregator should have 8 providers registered, got ${aggregator.providers.length}`);
  });

  test(`Assert 'beinArabicProvider' is NOT registered in DI container`, () => {
    let threw = false;
    try {
      container.resolve('beinArabicProvider');
    } catch (e) {
      threw = true;
    }
    assert.strictEqual(threw, true, 'Resolving beinArabicProvider should throw AwilixResolutionError');
  });

  test(`Assert BeinArabicProvider.js is absent from src/providers and dist/`, () => {
    const srcPath = path.join(__dirname, '../src/providers/BeinArabicProvider.js');
    const distPath = path.join(__dirname, '../dist/BeinArabicProvider.js');
    assert.strictEqual(fs.existsSync(srcPath), false, 'src/providers/BeinArabicProvider.js must not exist');
    assert.strictEqual(fs.existsSync(distPath), false, 'dist/BeinArabicProvider.js must not exist');
  });

  // --- 2. MATCH AGGREGATOR ADVERSARIAL STRESS TESTING ---
  console.log('\n[2] MatchAggregator _precompute & _sameEventPre Stress Testing:');
  const aggregator = container.resolve('matchAggregator');

  test('_precompute handles undefined, null, empty strings, emojis and compound tokens correctly', () => {
    const s1 = aggregator._precompute({ title: '', id: '1' });
    assert.strictEqual(s1.norm, '');

    const s2 = aggregator._precompute({ title: '   ' });
    assert.strictEqual(s2.norm, '');

    const s3 = aggregator._precompute({ title: 'Arsenal 2 - 1 Chelsea @ 2026', id: '3' });
    assert.strictEqual(s3.digits, '1,2,2026');

    const s4 = aggregator._precompute({ title: '🔥 Real Madrid vs Barcelona ⚽ [LIVE HD]', id: '4' });
    assert.strictEqual(s4.norm.includes('realmadrid'), true, 'Real Madrid should compound to realmadrid');
    assert.strictEqual(s4.norm.includes('barcelona'), true, 'Barcelona should be retained in norm');
  });

  test('_sameEventPre deduplication logic boundary testing', () => {
    const now = Date.now();

    // Identical normalized titles within same category and time window
    const m1 = { id: 'sf_1', title: 'Manchester United vs Liverpool', category: 'football', date: now };
    const m2 = { id: 'wf_2', title: 'Manchester United vs. Liverpool FC', category: 'football', date: now + 3600000 };
    const p1 = aggregator._precompute(m1);
    const p2 = aggregator._precompute(m2);
    assert.strictEqual(aggregator._sameEventPre(p1, p2), true, 'Same match from two providers must merge');

    // Different categories should NEVER merge
    const mFoot = { id: 'sf_10', title: 'Arsenal vs Chelsea', category: 'football', date: now };
    const mBasket = { id: 'sf_11', title: 'Arsenal vs Chelsea', category: 'basketball', date: now };
    assert.strictEqual(aggregator._sameEventPre(aggregator._precompute(mFoot), aggregator._precompute(mBasket)), false, 'Different categories must not merge');

    // Events > 24 hours apart should NEVER merge
    const mDay1 = { id: 'sf_20', title: 'Lakers vs Warriors', category: 'basketball', date: now };
    const mDay2 = { id: 'sf_21', title: 'Lakers vs Warriors', category: 'basketball', date: now + (25 * 3600 * 1000) };
    assert.strictEqual(aggregator._sameEventPre(aggregator._precompute(mDay1), aggregator._precompute(mDay2)), false, 'Matches > 24h apart must not merge');

    // Exact ID match merges regardless of title variance
    const mId1 = { id: 'exact_id_xyz', title: 'Stream A', category: 'football', date: now };
    const mId2 = { id: 'exact_id_xyz', title: 'Stream B', category: 'football', date: now };
    assert.strictEqual(aggregator._sameEventPre(aggregator._precompute(mId1), aggregator._precompute(mId2)), true, 'Exact ID match must merge');
  });

  // --- 3. STREAMS.JS HANDLESTREAM END-TO-END DISPATCH STRESS TESTING ---
  console.log('\n[3] Streams.js handleStream & Mock Fallback Dispatch:');
  const { handleStream } = require('../src/streams');
  const cacheService = container.resolve('cacheService');

  await testAsync('handleStream handles synthetic match with legacy BeinArabic source cleanly', async () => {
    const testMatchId = 'test_match_bein_legacy_probe';
    const mockMatch = {
      id: testMatchId,
      title: 'beIN Sports Arabic Test',
      category: 'networks',
      date: '0',
      sources: [
        { source: 'BeinArabic', id: 'bein_ar_1' },
        { source: 'iptv-org', id: 'bein-sports-usa' }
      ]
    };
    cacheService.setMatches([mockMatch]);

    const result = await handleStream('tv', `nuvio_sport_${testMatchId}`, {});
    assert.ok(result, 'handleStream should return result object');
    assert.ok(Array.isArray(result.streams), 'result.streams should be an array');
    console.log(`     Streams returned for legacy test match: ${result.streams.length}`);
  });

  await testAsync('handleStream handles non-existent match ID gracefully', async () => {
    const result = await handleStream('tv', 'nuvio_sport_completely_nonexistent_id_999', {});
    assert.ok(result, 'handleStream should return result');
    assert.strictEqual(result.streams.length, 0, 'Non-existent match should return 0 streams');
  });

  // --- 4. 24/7 CHANNELS INGESTION & FORMAT NORMALIZATION ---
  console.log('\n[4] 24/7 Channels Normalization:');
  const iptvOrg = container.resolve('iptvOrgProvider');
  await testAsync('iptvOrgProvider returns 24/7 sports networks with valid properties', async () => {
    const matches = await iptvOrg.getMatches();
    assert.ok(Array.isArray(matches), 'Matches must be array');
    assert.strictEqual(matches.length > 0, true, `iptv-org should return channels (got ${matches.length})`);
    const sample = matches[0];
    assert.strictEqual(sample.category, 'networks', '24/7 channels should belong to networks category');
    assert.ok(sample.sources && sample.sources.length > 0, 'Channel must have at least 1 source');
  });

  // --- 5. PROVIDER INDIVIDUAL RESOLUTION INTERFACES ---
  console.log('\n[5] Provider Individual Stream Resolution Interface:');
  const testProviders = [
    { name: 'streamFreeProvider', dummyId: 'sf_skyf1', cat: 'networks', title: 'Sky Sports F1' },
    { name: 'timStreamsProvider', dummyId: 'tim_1', cat: 'football', title: 'Arsenal vs Chelsea' },
    { name: 'iptvOrgProvider', dummyId: 'bein-sports-usa', cat: 'networks', title: 'beIN Sports USA' },
    { name: 'strims24Provider', dummyId: 'strims_1', cat: 'football', title: 'Real Madrid vs Barcelona' },
    { name: 'streamedPkProvider', dummyId: 'spk_1', cat: 'football', title: 'Man City vs Liverpool' },
    { name: 'embedIndiaProvider', dummyId: 'willow-cricket', cat: 'cricket', title: 'Willow Cricket' },
    { name: 'embedStProvider', dummyId: 'espn/100/1', cat: 'networks', title: 'ESPN' },
    { name: 'cdnLiveProvider', dummyId: 'sky-sports-main-event', cat: 'networks', title: 'Sky Sports Main Event' },
    { name: 'streamSports99Provider', dummyId: 'ss99_1', cat: 'football', title: 'Arsenal vs Chelsea' },
    { name: 'streamicProvider', dummyId: 'streamic_1', cat: 'football', title: 'Arsenal vs Chelsea' },
    { name: 'watchFootyProvider', dummyId: 'wf_1', cat: 'football', title: 'Arsenal vs Chelsea' },
    { name: 'sportyHunterProvider', dummyId: 'sh_1', cat: 'football', title: 'Arsenal vs Chelsea' }
  ];

  for (const tp of testProviders) {
    await testAsync(`Provider ${tp.name}.resolveStream() responds cleanly to test input`, async () => {
      const p = container.resolve(tp.name);
      const res = await p.resolveStream(tp.dummyId, tp.cat, tp.title, { id: tp.dummyId, source: tp.name });
      assert.ok(Array.isArray(res), `${tp.name}.resolveStream must return an array`);
    });
  }

  console.log('\n===============================================================');
  console.log(`📊 CHALLENGER 2 SUITE COMPLETE: ${passed} Passed, ${failed} Failed`);
  console.log('===============================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Fatal harness crash:', err);
  process.exit(1);
});
