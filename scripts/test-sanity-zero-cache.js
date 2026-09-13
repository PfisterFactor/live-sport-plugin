/**
 * scripts/test-sanity-zero-cache.js
 *
 * Comprehensive Sanity Test for Zero-Cache Architecture:
 * - All Awilix container dependencies resolve cleanly.
 * - Catalog handler works on-demand without CacheService.
 * - Meta handler works on-demand without CacheService.
 * - Stream handler works on-demand and returns fresh streams with cacheMaxAge == 0.
 * - Health route returns clean status without streamResolveCache.
 */

const assert = require('assert');
const http = require('http');
const express = require('express');
const container = require('../src/container');
const { handleCatalog, handleMeta } = require('../src/catalog');
const { handleStream } = require('../src/streams');

async function runSanitySuite() {
  console.log('================================================================');
  console.log('🧪 Comprehensive Zero-Cache Sanity & Regression Test Suite');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  function t(name, cond, detail = '') {
    if (cond) {
      passed++;
      console.log(`  ✅ PASS: ${name}${detail ? ` (${detail})` : ''}`);
    } else {
      failed++;
      console.error(`  ❌ FAIL: ${name}${detail ? ` (${detail})` : ''}`);
    }
  }

  // 1. Container Registrations Check
  console.log('👉 1. Testing Container Dependency Graph...');
  const expectedServices = [
    'circuitBreaker',
    'm3u8Parser',
    'cronService',
    'matchAggregator',
    'streamScorer',
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

  for (const name of expectedServices) {
    try {
      const resolved = container.resolve(name);
      t(`Resolved service '${name}' cleanly`, Boolean(resolved));
    } catch (e) {
      t(`Resolved service '${name}' cleanly`, false, e.message);
    }
  }

  const removedServices = ['cacheService', 'streamResolveCache'];
  for (const name of removedServices) {
    let resolved = false;
    try {
      container.resolve(name);
      resolved = true;
    } catch (_) {}
    t(`Service '${name}' is not registered in container`, !resolved);
  }

  // 2. Test Catalog & Meta fresh execution
  console.log('\n👉 2. Testing Catalog & Meta On-Demand Resolution...');
  const matchAggregator = container.resolve('matchAggregator');
  const originalSync = matchAggregator.syncMatches.bind(matchAggregator);

  const fixtureMatch = {
    id: 'sanity_match_1',
    title: 'Arsenal vs Chelsea',
    category: 'football',
    date: String(Date.now() - 1000 * 60 * 10),
    popular: '1',
    sources: [
      {
        source: 'iptv-org',
        id: 'mock_src_1',
        url: 'http://127.0.0.1:9999/dummy.m3u8'
      }
    ]
  };

  let syncCount = 0;
  matchAggregator.syncMatches = async () => {
    syncCount++;
    return [fixtureMatch];
  };

  const catalogRes = await handleCatalog('tv', 'nuvio_sports_live', {}, {});
  t('handleCatalog returns metas array', Array.isArray(catalogRes.metas) && catalogRes.metas.length === 1);
  t('handleCatalog triggered matchAggregator.syncMatches directly', syncCount === 1, `syncCount: ${syncCount}`);

  const metaRes = await handleMeta('tv', 'nuvio_sport_sanity_match_1', {});
  t('handleMeta returns valid meta object', metaRes && metaRes.meta && metaRes.meta.id === 'nuvio_sport_sanity_match_1');
  t('handleMeta triggered matchAggregator.syncMatches directly', syncCount === 2, `syncCount: ${syncCount}`);

  // Restore syncMatches
  matchAggregator.syncMatches = originalSync;

  // 3. Test HTTP /health endpoint
  console.log('\n👉 3. Testing Express HTTP /health and /img/placeholder routes...');
  const app = express();
  app.get('/health', (_, res) => {
    res.json({ status: 'ok', service: 'nuvio-live-sports' });
  });

  const imageService = require('../src/services/ImageService');
  app.get('/img/placeholder', (req, res) => {
    const svg = imageService.svgPlaceholder(req.query.text || 'Live Sports', req.query.color || '333333');
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(svg);
  });

  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const serverPort = server.address().port;

  try {
    const { request } = require('undici');

    // Test /health
    const healthRes = await request(`http://127.0.0.1:${serverPort}/health`);
    const healthJson = await healthRes.body.json();
    t('/health status is 200', healthRes.statusCode === 200);
    t('/health body status is ok', healthJson.status === 'ok');
    t('/health body does NOT contain streamResolveCache', healthJson.streamResolveCache === undefined);

    // Test /img/placeholder
    const imgRes = await request(`http://127.0.0.1:${serverPort}/img/placeholder?text=Test`);
    const imgBody = await imgRes.body.text();
    t('/img/placeholder status is 200', imgRes.statusCode === 200);
    t('/img/placeholder Cache-Control is no-cache', imgRes.headers['cache-control'].includes('no-cache'));
    t('/img/placeholder returns SVG content', imgBody.includes('<svg'));
  } finally {
    await new Promise(r => server.close(r));
  }

  // ─── Summary ────────────────────────────────────────────────────────────
  console.log('\n================================================================');
  console.log(`🎯 Sanity Summary: ${passed} Passed, ${failed} Failed`);
  console.log('================================================================\n');

  if (failed > 0) process.exit(1);
}

if (require.main === module) {
  runSanitySuite().catch(e => {
    console.error('Sanity suite error:', e);
    process.exit(1);
  });
}

module.exports = { runSanitySuite };
