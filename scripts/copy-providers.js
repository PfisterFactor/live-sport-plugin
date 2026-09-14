/**
 * Copies the provider child-runner scripts and WASM blobs into dist/.
 * ncc bundles the server, but the runners are spawned by path at runtime.
 */
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'src', 'providers');
const dist = path.join(__dirname, '..', 'dist');

fs.mkdirSync(dist, { recursive: true });
for (const name of fs.readdirSync(src)) {
  if (/\.(js|wasm)$/.test(name)) fs.copyFileSync(path.join(src, name), path.join(dist, name));
}
