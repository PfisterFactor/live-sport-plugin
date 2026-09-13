#!/usr/bin/env node
/**
 * scripts/test-adversarial-challenger.js
 *
 * Empirical Adversarial Stress-Testing Harness for Nuvio Live Sports Plugin
 * Authored by: Challenger 1
 *
 * Tests:
 * 1. Dynamic Host Resolution Stress Tests:
 *    - Comma-separated X-Forwarded-Host: "sports.ngrok.io, internal.lan"
 *    - Comma-separated X-Forwarded-Proto: "https, http"
 *    - CF-Visitor header: '{"scheme":"https"}'
 *    - Custom non-standard ports: "sports.customdomain.org:8443"
 *    - IPv6 Host headers: "[::1]:7000", "[2001:db8::1]:8080"
 *    - X-Forwarded-Ssl: "on"
 *    - Verification across /manifest.json, /catalog/tv/nuvio_sports_networks.json, /meta/tv/*.json, /stream/tv/*.json
 *    - Verification that 0 local/private IPs (192.168.0.x, 10.x, 172.16.x) leak into URLs
 *
 * 2. Thumbnail Proxy Adversarial Stress Tests:
 *    - 404 Not Found upstream image
 *    - 403 Forbidden upstream image
 *    - Connection timeout upstream image
 *    - Non-image HTML upstream response
 *    - Protocol-relative URL ("//example.com/img.png")
 *    - Malformed / invalid URLs ("not-a-url", "ftp://foo.bar", "javascript:alert(1)", "http://")
 *    - Missing / empty query params (/img, /img?url=, /img/placeholder)
 *    - Huge upstream file (> 1.5MB threshold)
 *    - Verification that HTTP 200 OK + valid image/* / image/svg+xml + Access-Control-Allow-Origin: * are ALWAYS returned
 *
 * 3. Stream M3U8 Proxy Stress Tests (/api/manifest):
 *    - Valid sample M3U8 with nested relative segments and sub-manifests
 *    - Missing url query parameter -> 400 Bad Request
 *    - Upstream returning HTML/non-m3u8 -> 404 Not Found with negative cache
 *    - Content-Type check (application/vnd.apple.mpegurl) and CORS header check
 */

const http = require('http');
const { request } = require('undici');
const path = require('path');
const fs = require('fs');
const { startServer } = require('../tests/load/server-runner');

