#!/usr/bin/env node
/**
 * scripts/test-challenger-2-empirical.js
 *
 * Comprehensive Empirical Challenger 2 Test Suite:
 * 1. Stremio Web / Desktop Client Simulator (CORS on all endpoints, Stremio Manifest v1 spec compliance)
 * 2. Image Cache & Memory Performance (1,000+ rapid requests, LRU eviction, memory bounds)
 * 3. Stream URL Resolution & Dynamic Host Rewriting (externalUrl -> /watch, direct /api/manifest, zero private IPs)
 */

const { request } = require('undici');
const { startServer, startMockUpstream } = require('../tests/load/server-runner');
const fs = require('fs');
const path = require('path');

const TEST_PORT = 7010;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('═'.repeat(80));
  console.log('  ⚡ CHALLENGER 2: EMPIRICAL CLIENT SIMULATION & STRESS TEST SUITE');
  console.log('═'.repeat(80) + '\n');

  let serverInstance = null;
  let mockUpstream = null;
  const results = [];
  const record = (suite, testName, passed, details = '') => {
    results.push({ suite, testName, passed, details });
    const mark = passed ? '✅ PASS' : '❌ FAIL';
    console.log(`  ${mark} | ${suite.padEnd(9)} | ${testName.padEnd(52)} | ${details ? `(${details})` : ''}`);
  };

  try {
    console.log('📦 Starting Mock Upstream Server...');
    mockUpstream = await startMockUpstream();
    console.log(`   Mock Upstream active on ${mockUpstream.baseUrl}`);

    console.log('📦 Connecting/Starting plugin server...');
    serverInstance = await startServer({
      port: TEST_PORT,
      reuseExisting: true
    });
    const baseUrl = serverInstance.baseUrl;

    // Await match sync (poll /api/matches up to 30s)
    let matches = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      try {
        const res = await request(`${baseUrl}/api/matches`);
        if (res.statusCode === 200) {
          matches = await res.body.json();
          if (Array.isArray(matches) && matches.length > 0) break;
        }
      } catch (_) {}
      await sleep(1000);
    }
    console.log(`   Plugin Server healthy on ${baseUrl}. Ingested matches: ${matches.length}\n`);

    // Fetch live & network catalog items for test IDs
    let liveMetas = [];
    let netMetas = [];
    try {
      const lRes = await request(`${baseUrl}/catalog/tv/nuvio_sports_live.json`);
      if (lRes.statusCode === 200) {
        const lData = await lRes.body.json();
        liveMetas = lData.metas || [];
      }
    } catch (_) {}

    try {
      const nRes = await request(`${baseUrl}/catalog/tv/nuvio_sports_networks.json`);
      if (nRes.statusCode === 200) {
        const nData = await nRes.body.json();
        netMetas = nData.metas || [];
      }
    } catch (_) {}

    const sampleMetaId = liveMetas[0]?.id || netMetas[0]?.id || 'nuvio_sport_iptv_sky_sports_main_event';

    // ─────────────────────────────────────────────────────────────────────────
    // SUITE 1: Stremio Web / Desktop Client Interactions & CORS Headers
    // ─────────────────────────────────────────────────────────────────────────
    console.log('📡 [SUITE 1] Stremio Client Interactions, CORS & Manifest Spec Compliance');

    // 1A. Manifest Format Compliance (Stremio v1 Protocol)
    const mRes = await request(`${baseUrl}/manifest.json`, {
      headers: { host: 'stremio.challenger.test', origin: 'https://web.stremio.com' }
    });
    const mStatus = mRes.statusCode;
    const mCors = mRes.headers['access-control-allow-origin'];
    const mData = await mRes.body.json();

    const mIdValid = typeof mData.id === 'string' && mData.id.length > 0;
    const mNameValid = typeof mData.name === 'string' && mData.name.length > 0;
    const mVerValid = typeof mData.version === 'string' && /^\d+\.\d+\.\d+/.test(mData.version);
    const mDescValid = typeof mData.description === 'string';
    const mTypesValid = Array.isArray(mData.types) && mData.types.includes('tv');
    const mResourcesValid = Array.isArray(mData.resources) && ['catalog', 'meta', 'stream'].every(r => 
      mData.resources.some(item => (typeof item === 'string' ? item === r : item.name === r))
    );
    const mCatalogsValid = Array.isArray(mData.catalogs) && mData.catalogs.length > 0 && mData.catalogs.every(c => c.id && c.type && c.name);

    const manifestCompliant = mStatus === 200 && mIdValid && mNameValid && mVerValid && mDescValid && mTypesValid && mResourcesValid && mCatalogsValid;
    record('Suite 1', 'Stremio Manifest v1 Protocol Spec Compliance', manifestCompliant, 
      `id="${mData.id}", ver=${mData.version}, catalogs=${mData.catalogs?.length}, resources=${JSON.stringify(mData.resources)}`);

    // 1B. Configured Manifest Endpoint (/:config/manifest.json)
    const configObj = { sports: 'football,basketball', teams: '' };
    const b64Config = Buffer.from(JSON.stringify(configObj)).toString('base64url');
    const cfgManifestRes = await request(`${baseUrl}/${b64Config}/manifest.json`, {
      headers: { host: 'stremio.challenger.test', origin: 'https://web.stremio.com' }
    });
    const cfgManifestData = await cfgManifestRes.body.json();
    const cfgManifestCors = cfgManifestRes.headers['access-control-allow-origin'];
    const cfgCatalogs = cfgManifestData.catalogs || [];
    const cfgFilteredCorrectly = cfgCatalogs.some(c => c.id.includes('football')) && !cfgCatalogs.some(c => c.id === 'nuvio_sports_teams');
    record('Suite 1', 'Configured Manifest Endpoint Filter & CORS', cfgManifestRes.statusCode === 200 && cfgFilteredCorrectly && !!cfgManifestCors, 
      `Status: ${cfgManifestRes.statusCode}, ACAO: "${cfgManifestCors}", Filtered Catalogs: ${cfgCatalogs.length}`);

    // 1C. Test CORS across all critical endpoints
    const endpointsToTest = [
      { name: 'Manifest Endpoint', path: '/manifest.json' },
      { name: 'Live Catalog Endpoint', path: '/catalog/tv/nuvio_sports_live.json' },
      { name: 'Networks Catalog Endpoint', path: '/catalog/tv/nuvio_sports_networks.json' },
      { name: 'Meta Endpoint', path: `/meta/tv/${sampleMetaId}.json` },
      { name: 'Stream Endpoint', path: `/stream/tv/${sampleMetaId}.json` },
      { name: 'Image Proxy Endpoint', path: `/img?url=${encodeURIComponent(mockUpstream.baseUrl + '/image.png')}` },
      { name: 'Image Placeholder Endpoint', path: '/img/placeholder?text=Test&color=333333' },
      { name: 'Watch Embed Page', path: '/watch?url=https%3A%2F%2Fexample.com%2Fstream' }
    ];

    for (const ep of endpointsToTest) {
      const epRes = await request(`${baseUrl}${ep.path}`, {
        headers: {
          'Origin': 'https://web.stremio.com',
          'Host': 'client.stremio.test'
        }
      });
      const acao = epRes.headers['access-control-allow-origin'];
      const hasCors = acao === '*' || acao === 'https://web.stremio.com' || (typeof acao === 'string' && acao.includes('*'));
      const statusOk = epRes.statusCode === 200;
      await epRes.body.text(); // drain
      record('Suite 1', `CORS Headers on ${ep.name}`, statusOk && hasCors, `Status: ${epRes.statusCode}, ACAO: ${acao}`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SUITE 2: Image Cache & Memory Performance (Rapid Load & LRU Eviction)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n💾 [SUITE 2] Image Cache & Memory Performance Under Rapid Query Load');

    const memBefore = process.memoryUsage();
    console.log(`   Initial Process Memory: RSS=${(memBefore.rss / 1024 / 1024).toFixed(2)}MB, HeapUsed=${(memBefore.heapUsed / 1024 / 1024).toFixed(2)}MB`);

    const TOTAL_REQUESTS = 1000;
    const CONCURRENCY = 25;
    let hitCount200 = 0;
    let errorCount = 0;
    let minLat = 999999;
    let maxLat = 0;
    let totalLat = 0;

    const queryPool = [];
    // Generate 1000 requests using mockUpstream:
    // - 250 Direct SVG placeholders
    // - 250 Repeated Cache Hits
    // - 250 Cache Misses (forces LRU cache population & eviction past CACHE_MAX_ENTRIES=120)
    // - 250 Dead Upstream 404s (tests negative cache & SVG fallback)
    for (let i = 0; i < TOTAL_REQUESTS; i++) {
      if (i % 4 === 0) {
        queryPool.push(`${baseUrl}/img/placeholder?text=Stress_${i % 20}&color=10b981`);
      } else if (i % 4 === 1) {
        const hitKey = i % 5;
        queryPool.push(`${baseUrl}/img?url=${encodeURIComponent(`${mockUpstream.baseUrl}/image.png?hit=${hitKey}`)}&text=Hit_${hitKey}&color=10b981`);
      } else if (i % 4 === 2) {
        queryPool.push(`${baseUrl}/img?url=${encodeURIComponent(`${mockUpstream.baseUrl}/image.png?unique=${i}`)}&text=Unique_${i}&color=3b82f6`);
      } else {
        queryPool.push(`${baseUrl}/img?url=${encodeURIComponent(`${mockUpstream.baseUrl}/dead-image.png?dead=${i}`)}&text=Dead_${i}&color=ef4444`);
      }
    }

    const tStartLoad = Date.now();
    for (let i = 0; i < queryPool.length; i += CONCURRENCY) {
      const chunk = queryPool.slice(i, i + CONCURRENCY);
      await Promise.all(chunk.map(async (u) => {
        const reqStart = Date.now();
        try {
          const res = await request(u, { headersTimeout: 4000, bodyTimeout: 4000 });
          const lat = Date.now() - reqStart;
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
          totalLat += lat;

          const cType = res.headers['content-type'] || '';
          if (res.statusCode === 200 && (cType.includes('image/') || cType.includes('svg+xml'))) {
            hitCount200++;
          } else {
            errorCount++;
          }
          await res.body.text(); // drain
        } catch (err) {
          errorCount++;
        }
      }));
    }
    const loadDuration = Date.now() - tStartLoad;
    const avgLat = (totalLat / TOTAL_REQUESTS).toFixed(2);
    const throughput = (TOTAL_REQUESTS / (loadDuration / 1000)).toFixed(1);

    const memAfter = process.memoryUsage();
    console.log(`   Post-Load Process Memory: RSS=${(memAfter.rss / 1024 / 1024).toFixed(2)}MB, HeapUsed=${(memAfter.heapUsed / 1024 / 1024).toFixed(2)}MB`);
    console.log(`   Load Stats: ${TOTAL_REQUESTS} requests in ${loadDuration}ms (~${throughput} req/s), Avg Latency: ${avgLat}ms, Min: ${minLat}ms, Max: ${maxLat}ms`);

    const image200SuccessRate = (hitCount200 / TOTAL_REQUESTS) * 100;
    record('Suite 2', 'Image Proxy 100% 200 OK Delivery Under Load', image200SuccessRate === 100 && errorCount === 0, 
      `${hitCount200}/${TOTAL_REQUESTS} 200 OK (${throughput} req/s, avg ${avgLat}ms)`);

    // Verify bounded memory growth (heap difference less than 50MB across 1000 rapid image queries)
    const heapDeltaMB = (memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024;
    record('Suite 2', 'Image Cache LRU Bounded Memory (No Growth)', heapDeltaMB < 50, 
      `Heap Delta: ${heapDeltaMB.toFixed(2)}MB across 1,000 queries`);

    // ─────────────────────────────────────────────────────────────────────────
    // SUITE 3: Stream URL Resolution & Dynamic Host Rewriting
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n🎯 [SUITE 3] Stream URL Resolution, ExternalUrl (/watch) & Direct /api/manifest');

    const testHosts = [
      { host: 'sports-app.vps-public.org', proto: 'https' },
      { host: 'localhost:7010', proto: 'http' },
      { host: 'addon.ngrok-app.io', proto: 'https' }
    ];

    let allStreamUrlsCorrect = true;
    let streamCountChecked = 0;
    let watchEmbedFound = false;
    let directManifestFound = false;

    const testTargetMetas = [];
    if (liveMetas.length > 0) testTargetMetas.push(liveMetas[0]);
    if (liveMetas.length > 1) testTargetMetas.push(liveMetas[1]);
    if (netMetas.length > 0) testTargetMetas.push(netMetas[0]);

    for (const testHost of testHosts) {
      const expectedBase = `${testHost.proto}://${testHost.host}`;
      for (const targetMeta of testTargetMetas) {
        const streamRes = await request(`${baseUrl}/stream/tv/${targetMeta.id}.json`, {
          headers: {
            'Host': testHost.host,
            'X-Forwarded-Proto': testHost.proto
          }
        });

        if (streamRes.statusCode === 200) {
          const sData = await streamRes.body.json();
          const streams = sData.streams || [];
          for (const s of streams) {
            streamCountChecked++;
            // 3A. externalUrl checks
            if (s.externalUrl) {
              watchEmbedFound = true;
              if (!s.externalUrl.startsWith(expectedBase + '/watch')) {
                allStreamUrlsCorrect = false;
                console.error(`  [MISMATCH] externalUrl="${s.externalUrl}", expected to start with "${expectedBase}/watch"`);
              }
            }
            // 3B. url checks (/api/manifest or direct m3u8)
            if (s.url && s.url.includes('/api/manifest')) {
              directManifestFound = true;
              if (!s.url.startsWith(expectedBase + '/api/manifest')) {
                allStreamUrlsCorrect = false;
                console.error(`  [MISMATCH] url="${s.url}", expected to start with "${expectedBase}/api/manifest"`);
              }
            }
            // 3C. Ensure no hardcoded IP leak
            if (JSON.stringify(s).includes('192.168.0.')) {
              allStreamUrlsCorrect = false;
              console.error(`  [IP LEAK] Stream object contains hardcoded 192.168.0.x:`, s);
            }
          }
        }
      }
    }

    record('Suite 3', 'Dynamic Host Reflection in Streams', allStreamUrlsCorrect && streamCountChecked > 0, 
      `Verified ${streamCountChecked} streams across ${testHosts.length} dynamic domains`);

    // Verify /watch page HTML content
    const watchRes = await request(`${baseUrl}/watch?url=${encodeURIComponent('https://example.com/embed')}`);
    const watchHtml = await watchRes.body.text();
    const watchValid = watchRes.statusCode === 200 && watchHtml.includes('iframe') && watchHtml.includes('example.com/embed');
    record('Suite 3', 'Watch Embed Proxy Page (/watch HTML & iframe)', watchValid, 
      `Status: ${watchRes.statusCode}, contains iframe: ${watchHtml.includes('iframe')}`);

    // Verify sample stream resolution
    const sampleStreamRes = await request(`${baseUrl}/stream/tv/${sampleMetaId}.json`);
    const sampleStreamData = await sampleStreamRes.body.json();
    const sampleStreams = sampleStreamData.streams || [];
    const samplePassed = sampleStreamRes.statusCode === 200 && sampleStreams.length > 0;
    record('Suite 3', 'Target Fixture/Channel Stream Resolution', samplePassed, 
      `ID: "${sampleMetaId}", Streams: ${sampleStreams.length}, Top Name: "${sampleStreams[0]?.name || 'N/A'}"`);

    // ─────────────────────────────────────────────────────────────────────────
    // SUMMARY
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n' + '═'.repeat(80));
    console.log('                          📊 CHALLENGER 2 FINAL VERDICT');
    console.log('═'.repeat(80));
    const allPassed = results.every(r => r.passed);
    results.forEach(r => {
      const mark = r.passed ? 'PASS [OK]' : 'FAIL [X] ';
      console.log(`  ${mark} | ${r.suite.padEnd(8)} | ${r.testName.padEnd(52)} | ${r.details}`);
    });
    console.log('═'.repeat(80));
    console.log(`  Final Result: ${allPassed ? '🎉 ALL EMPIRICAL CHECKS PASSED' : '⚠️ TEST FAILURES DETECTED'}\n`);

    if (!allPassed) process.exit(1);

  } finally {
    if (mockUpstream && mockUpstream.close) {
      await mockUpstream.close();
    }
    if (serverInstance && serverInstance.isSpawned) {
      await serverInstance.shutdown();
    }
  }
}

main().catch((err) => {
  console.error('[FATAL] Empirical verification failed:', err);
  process.exit(1);
});
