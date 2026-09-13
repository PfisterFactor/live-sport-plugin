/**
 * tests/load/server-runner.js
 *
 * Programmatic server lifecycle management for Nuvio Live Sports Plugin:
 * - Checks if server is already running & healthy on specified port
 * - Spawns server process on isolated test port (default 7010)
 * - Polls /health until readiness (200 OK)
 * - Provides graceful cross-platform teardown (handling child processes)
 * - Provides mock upstream HTTP server for deterministic HLS manifest & image tests
 */

const http = require('http');
const child_process = require('child_process');
const path = require('path');
const { request } = require('undici');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const DEFAULT_TEST_PORT = 7010;
const DEFAULT_HOST = '127.0.0.1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Checks if a server at the specified baseUrl is healthy.
 */
async function isServerHealthy(baseUrl, timeoutMs = 1500) {
  try {
    const url = `${baseUrl.replace(/\/$/, '')}/health`;
    const res = await request(url, {
      method: 'GET',
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs
    });
    if (res.statusCode === 200) {
      const data = await res.body.json();
      return data && data.status === 'ok';
    }
    return false;
  } catch (_) {
    return false;
  }
}

/**
 * Cross-platform process tree termination.
 */
async function killProcessTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      child_process.execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
    } catch (_) {}
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (_) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (_) {}
    }
  }
}

/**
 * Cross-platform port listener termination.
 */
async function killProcessOnPort(port) {
  if (!port) return;
  if (process.platform === 'win32') {
    try {
      const stdout = child_process.execSync('netstat -ano -p tcp', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const lines = stdout.split('\n');
      const pids = new Set();
      for (const line of lines) {
        if (line.includes(`:${port}`) && line.includes('LISTENING')) {
          const parts = line.trim().split(/\s+/);
          const pid = parseInt(parts[parts.length - 1], 10);
          if (pid && pid > 0 && pid !== process.pid) {
            pids.add(pid);
          }
        }
      }
      for (const pid of pids) {
        try {
          child_process.execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
        } catch (_) {}
      }
    } catch (_) {}
  } else {
    try {
      child_process.execSync(`lsof -ti :${port} | xargs kill -9`, { stdio: 'ignore' });
    } catch (_) {}
  }
}

/**
 * Starts the Nuvio Live Sports Express server or connects to an existing one.
 */
async function startServer(options = {}) {
  const port = options.port || parseInt(process.env.TEST_PORT, 10) || DEFAULT_TEST_PORT;
  const host = options.host || DEFAULT_HOST;
  const baseUrl = `http://${host}:${port}`;
  const timeoutMs = options.timeoutMs || 25000;
  const reuseExisting = options.reuseExisting !== false;

  // 1. Check if already running on target port
  if (reuseExisting) {
    const alreadyHealthy = await isServerHealthy(baseUrl, 1000);
    if (alreadyHealthy) {
      console.log(`[ServerRunner] Connected to already running healthy server at ${baseUrl}`);
      return {
        isSpawned: false,
        port,
        baseUrl,
        process: null,
        shutdown: async () => {
          console.log(`[ServerRunner] Reused server at ${baseUrl} left intact.`);
        }
      };
    }
  }

  // Ensure ports are free before spawning fresh instance
  await killProcessOnPort(port);
  await sleep(300);

  // 2. Spawn fresh instance with isolated environment
  console.log(`[ServerRunner] Spawning server instance on port ${port}...`);
  const spawnEnv = {
    ...process.env,
    PORT: String(port),
    HOST: host,
    IP: host,
    NODE_ENV: 'test'
  };

  const serverProc = child_process.spawn(process.execPath, [path.join(ROOT_DIR, 'src', 'index.js')], {
    cwd: ROOT_DIR,
    env: spawnEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let serverOutput = '';
  serverProc.stdout.on('data', (d) => {
    serverOutput += d.toString();
  });
  serverProc.stderr.on('data', (d) => {
    serverOutput += d.toString();
  });

  serverProc.on('error', (err) => {
    console.error('[ServerRunner] Failed to spawn server process:', err);
  });

  // 3. Poll /health until ready
  const startTime = Date.now();
  let isReady = false;

  while (Date.now() - startTime < timeoutMs) {
    if (serverProc.exitCode !== null) {
      throw new Error(`Server process exited prematurely with code ${serverProc.exitCode}.\nOutput:\n${serverOutput}`);
    }
    const healthy = await isServerHealthy(baseUrl, 600);
    if (healthy) {
      isReady = true;
      break;
    }
    await sleep(200);
  }

  if (!isReady) {
    await killProcessTree(serverProc.pid);
    await killProcessOnPort(port);
    throw new Error(`Server failed to become healthy at ${baseUrl} within ${timeoutMs}ms.\nOutput:\n${serverOutput}`);
  }

  const bootDuration = Date.now() - startTime;
  console.log(`[ServerRunner] Server is ready at ${baseUrl} (booted in ${bootDuration}ms)`);

  const shutdown = async () => {
    console.log(`[ServerRunner] Shutting down spawned server (PID: ${serverProc.pid})...`);
    if (serverProc && !serverProc.killed) {
      await killProcessTree(serverProc.pid);
    }
    await killProcessOnPort(port);
    await sleep(300);
  };

  return {
    isSpawned: true,
    port,
    baseUrl,
    process: serverProc,
    shutdown
  };
}

/**
 * Creates and starts a lightweight mock upstream HTTP server for deterministic tests.
 */
function startMockUpstream() {
  return new Promise((resolve, reject) => {
    const upstreamRequests = [];

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      upstreamRequests.push({
        method: req.method,
        path: url.pathname,
        search: url.search,
        headers: req.headers,
        timestamp: Date.now()
      });

      if (url.pathname === '/valid.m3u8') {
        res.writeHead(200, {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(
          '#EXTM3U\n' +
          '#EXT-X-VERSION:3\n' +
          '#EXT-X-TARGETDURATION:10\n' +
          '#EXTINF:10.0,\n' +
          'chunk1.ts\n' +
          '#EXTINF:10.0,\n' +
          'chunk2.ts\n'
        );
        return;
      }

      if (url.pathname === '/variant.m3u8') {
        res.writeHead(200, {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(
          '#EXTM3U\n' +
          '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1920x1080\n' +
          'sub_1080p.m3u8\n' +
          '#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=1280x720\n' +
          'sub_720p.m3u8\n'
        );
        return;
      }

      if (url.pathname === '/dead.m3u8') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Stream Not Found');
        return;
      }

      if (url.pathname === '/invalid-html.m3u8') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body>Error: Stream Offline</body></html>');
        return;
      }

      if (url.pathname === '/image.png') {
        // 1x1 transparent PNG buffer
        const png1x1 = Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          'base64'
        );
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': png1x1.length
        });
        res.end(png1x1);
        return;
      }

      if (url.pathname === '/dead-image.png') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Image Not Found');
        return;
      }

      // Default fallback
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Mock Upstream OK');
    });

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const baseUrl = `http://127.0.0.1:${port}`;
      resolve({
        port,
        baseUrl,
        server,
        requests: upstreamRequests,
        clearRequests: () => {
          upstreamRequests.length = 0;
        },
        close: () =>
          new Promise((done) => {
            server.close(done);
          })
      });
    });

    server.on('error', reject);
  });
}

module.exports = {
  startServer,
  isServerHealthy,
  killProcessTree,
  killProcessOnPort,
  startMockUpstream,
  DEFAULT_TEST_PORT,
  DEFAULT_HOST
};