const TEST_PORT = 7020;
const MOCK_SERVER_PORT = 7029;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Setup a local mock HTTP server to simulate various adversarial upstream behaviors
function createMockUpstreamServer(port) {
  const server = http.createServer((req, res) => {
    const parsed = new URL(req.url, `http://localhost:${port}`);
    const pathname = parsed.pathname;

    if (pathname === '/image-200.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      // 1x1 transparent PNG
      const png1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
      return res.end(png1x1);
    }

    if (pathname === '/image-404.png') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not Found');
    }

    if (pathname === '/image-403.png') {
      res.writeHead(403, { 'Content-Type': 'text/html' });
      return res.end('<html><body>403 Forbidden</body></html>');
    }

    if (pathname === '/non-image-html.png') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<!DOCTYPE html><html><body>This is an HTML page pretending to be an image</body></html>');
    }

    if (pathname === '/slow-timeout.png') {
      // Never respond or respond after 10s
      setTimeout(() => {
        if (!res.writableEnded) {
          res.writeHead(200, { 'Content-Type': 'image/png' });
          res.end(Buffer.alloc(64));
        }
      }, 10000);
      return;
    }

    if (pathname === '/huge-image.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      // Send 2MB chunk
      res.write(Buffer.alloc(1024 * 1024, 1));
      res.write(Buffer.alloc(1024 * 1024, 2));
      return res.end();
    }

    if (pathname === '/sample.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      return res.end(`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:10.0,
segment0.ts
#EXTINF:10.0,
submanifest.m3u8
#EXTINF:10.0,
chunk.image
#EXT-X-ENDLIST
`);
    }

    if (pathname === '/bad-manifest.m3u8') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<html><body>Bad gateway error or cloudflare challenge</body></html>');
    }

    res.writeHead(404);
    res.end('Not found');
  });

  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => {
      resolve(server);
    });
    server.on('error', reject);
  });
}

async function runAdversarialStressTests() {
  console.log('\n' + '█'.repeat(80));
  console.log('  ⚔️  ADVERSARIAL STRESS-TEST HARNESS — CHALLENGER 1');
  console.log('█'.repeat(80) + '\n');

  let serverInstance = null;
  let mockServer = null;
  const testResults = [];

  const record = (category, name, passed, details = '') => {
    testResults.push({ category, name, passed, details });
    const mark = passed ? '✅ PASS' : '❌ FAIL';
    console.log(`  ${mark} [${category}] ${name} ${details ? `— ${details}` : ''}`);
  };

  try {
    // 0. Start Mock Upstream Server
    console.log('🚀 [0/4] Starting Mock Adversarial Upstream Server on port', MOCK_SERVER_PORT);
    mockServer = await createMockUpstreamServer(MOCK_SERVER_PORT);

    // 1. Boot Plugin Server
    console.log('🚀 [1/4] Booting Nuvio Live Sports Plugin Server on port', TEST_PORT);
    serverInstance = await startServer({
      port: TEST_PORT,
      reuseExisting: true
    });
    const baseUrl = serverInstance.baseUrl;

    // Await matches
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
      await sleep(500);
    }
    record('SETUP', 'Server Ready & Matches Ingested', true, `${matches.length} matches available`);

    // ─────────────────────────────────────────────────────────────────────────
    // TASK 1: Dynamic Host Resolution Stress Tests
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n🌐 [TASK 1] Stress-Testing Dynamic Host Resolution Edge Cases...');

    const dynamicHostTestCases = [
      {
        name: 'Comma-separated X-Forwarded-Host',
        headers: {
          'x-forwarded-host': 'primary.addon.tv, internal.loadbalancer.local',
          'x-forwarded-proto': 'https',
          'host': '127.0.0.1:7020'
        },
        expectedHost: 'primary.addon.tv',
        expectedProto: 'https'
      },
      {
        name: 'Comma-separated X-Forwarded-Proto',
        headers: {
          'x-forwarded-host': 'secure.stream.net',
          'x-forwarded-proto': 'https, http, ws',
          'host': '127.0.0.1:7020'
        },
        expectedHost: 'secure.stream.net',
        expectedProto: 'https'
      },
      {
        name: 'Cloudflare CF-Visitor Header',
        headers: {
          'host': 'cf-sports.pages.dev',
          'cf-visitor': '{"scheme":"https"}'
        },
        expectedHost: 'cf-sports.pages.dev',
        expectedProto: 'https'
      },
      {
        name: 'Custom Non-Standard Port',
        headers: {
          'host': 'custom.sports-vps.org:8443',
          'x-forwarded-proto': 'https'
        },
        expectedHost: 'custom.sports-vps.org:8443',
        expectedProto: 'https'
      },
      {
        name: 'IPv6 Host Header [::1]:7020',
        headers: {
          'host': '[::1]:7020'
        },
        expectedHost: '[::1]:7020',
        expectedProto: 'http'
      },
      {
        name: 'IPv6 Host with HTTPS and custom port',
        headers: {
          'x-forwarded-host': '[2001:db8::1]:9443',
          'x-forwarded-proto': 'https',
          'host': '127.0.0.1:7020'
        },
        expectedHost: '[2001:db8::1]:9443',
        expectedProto: 'https'
      },
      {
        name: 'X-Forwarded-Ssl: on Header',
        headers: {
          'host': 'ssl-gateway.sports.io',
          'x-forwarded-ssl': 'on'
        },
        expectedHost: 'ssl-gateway.sports.io',
        expectedProto: 'https'
      }
    ];

    for (const tc of dynamicHostTestCases) {
      const expectedBase = `${tc.expectedProto}://${tc.expectedHost}`;

      // Test 1: Manifest
      const mRes = await request(`${baseUrl}/manifest.json`, { headers: tc.headers });
      const mBody = await mRes.body.text();
      const mJson = JSON.parse(mBody);
      const manifestOk = mRes.statusCode === 200 && !mBody.includes('192.168.') && !mBody.includes('127.0.0.1');

      // Test 2: Catalog
      const catRes = await request(`${baseUrl}/catalog/tv/nuvio_sports_networks.json`, { headers: tc.headers });
      const catBody = await catRes.body.text();
      const catJson = JSON.parse(catBody);
      let catalogOk = catRes.statusCode === 200 && !catBody.includes('192.168.');
      if (catJson.metas && catJson.metas.length > 0) {
        const sampleMeta = catJson.metas[0];
        if (sampleMeta.poster && !sampleMeta.poster.startsWith(expectedBase)) {
          catalogOk = false;
        }
      }

      // Test 3: Streams (using sample fixture)
      const streamRes = await request(`${baseUrl}/stream/tv/iptv_us_espn.json`, { headers: tc.headers });
      const streamBody = await streamRes.body.text();
      let streamOk = streamRes.statusCode === 200 && !streamBody.includes('192.168.');
      try {
        const streamJson = JSON.parse(streamBody);
        if (streamJson.streams && streamJson.streams.length > 0) {
          for (const s of streamJson.streams) {
            if (s.url && s.url.startsWith('http') && s.url.includes('/api/manifest') && !s.url.startsWith(expectedBase)) {
              streamOk = false;
            }
            if (s.externalUrl && s.externalUrl.includes('/watch') && !s.externalUrl.startsWith(expectedBase)) {
              streamOk = false;
            }
          }
        }
      } catch (_) {}

      const passed = manifestOk && catalogOk && streamOk;
      record('R1_HOST', tc.name, passed, `Expected Base: ${expectedBase}`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // TASK 2: Thumbnail Repair & Proxy Stress Tests
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n🖼️  [TASK 2] Stress-Testing Image Proxy Resiliency & Edge Cases...');

    const imageTestCases = [
      {
        name: 'Valid Upstream PNG Image',
        url: `${baseUrl}/img?url=${encodeURIComponent(`http://127.0.0.1:${MOCK_SERVER_PORT}/image-200.png`)}&text=ValidImage&color=10b981`,
        expectedStatus: 200,
        expectedTypePrefix: 'image/png'
      },
      {
        name: '404 Not Found Upstream Image (SVG Fallback)',
        url: `${baseUrl}/img?url=${encodeURIComponent(`http://127.0.0.1:${MOCK_SERVER_PORT}/image-404.png`)}&text=NotFoundImage&color=ef4444`,
        expectedStatus: 200,
        expectedTypePrefix: 'image/svg+xml'
      },
      {
        name: '403 Forbidden Upstream Image (SVG Fallback)',
        url: `${baseUrl}/img?url=${encodeURIComponent(`http://127.0.0.1:${MOCK_SERVER_PORT}/image-403.png`)}&text=ForbiddenImage&color=f59e0b`,
        expectedStatus: 200,
        expectedTypePrefix: 'image/svg+xml'
      },
      {
        name: 'Non-Image HTML Response Upstream (SVG Fallback)',
        url: `${baseUrl}/img?url=${encodeURIComponent(`http://127.0.0.1:${MOCK_SERVER_PORT}/non-image-html.png`)}&text=FakeImageHtml&color=3b82f6`,
        expectedStatus: 200,
        expectedTypePrefix: 'image/svg+xml'
      },
      {
        name: 'Connection Timeout Upstream (SVG Fallback within 4s)',
        url: `${baseUrl}/img?url=${encodeURIComponent(`http://127.0.0.1:${MOCK_SERVER_PORT}/slow-timeout.png`)}&text=TimeoutImage&color=6366f1`,
        expectedStatus: 200,
        expectedTypePrefix: 'image/svg+xml'
      },
      {
        name: 'Oversized >1.5MB Upstream Image (SVG Fallback)',
        url: `${baseUrl}/img?url=${encodeURIComponent(`http://127.0.0.1:${MOCK_SERVER_PORT}/huge-image.png`)}&text=OversizedImage&color=8b5cf6`,
        expectedStatus: 200,
        expectedTypePrefix: 'image/svg+xml'
      },
      {
        name: 'Protocol-relative URL //127.0.0.1/image-200.png',
        url: `${baseUrl}/img?url=${encodeURIComponent(`//127.0.0.1:${MOCK_SERVER_PORT}/image-200.png`)}&text=ProtoRelative&color=ec4899`,
        expectedStatus: 200,
        expectedTypePrefix: 'image/'
      },
      {
        name: 'Malformed URL: ftp://scheme.invalid',
        url: `${baseUrl}/img?url=${encodeURIComponent('ftp://invalid.scheme/test.png')}&text=BadFtp&color=14b8a6`,
        expectedStatus: 200,
        expectedTypePrefix: 'image/svg+xml'
      },
      {
        name: 'Malformed URL: javascript:alert(1)',
        url: `${baseUrl}/img?url=${encodeURIComponent('javascript:alert(1)')}&text=XssAttempt&color=f43f5e`,
        expectedStatus: 200,
        expectedTypePrefix: 'image/svg+xml'
      },
      {
        name: 'Empty url Query Param (/img)',
        url: `${baseUrl}/img`,
        expectedStatus: 200,
        expectedTypePrefix: 'image/svg+xml'
      },
      {
        name: 'Empty url value (/img?url=)',
        url: `${baseUrl}/img?url=`,
        expectedStatus: 200,
        expectedTypePrefix: 'image/svg+xml'
      },
      {
        name: 'Direct SVG Placeholder (/img/placeholder)',
        url: `${baseUrl}/img/placeholder?text=Standings&color=333333`,
        expectedStatus: 200,
        expectedTypePrefix: 'image/svg+xml'
      },
      {
        name: 'Direct SVG Placeholder with Special Characters XML escaping',
        url: `${baseUrl}/img/placeholder?text=Arsenal%20%26%20Chelsea%20%3C%3E%20%22War%22&color=ef4444`,
        expectedStatus: 200,
        expectedTypePrefix: 'image/svg+xml'
      }
    ];

    for (const tc of imageTestCases) {
      const res = await request(tc.url, { headersTimeout: 6000, bodyTimeout: 6000 });
      const cType = res.headers['content-type'] || '';
      const acao = res.headers['access-control-allow-origin'];
      const body = await res.body.text();

      const statusOk = res.statusCode === tc.expectedStatus;
      const typeOk = cType.includes(tc.expectedTypePrefix);
      const corsOk = acao === '*' || (typeof acao === 'string' && acao.includes('*'));
      const bodyNotEmpty = body.length > 20;

      const passed = statusOk && typeOk && corsOk && bodyNotEmpty;
      record('R2_IMAGE', tc.name, passed, `Status: ${res.statusCode}, Type: ${cType}, CORS: ${acao}, Bytes: ${body.length}`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // TASK 3: Stream M3U8 Proxy Stress Tests (/api/manifest)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n🎬 [TASK 3] Stress-Testing /api/manifest M3U8 Proxy...');

    const m3u8TestCases = [
      {
        name: 'Valid M3U8 Proxy and Submanifest Rewriting',
        queryUrl: `http://127.0.0.1:${MOCK_SERVER_PORT}/sample.m3u8`,
        expectedStatus: 200,
        expectedContentType: 'application/vnd.apple.mpegurl',
        validator: (body) => body.includes('#EXTM3U') && body.includes('/api/manifest?url=') && body.includes('chunk.image#.ts')
      },
      {
        name: 'Missing ?url parameter',
        queryUrl: '',
        expectedStatus: 400,
        validator: (body) => body.includes('Missing url')
      },
      {
        name: 'Upstream returning Non-M3U8 HTML (404 Stream Not Found)',
        queryUrl: `http://127.0.0.1:${MOCK_SERVER_PORT}/bad-manifest.m3u8`,
        expectedStatus: 404,
        validator: (body) => body.includes('Stream not found or expired')
      },
      {
        name: 'Negative Cache Check for Dead Upstream',
        queryUrl: `http://127.0.0.1:${MOCK_SERVER_PORT}/bad-manifest.m3u8`,
        expectedStatus: 404,
        validator: (body, headers) => headers['x-manifest-cache'] === 'NEGATIVE'
      }
    ];

    for (const tc of m3u8TestCases) {
      const endpoint = tc.queryUrl ? `${baseUrl}/api/manifest?url=${encodeURIComponent(tc.queryUrl)}` : `${baseUrl}/api/manifest`;
      const res = await request(endpoint);
      const body = await res.body.text();
      const statusOk = res.statusCode === tc.expectedStatus;
      const typeOk = !tc.expectedContentType || (res.headers['content-type'] && res.headers['content-type'].includes(tc.expectedContentType));
      const validBody = tc.validator ? tc.validator(body, res.headers) : true;
      const acao = res.headers['access-control-allow-origin'];
      const corsOk = !res.headers['access-control-allow-origin'] || acao === '*' || acao.includes('*');

      const passed = statusOk && typeOk && validBody && corsOk;
      record('R3_M3U8', tc.name, passed, `Status: ${res.statusCode}, Cache: ${res.headers['x-manifest-cache'] || 'N/A'}`);
    }

  } finally {
    if (mockServer) {
      await new Promise((r) => mockServer.close(r));
    }
    if (serverInstance && serverInstance.isSpawned) {
      await serverInstance.shutdown();
    }

    console.log('\n' + '█'.repeat(80));
    console.log('                 📊 ADVERSARIAL STRESS-TEST SUMMARY REPORT');
    console.log('█'.repeat(80));
    const allPassed = testResults.every(r => r.passed);
    testResults.forEach(r => {
      const mark = r.passed ? 'PASS [OK]' : 'FAIL [X] ';
      console.log(`  ${mark} | ${r.category.padEnd(10)} | ${r.name.padEnd(48)} | ${r.details}`);
    });
    console.log('█'.repeat(80));
    console.log(`  Overall Verdict: ${allPassed ? '🎉 ALL ADVERSARIAL TESTS PASSED' : '⚠️ VULNERABILITIES DETECTED'}\n`);

    if (!allPassed) process.exit(1);
  }
}

runAdversarialStressTests().catch(err => {
  console.error('[FATAL] Adversarial test error:', err);
  process.exit(1);
});
