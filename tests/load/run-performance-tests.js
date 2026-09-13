#!/usr/bin/env node
/**
 * tests/load/run-performance-tests.js
 *
 * Standalone CLI test runner for Nuvio Live Sports Plugin Performance & Load Suite:
 * - Boots/connects to Nuvio Express server on isolated test port
 * - Boots deterministic mock upstream server
 * - Waits for initial match catalog sync & background stabilization
 * - Executes all 6 load and cache performance scenarios sequentially
 * - Collects real-time telemetry from /health
 * - Formats and prints comprehensive metric tables & audit report
 * - Gracefully tears down all processes and exits cleanly with code 0/1
 */

const { startServer, startMockUpstream } = require('./server-runner');
const { formatStatsTable } = require('./load-test-harness');
const {
  runBaselineHealthScenario,
  runCatalogBrowsingScenario,
  runStreamResolutionBenchmark,
  runSingleFlightStress,
  runManifestProxyScenario,
  runImageProxyScenario,
  fetchTelemetry,
  fetchMatches
} = require('./scenarios');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    port: 7010,
    concurrencyMultiplier: 0.2,
    reuseExisting: true
  };

  for (const arg of args) {
    if (arg.startsWith('--port=')) {
      options.port = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--concurrency-multiplier=')) {
      options.concurrencyMultiplier = parseFloat(arg.split('=')[1]);
    } else if (arg === '--fresh' || arg === '--no-reuse') {
      options.reuseExisting = false;
    }
  }

  return options;
}

function printHeader() {
  console.log('\n' + '═'.repeat(76));
  console.log('  🚀 NUVIO LIVE SPORTS PLUGIN — PERFORMANCE & LOAD TEST SUITE');
  console.log('═'.repeat(76) + '\n');
}

function printScenarioResult(result) {
  const icon = result.passed ? '✅' : '❌';
  console.log(`\n${icon} [${result.name}]`);
  console.log(`   Summary: ${result.summary}`);
  if (result.stats) {
    console.log(formatStatsTable(result.name, result.stats));
  } else if (result.warmStats) {
    console.log(formatStatsTable(result.name + ' (Warm)', result.warmStats));
  }
}

