/**
 * Child-process launcher for the vendored StreamCorner data worker.
 * The worker script is served by streamcorner.st and is only lightly minified;
 * it runs on plain Node globals (fetch, crypto.getRandomValues, TextEncoder)
 * plus a `self` alias. It is executed out-of-process so a hostile update to
 * the worker cannot touch the addon process.
 *
 * argv: [providerId, JSON array of endpoint URLs to try in order]
 * stdout: JSON of the decoded response; exit 1 when every URL fails.
 */
const fs = require('fs');
const path = require('path');

const shimSelf = { addEventListener() {}, postMessage() {} };
globalThis.self = shimSelf;

const workerSource = fs.readFileSync(path.join(__dirname, 'streamcorner_worker.js'), 'utf8');
new Function(workerSource)();

const api = shimSelf.__scapi;
if (!api || typeof api.makeRequest !== 'function') {
  console.error('[streamcorner-worker] API not exposed - vendored file is out of date');
  process.exit(1);
}

(async () => {
  const providerId = process.argv[2] || 'channels';
  let urls = [];
  try { urls = JSON.parse(process.argv[3] || '[]'); } catch (_) {}

  for (const url of urls) {
    try {
      const data = await api.makeRequest(url, providerId, providerId);
      process.stdout.write('SCDATA:' + JSON.stringify(data) + ':SCEND');
      process.exit(0);
    } catch (e) {
      console.error(`[streamcorner-worker] ${url} failed: ${e.message}`);
    }
  }
  process.exit(1);
})();