function printExecutiveSummaryTable(scenarioResults, initialTelemetry, finalTelemetry, totalElapsedSec) {
  const pad = (s, n) => String(s).padEnd(n);
  const padR = (s, n) => String(s).padStart(n);

  console.log('\n' + '═'.repeat(108));
  console.log('                         🏆 EXECUTIVE PERFORMANCE & LOAD TEST SUMMARY REPORT');
  console.log('═'.repeat(108));

  console.log(
    `| ${pad('Scenario / Benchmark', 42)} | ${padR('Reqs', 6)} | ${padR('Succ %', 7)} | ${padR('RPS', 9)} | ${padR('P50(ms)', 8)} | ${padR('P95(ms)', 8)} | ${padR('P99(ms)', 8)} | ${pad('Status', 7)} |`
  );
  console.log('|' + '-'.repeat(44) + '|' + '-'.repeat(8) + '|' + '-'.repeat(9) + '|' + '-'.repeat(11) + '|' + '-'.repeat(10) + '|' + '-'.repeat(10) + '|' + '-'.repeat(10) + '|' + '-'.repeat(9) + '|');

  for (const res of scenarioResults) {
    const s = res.stats || res.warmStats;
    const reqs = s ? s.totalRequests : 0;
    const succPct = s ? (100 - s.errorRatePct).toFixed(1) + '%' : 'N/A';
    const rps = s ? s.throughputRps : 'N/A';
    const p50 = s ? s.medianMs : 'N/A';
    const p95 = s ? s.p95Ms : 'N/A';
    const p99 = s ? s.p99Ms : 'N/A';
    const status = res.passed ? 'PASS ✅' : 'FAIL ❌';

    console.log(
      `| ${pad(res.name, 42)} | ${padR(reqs, 6)} | ${padR(succPct, 7)} | ${padR(rps, 9)} | ${padR(p50, 8)} | ${padR(p95, 8)} | ${padR(p99, 8)} | ${pad(status, 7)} |`
    );
  }
  console.log('═'.repeat(108));

  // Telemetry deltas
  console.log('\n📊 SERVER CACHE TELEMETRY AUDIT (/health):');
  if (finalTelemetry) {
    const initHits = initialTelemetry ? initialTelemetry.hits : 0;
    const initMisses = initialTelemetry ? initialTelemetry.misses : 0;
    const initNegHits = initialTelemetry ? initialTelemetry.negativeHits : 0;
    const initEvictions = initialTelemetry ? initialTelemetry.evictions : 0;

    const deltaHits = finalTelemetry.hits - initHits;
    const deltaMisses = finalTelemetry.misses - initMisses;
    const deltaNegHits = finalTelemetry.negativeHits - initNegHits;
    const deltaEvictions = finalTelemetry.evictions - initEvictions;

    const totalOps = deltaHits + deltaMisses;
    const hitRatio = totalOps > 0 ? ((deltaHits / totalOps) * 100).toFixed(2) + '%' : '100%';

    console.log(`   • Total StreamResolveCache Hits      : ${finalTelemetry.hits} (Delta: +${deltaHits})`);
    console.log(`   • Total StreamResolveCache Misses    : ${finalTelemetry.misses} (Delta: +${deltaMisses})`);
    console.log(`   • Total Negative Cache Hits          : ${finalTelemetry.negativeHits} (Delta: +${deltaNegHits})`);
    console.log(`   • Total LRU Evictions                : ${finalTelemetry.evictions} (Delta: +${deltaEvictions})`);
    console.log(`   • Effective Stream Cache Hit Ratio   : ${hitRatio}`);
    console.log(`   • Active In-Flight Promises          : ${finalTelemetry.inFlight || 0}`);
    console.log(`   • Active Cache Entries               : ${finalTelemetry.entries || 0}`);
    console.log(`   • Learned Provider TTLs              : ${JSON.stringify(finalTelemetry.learnedTtls || {})}`);
  } else {
    console.log('   • Telemetry unavailable.');
  }

  console.log(`\n⏱️ Total Test Suite Execution Time: ${totalElapsedSec.toFixed(2)}s\n`);
}

async function main() {
  const options = parseArgs();
  printHeader();

  const tSuiteStart = Date.now();
  let serverInstance = null;
  let mockUpstream = null;
  const scenarioResults = [];

  try {
    // 1. Start Mock Upstream Server
    console.log('⚙️ [Setup] Starting Mock Upstream Server...');
    mockUpstream = await startMockUpstream();
    console.log(`   Mock Upstream running at ${mockUpstream.baseUrl}`);

    // 2. Start / Connect Nuvio Server
    console.log('\n⚙️ [Setup] Starting / Connecting Nuvio Live Sports Server...');
    serverInstance = await startServer({
      port: options.port,
      reuseExisting: options.reuseExisting,
      timeoutMs: 180000
    });

    // 3. Wait for initial match catalog sync & background worker stabilization
    console.log('\n⚙️ [Setup] Awaiting match catalog readiness and background stabilization...');
    const syncStart = Date.now();
    let matchesCount = 0;
    while (Date.now() - syncStart < 30000) {
      const matches = await fetchMatches(serverInstance.baseUrl);
      matchesCount = matches.length;
      if (matchesCount > 0) break;
      await sleep(500);
    }
    // Allow background scraping promises to fully settle
    await sleep(15000);
    const settledMatches = await fetchMatches(serverInstance.baseUrl);
    matchesCount = settledMatches.length;
    console.log(`   Catalog active with ${matchesCount} events. Background settled.`);

    const initialTelemetry = await fetchTelemetry(serverInstance.baseUrl);
    console.log('   Initial Baseline Telemetry:', JSON.stringify(initialTelemetry || {}));

    // 4. Scenario 1: Baseline Health & Manifest Concurrency
    console.log('\n👉 Executing Scenario 1: Baseline Health & Manifest Concurrency...');
    const s1 = await runBaselineHealthScenario(serverInstance.baseUrl, {
      concurrency: Math.round(50 * options.concurrencyMultiplier),
      totalRequests: Math.round(200 * options.concurrencyMultiplier)
    });
    scenarioResults.push(s1);
    printScenarioResult(s1);

    // 5. Scenario 2: Catalog Browsing & SWR Load
    console.log('\n👉 Executing Scenario 2: Catalog Browsing & SWR Concurrency...');
    const s2 = await runCatalogBrowsingScenario(serverInstance.baseUrl, {
      concurrency: Math.round(15 * options.concurrencyMultiplier),
      totalRequests: Math.round(60 * options.concurrencyMultiplier)
    });
    scenarioResults.push(s2);
    printScenarioResult(s2);

    // 6. Scenario 3: Stream Resolution Cache Miss vs Hit Benchmark
    console.log('\n👉 Executing Scenario 3: Stream Resolution Cache Miss vs Hit Benchmark...');
    const s3 = await runStreamResolutionBenchmark(serverInstance.baseUrl, {
      concurrency: Math.round(50 * options.concurrencyMultiplier),
      totalRequests: Math.round(60 * options.concurrencyMultiplier)
    });
    scenarioResults.push(s3);
    printScenarioResult(s3);

    const s3MatchId = s3.benchmarkMetrics && s3.benchmarkMetrics.targetMatchId
      ? s3.benchmarkMetrics.targetMatchId.replace('nuvio_sport_', '')
      : null;

    // 7. Scenario 4: Single-Flight Coalescing Stress (Thundering Herd)
    console.log('\n👉 Executing Scenario 4: Single-Flight Coalescing Stress...');
    const s4 = await runSingleFlightStress(serverInstance.baseUrl, {
      count: Math.round(50 * options.concurrencyMultiplier),
      excludeMatchId: s3MatchId
    });
    scenarioResults.push(s4);
    printScenarioResult(s4);

    // 8. Scenario 5: HLS Manifest Proxy Polling & Header Verification
    console.log('\n👉 Executing Scenario 5: HLS Manifest Proxy Polling & Header Verification...');
    const s5 = await runManifestProxyScenario(serverInstance.baseUrl, mockUpstream, {
      concurrency: Math.round(40 * options.concurrencyMultiplier),
      totalRequests: Math.round(80 * options.concurrencyMultiplier)
    });
    scenarioResults.push(s5);
    printScenarioResult(s5);

    // 9. Scenario 6: Image Proxy & SVG Placeholder Cache
    console.log('\n👉 Executing Scenario 6: Image Proxy & SVG Placeholder Cache...');
    const s6 = await runImageProxyScenario(serverInstance.baseUrl, mockUpstream, {
      concurrency: Math.round(30 * options.concurrencyMultiplier),
      totalRequests: Math.round(90 * options.concurrencyMultiplier)
    });
    scenarioResults.push(s6);
    printScenarioResult(s6);

    // 10. Fetch Final Telemetry
    const finalTelemetry = await fetchTelemetry(serverInstance.baseUrl);

    const totalElapsedSec = (Date.now() - tSuiteStart) / 1000;
    printExecutiveSummaryTable(scenarioResults, initialTelemetry, finalTelemetry, totalElapsedSec);

    const allPassed = scenarioResults.every((r) => r.passed);

    if (allPassed) {
      console.log('🎉 ALL 6 PERFORMANCE & LOAD SCENARIOS PASSED WITH ZERO ERRORS!\n');
    } else {
      const failedCount = scenarioResults.filter((r) => !r.passed).length;
      console.error(`💥 ${failedCount} OF 6 SCENARIOS FAILED AUDIT CRITERIA.\n`);
    }

    return allPassed;
  } finally {
    console.log('🧹 [Teardown] Cleaning up servers & child processes...');
    if (mockUpstream) {
      await mockUpstream.close().catch(() => {});
    }
    if (serverInstance && serverInstance.shutdown) {
      await serverInstance.shutdown().catch(() => {});
    }
    console.log('✅ [Teardown] Teardown complete.\n');
  }
}

if (require.main === module) {
  main()
    .then((success) => {
      process.exit(success ? 0 : 1);
    })
    .catch((err) => {
      console.error('💥 Fatal error in performance test suite:', err);
      process.exit(1);
    });
}

module.exports = { main };
